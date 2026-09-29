import { expect, it, vi } from 'vitest';
import { CLI_CALLBACK_MAX_RESPONSE_BYTES } from '@zana-ai/zcc-contracts/cli-callbacks';
import { createCliCallbackForwarder } from './cli-callback-client.js';
const grant = { projectId: 'project', sessionId: '11111111-1111-4111-8111-111111111111', credential: 'a'.repeat(64) };
const request = { path: `/mcp/project/${grant.sessionId}/${grant.credential}`, headers: { accept: 'application/json' }, body: Buffer.from('{}'), signal: new AbortController().signal };
function fixture() {
  const fetchFn = vi.fn(async () => new Response(JSON.stringify({ status: 200, contentType: 'application/json', bodyBase64: Buffer.from('answer').toString('base64') })));
  return { fetchFn, forward: createCliCallbackForwarder({ grant, serverUrl: 'https://example.invalid/t/session', hostId: 'host', hostKey: 'private-host-key', fetchFn: fetchFn as typeof fetch }) };
}
it('preserves the Connect prefix and adds enrollment credentials only to the fixed host route', async () => {
  const f = fixture(); expect(await f.forward(request)).toEqual({ status: 200, contentType: 'application/json', body: Buffer.from('answer') });
  expect(f.fetchFn).toHaveBeenCalledExactlyOnceWith('https://example.invalid/t/session/internal/hosts/cli-callback', {
    method: 'POST', redirect: 'error', signal: request.signal,
    headers: { 'content-type': 'application/json', authorization: 'Bearer private-host-key', 'x-zcc-host-id': 'host' },
    body: JSON.stringify({ sessionId: grant.sessionId, path: request.path, headers: request.headers, bodyBase64: request.body.toString('base64') })
  });
});
it('rejects ungranted routes, unsafe headers and cancelled calls before dispatch', async () => {
  const f = fixture();
  await expect(f.forward({ ...request, path: '/api/v1/projects' })).rejects.toThrow('not granted');
  await expect(f.forward({ ...request, headers: { cookie: 'private' } })).rejects.toThrow();
  const controller = new AbortController(); controller.abort();
  await expect(f.forward({ ...request, signal: controller.signal })).rejects.toThrow(); expect(f.fetchFn).not.toHaveBeenCalled();
});
it.each([401, 403, 429, 500])('does not retry a rejected callback (%d)', async status => {
  const f = fixture(); f.fetchFn.mockResolvedValueOnce(new Response(null, { status }));
  await expect(f.forward(request)).rejects.toThrow(`(${status})`); expect(f.fetchFn).toHaveBeenCalledOnce();
});
it.each(['invalid', String(4 * Math.ceil(CLI_CALLBACK_MAX_RESPONSE_BYTES / 3) + 4097)])('rejects invalid or oversized advertised responses', async length => {
  const f = fixture(); f.fetchFn.mockResolvedValueOnce(new Response('x', { headers: { 'content-length': length } }));
  await expect(f.forward(request)).rejects.toThrow('limit');
});
it('bounds streamed responses and rejects malformed or noncanonical bytes', async () => {
  const f = fixture(); f.fetchFn.mockResolvedValueOnce(new Response('x'.repeat(4 * Math.ceil(CLI_CALLBACK_MAX_RESPONSE_BYTES / 3) + 4097)));
  await expect(f.forward(request)).rejects.toThrow('limit');
  for (const bodyBase64 of ['Zh==', Buffer.alloc(CLI_CALLBACK_MAX_RESPONSE_BYTES + 1).toString('base64')]) {
    f.fetchFn.mockResolvedValueOnce(new Response(JSON.stringify({ status: 200, bodyBase64 }))); await expect(f.forward(request)).rejects.toThrow();
  }
  f.fetchFn.mockResolvedValueOnce(new Response(null)); await expect(f.forward(request)).rejects.toThrow();
  f.fetchFn.mockResolvedValueOnce(new Response(JSON.stringify({ status: 204, bodyBase64: '' })));
  expect(await f.forward(request)).toEqual({ status: 204, body: Buffer.alloc(0) });
});
it('keeps a valid result when releasing an already closed response stream fails', async () => {
  const cancel = vi.spyOn(ReadableStreamDefaultReader.prototype, 'cancel').mockRejectedValueOnce(new Error('already closed'));
  try { expect((await fixture().forward(request)).body.toString()).toBe('answer'); }
  finally { cancel.mockRestore(); }
});
