import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readConnectHostAccess, readConnectEnrollment, connectHostFetch } from './connect-access.js';
const dirs: string[] = []; const dir = () => { const d = mkdtempSync(join(tmpdir(), 'zcc-host-access-')); dirs.push(d); return d; };
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
it('requires valid saved instance, host, credential and exact server binding', () => {
  const d = dir(), serverUrl = 'https://alice.example', file = join(d, 'connect-access.json');
  expect(readConnectHostAccess(d, serverUrl)).toBeNull();
  const access = { serverUrl, serverId: randomUUID(), instanceId: randomUUID(), hostId: randomUUID(), machineId: randomUUID(), credential: 'a'.repeat(43) };
  writeFileSync(file, JSON.stringify(access)); expect(readConnectHostAccess(d, serverUrl + '/')).toEqual(access);
  expect(() => readConnectHostAccess(d, 'https://bob.example')).toThrow('different');
  for (const value of ['null', '{}', '{', 'x'.repeat(4097)]) { writeFileSync(file, value); expect(() => readConnectHostAccess(d, serverUrl)).toThrow(); }
});
it('forwards the outer credential only to its fixed origin and refuses redirects', async () => {
  const fetcher = vi.fn(async () => new Response('ok')) as unknown as typeof fetch;
  expect(connectHostFetch('https://alice.example', undefined, fetcher)).toBe(fetcher);
  expect(() => connectHostFetch('https://alice.example', 'bad', fetcher)).toThrow();
  const call = connectHostFetch('https://alice.example', 'a'.repeat(43), fetcher);
  await call(new Request('https://alice.example/install/version', { headers: { authorization: 'Bearer inner' } }));
  const init = vi.mocked(fetcher).mock.calls[0]![1]!;
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer inner');
  expect(new Headers(init.headers).get('x-zcc-machine-credential')).toBe('a'.repeat(43)); expect(init.redirect).toBe('error');
  expect(() => call('https://bob.example/install/version')).toThrow('mismatch');
  expect(() => call('https://user@alice.example/install/version')).toThrow('mismatch');
});
it('reads pending enrollment only for its host and fails closed on malformed state', () => {
  const d = dir(), hostId = randomUUID(), file = join(d, 'connect-enroll.json');
  expect(readConnectEnrollment(d, hostId)).toBeUndefined();
  writeFileSync(file, JSON.stringify({ hostId, enrollToken: 'zcde_' + 'a'.repeat(24) }));
  expect(readConnectEnrollment(d, hostId)).toBe('zcde_' + 'a'.repeat(24));
  expect(() => readConnectEnrollment(d, randomUUID())).toThrow();
  writeFileSync(file, 'x'.repeat(1025)); expect(() => readConnectEnrollment(d, hostId)).toThrow();
});
