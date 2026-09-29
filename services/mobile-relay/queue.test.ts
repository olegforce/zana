import { afterEach, expect, it } from 'vitest';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createRelay } from './server.mjs';
import { LIMITS } from './protocol.mjs';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(queueTimeoutMs = 2000) {
  const relay = createRelay({ token: 'x'.repeat(43), publicUrl: 'https://relay.test', queueTimeoutMs });
  let received = 0;
  const server = createServer((req, res) => { received++; relay.handleHttp(req, res); });
  server.on('upgrade', relay.handleUpgrade);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  cleanup.push(async () => { relay.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/_relay/connect`, { headers: { host: 'relay.test', 'x-forwarded-proto': 'https', authorization: `Bearer ${'x'.repeat(43)}` } });
  cleanup.push(() => ws.terminate());
  await once(ws, 'open');
  const active = new Set<number>(); const paths: string[] = [];
  let peak = 0, auto = false;
  const finish = (id: number) => {
    active.delete(id);
    ws.send(JSON.stringify({ type: 'response', id, status: 200, headers: {} }));
    ws.send(JSON.stringify({ type: 'response-end', id }));
  };
  ws.on('message', raw => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === 'request') { paths.push(frame.path); active.add(frame.id); peak = Math.max(peak, active.size); }
    if (frame.type === 'request-end' && auto) finish(frame.id);
    if (frame.type === 'cancel') active.delete(frame.id);
  });
  const call = (path = '/asset.js', method = 'GET', extra = {}) => {
    let req: ReturnType<typeof request>;
    const response = new Promise<number | string>(resolve => {
      req = request({ hostname: '127.0.0.1', port, path, method, agent: false, headers: { host: 'relay.test', 'x-forwarded-proto': 'https', ...extra } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', () => resolve('aborted')); req.end();
    });
    return { response, abort: () => req!.destroy() };
  };
  return { call, active, paths, ws, relay, received: () => received, peak: () => peak,
    release: () => { auto = true; for (const id of [...active]) finish(id); } };
}
it('queues a browser startup burst without exceeding the installed peer stream limit', async () => {
  const env = await setup();
  const requests = Array.from({ length: 160 }, (_, n) => env.call(`/assets/${n}.js`));
  await expect.poll(env.received).toBe(160);
  await expect.poll(() => env.active.size).toBe(LIMITS.streams);
  expect(env.paths).toHaveLength(LIMITS.streams);
  env.release();
  expect(await Promise.all(requests.map(item => item.response))).toEqual(Array(160).fill(200));
  expect(env.peak()).toBe(LIMITS.streams); expect(env.relay.connected()).toBe(true);
});
it('bounds queued reads and refuses queued writes or read bodies without forwarding them', async () => {
  const env = await setup(5000);
  const requests = Array.from({ length: LIMITS.streams + 256 }, () => env.call());
  await expect.poll(env.received).toBe(LIMITS.streams + 256);
  expect(await env.call('/overflow').response).toBe(503);
  expect(await env.call('/write', 'POST').response).toBe(503);
  expect(await env.call('/body', 'GET', { 'content-length': '1' }).response).toBe(503);
  expect(await env.call('/chunked', 'GET', { 'transfer-encoding': 'chunked' }).response).toBe(503);
  env.release();
  expect(await Promise.all(requests.map(item => item.response))).toEqual(Array(LIMITS.streams + 256).fill(200));
  expect(env.paths.some(path => ['/write', '/body', '/chunked', '/overflow'].includes(path))).toBe(false);
});
it('drops abandoned reads and frees a slot for the next waiting read', async () => {
  const env = await setup();
  const active = Array.from({ length: LIMITS.streams }, (_, n) => env.call(`/active/${n}`));
  await expect.poll(() => env.paths.length).toBe(LIMITS.streams);
  const cancelled = env.call('/cancelled');
  await expect.poll(env.received).toBe(LIMITS.streams + 1);
  cancelled.abort(); expect(await cancelled.response).toBe('aborted');
  const next = env.call('/next', 'HEAD');
  active[0].abort(); expect(await active[0].response).toBe('aborted');
  await expect.poll(() => env.paths.includes('/next')).toBe(true);
  expect(env.paths).not.toContain('/cancelled');
  env.release(); expect(await next.response).toBe(200);
  await Promise.all(active.map(item => item.response));
});
it('expires queued reads without forwarding them, and fails pending reads on disconnect', async () => {
  const env = await setup(50);
  const active = Array.from({ length: LIMITS.streams }, () => env.call());
  await expect.poll(() => env.paths.length).toBe(LIMITS.streams);
  expect(await env.call('/expired').response).toBe(503);
  const disconnected = env.call('/disconnect');
  await expect.poll(env.received).toBe(LIMITS.streams + 2);
  env.ws.terminate();
  expect(await disconnected.response).toBe(503);
  expect(env.paths).not.toContain('/expired'); expect(env.paths).not.toContain('/disconnect');
  await Promise.all(active.map(item => item.response));
});
