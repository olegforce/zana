import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { product } from '../product-client.js';
import { readHttpLibrary, subscribeHttpLibrary } from '../http-library.js';

const events = vi.hoisted(() => ({ callback: (_payload: unknown) => {}, unsubscribe: vi.fn() }));
vi.mock('../product-ws.js', () => ({ subscribeProductEvent: vi.fn((type, callback) => {
  expect(type).toBe('library:changed');
  events.callback = callback;
  return events.unsubscribe;
}) }));
const docs = [{ id: 'global:note.md', title: 'Updated note', relPath: 'note.md', scope: 'global' }];
beforeEach(() => events.unsubscribe.mockClear());
afterEach(() => vi.unstubAllGlobals());

describe('HTTP library notifications', () => {
  it('fetches documents instead of passing an invalidation object into the store', async () => {
    const fetch = vi.fn(async () => Response.json({ docs }));
    vi.stubGlobal('fetch', fetch);
    const changed = vi.fn();
    const unsubscribe = product.library.onChanged(changed);
    events.callback({ projectId: 'project' });
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(docs));
    expect(fetch).toHaveBeenCalledWith('/api/v1/library', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    unsubscribe();
    expect(events.unsubscribe).toHaveBeenCalledOnce();
  });

  it('coalesces bursts but refreshes again if another change arrives during the read', async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; }))
      .mockResolvedValue(Response.json({ docs }));
    vi.stubGlobal('fetch', fetch);
    const changed = vi.fn();
    const unsubscribe = subscribeHttpLibrary(changed);
    events.callback({ projectId: 'one' });
    events.callback({ projectId: 'two' });
    events.callback({ projectId: 'three' });
    expect(fetch).toHaveBeenCalledTimes(1);
    resolve(Response.json({ docs: [] }));
    await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(docs));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenNthCalledWith(1, []);
    unsubscribe();
  });

  it('preserves the list after failures and retries on a later notification', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(Response.json({ docs: { projectId: 'wrong' } }))
      .mockResolvedValueOnce(Response.json({ docs })));
    const changed = vi.fn();
    const unsubscribe = subscribeHttpLibrary(changed);
    events.callback({});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(changed).not.toHaveBeenCalled();
    events.callback({});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(changed).not.toHaveBeenCalled();
    events.callback({});
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(docs));
    unsubscribe();
  });

  it('aborts on unsubscribe and never delivers an in-flight result or queued refresh', async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(r => { resolve = r; }));
    vi.stubGlobal('fetch', fetch);
    const changed = vi.fn();
    const unsubscribe = subscribeHttpLibrary(changed);
    events.callback({});
    events.callback({});
    unsubscribe();
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].signal!.aborted).toBe(true);
    resolve(Response.json({ docs }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(changed).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects an invalid initial list and supports an empty library', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ docs: null }))
      .mockResolvedValueOnce(Response.json({ docs: [] })));
    await expect(readHttpLibrary()).rejects.toThrow('Invalid library response');
    await expect(product.library.list()).resolves.toEqual([]);
  });
});
