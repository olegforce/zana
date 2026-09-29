import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { product } from '../product-client.js';
import { readHttpLibrary, subscribeHttpLibrary, readHttpLibrarySnapshot } from '../http-library.js';

const events = vi.hoisted(() => ({ callback: (_payload: unknown) => {}, hosts: () => {}, projects: () => {}, unsubscribe: vi.fn(), reconnect: () => {}, stopReconnect: vi.fn() }));
vi.mock('../product-ws.js', () => ({ subscribeProductReconnect: vi.fn(callback => { events.reconnect = callback; return events.stopReconnect; }), subscribeProductEvent: vi.fn((type, callback) => {
  expect(['library:changed', 'hosts:changed', 'projects:changed']).toContain(type);
  if (type === 'library:changed') events.callback = callback;
  else if (type === 'hosts:changed') events.hosts = callback;
  else events.projects = callback;
  return events.unsubscribe;
}) }));
const docs = [{ id: 'global:note.md', title: 'Updated note', relPath: 'note.md', scope: 'global' }];
beforeEach(() => events.unsubscribe.mockClear());
afterEach(() => vi.unstubAllGlobals());

describe('HTTP library notifications', () => {
  it('refreshes partial snapshots on host changes and reconnect, and rejects malformed responses', async () => {
    const snapshot = { docs, roots: [{ scope: 'project', projectId: 'b', state: 'offline' }], complete: false };
    const fetch = vi.fn().mockImplementation(async () => Response.json({ value: snapshot })); vi.stubGlobal('fetch', fetch);
    expect(await product.library.snapshot()).toEqual(snapshot);
    const changed = vi.fn(), off = product.library.onSnapshotChanged(changed);
    events.hosts(); await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(snapshot));
    fetch.mockResolvedValue(Response.json({ value: { ...snapshot, roots: [], complete: true } }));
    events.reconnect(); await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith({ ...snapshot, roots: [], complete: true }));
    changed.mockClear(); fetch.mockImplementation(async () => Response.json({ value: snapshot }));
    events.projects(); await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(snapshot));
    off(); expect(events.unsubscribe).toHaveBeenCalledTimes(3);
    for (const value of [null, { docs: {} }, { docs: [], roots: {} }, { docs: [], roots: [], complete: null }]) {
      fetch.mockResolvedValueOnce(Response.json({ value })); await expect(readHttpLibrarySnapshot()).rejects.toThrow('Invalid library snapshot');
    }
  });
  it('routes file mutations through the shared runtime and returns displayable failures', async () => {
    const fetch = vi.fn().mockImplementation(async () => Response.json({ value: { ok: true, path: '/owner/library/new' } }));
    vi.stubGlobal('fetch', fetch);
    const from = { scope: 'project' as const, projectId: 'p', relPath: 'old' }, to = { ...from, relPath: 'new' };
    expect(await product.library.move(from, to)).toMatchObject({ ok: true });
    expect(fetch).toHaveBeenLastCalledWith('/api/v1/library/documents', expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'move', from, to }) }));
    expect(await product.library.deleteEntry('project', 'new', 'p')).toMatchObject({ ok: true });
    expect(await product.library.createFolder('project', 'empty', 'p')).toMatchObject({ ok: true });
    expect(await product.library.write('project', 'note.md', 'new', 'p', 'a'.repeat(64))).toMatchObject({ ok: true });
    const count = fetch.mock.calls.length;
    expect(await product.library.write('project', 'note.md', 'blind', 'p')).toMatchObject({ ok: false }); expect(fetch).toHaveBeenCalledTimes(count);
    fetch.mockResolvedValueOnce(Response.json({ value: null })); expect(await product.library.move(from, to)).toMatchObject({ ok: false, message: 'Invalid library mutation response' });
    fetch.mockRejectedValueOnce(new Error('Machine offline')); expect(await product.library.deleteEntry('project', 'new', 'p')).toEqual({ ok: false, message: 'Machine offline' });
    fetch.mockRejectedValueOnce('Unexpected failure'); expect(await product.library.createFolder('project', 'empty', 'p')).toEqual({ ok: false, message: 'Unexpected failure' });
  });
  it('fetches documents instead of passing an invalidation object into the store', async () => {
    const fetch = vi.fn(async () => Response.json({ docs }));
    vi.stubGlobal('fetch', fetch);
    const changed = vi.fn();
    const unsubscribe = product.library.onChanged(changed);
    events.callback({ projectId: 'project' });
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(docs));
    expect(fetch).toHaveBeenCalledWith('/api/v1/library', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    unsubscribe();
    expect(events.unsubscribe).toHaveBeenCalledTimes(2);
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
