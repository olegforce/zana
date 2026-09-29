import { expect, it } from 'vitest';
import { dispatchPluginRequest } from './plugin-dispatch.mjs';
it('uses a fixed plugin endpoint with a bounded JSON body and no phone credentials', async () => {
  const relay = { async handleHttp(req: any, res: any) {
    expect(req.url).toBe('/api/v1/plugins/test-plugin/http/connect'); expect(req.headers.authorization).toBeUndefined();
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({ signed: 'body' });
    res.writeHead(200); res.end(JSON.stringify({ accepted: true }));
  } };
  expect(await dispatchPluginRequest(relay, 'https://example.com', 'test-plugin', { signed: 'body' })).toEqual({ status: 200, body: { accepted: true } });
  expect(() => dispatchPluginRequest(relay, 'https://example.com', '../internal', {})).toThrow();
  expect(() => dispatchPluginRequest(relay, 'https://example.com', 'valid', { text: 'x'.repeat(300_000) })).toThrow();
});
it('treats timeout, interrupted and malformed responses as uncertain without retrying', async () => {
  for (const handleHttp of [(_q: any, r: any) => r.end('not json'), (_q: any, r: any) => r.end('x'.repeat(300_000)), () => { throw new Error('lost'); }, (_q: any, r: any) => r.destroy(new Error('lost')), (q: any) => q.destroy(new Error('lost')), () => {}]) await expect(dispatchPluginRequest({ handleHttp }, 'https://example.com', 'test-plugin', {}, 100)).rejects.toThrow();
});
