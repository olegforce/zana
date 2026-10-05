// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { product } from '../product-client.js';

afterEach(() => vi.unstubAllGlobals());

it('forwards typed terminal exit reasons and releases its subscription', async () => {
  const socket = { addEventListener: vi.fn(), close: vi.fn(), readyState: 1, send: vi.fn() };
  vi.stubGlobal('WebSocket', Object.assign(function () { return socket; }, { OPEN: 1 }));
  const received = vi.fn(), stop = product.terminals.onExit(received);
  const message = socket.addEventListener.mock.calls.find(([type]) => type === 'message')![1];
  message({ data: JSON.stringify({ type: 'terminals:exit', payload: { sessionId: 'one', code: 9, reason: 'overflow' } }) });
  expect(received).toHaveBeenCalledExactlyOnceWith('one', 9, 'overflow'); stop();
});

it('hydrates each project with only its own terminals so mobile lists and portals do not duplicate sessions', async () => {
  const first = { id: 'one', projectId: 'project-a', title: 'First agent' };
  const second = { id: 'two', projectId: 'project-b', title: 'Second agent' };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sessions: [first, second] })));
  await expect(product.terminals.list('project-a')).resolves.toEqual([first]);
  await expect(product.terminals.list('project-b')).resolves.toEqual([second]);
  await expect(product.terminals.list('empty-project')).resolves.toEqual([]);
});

it('preserves terminal hydration failures rather than claiming an empty project', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'Host unavailable' }, { status: 503 })));
  await expect(product.terminals.list('project-a')).rejects.toThrow();
});

it('shares one pending roster read across projects and allows a fresh read afterwards', async () => {
  let respond!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(resolve => { respond = resolve; }));
  vi.stubGlobal('fetch', fetch);
  const reads = [product.terminals.list('a'), product.terminals.list('b')];
  expect(fetch).toHaveBeenCalledOnce();
  respond(Response.json({ sessions: [{ id: 'one', projectId: 'a' }, { id: 'two', projectId: 'b' }] }));
  await expect(Promise.all(reads)).resolves.toEqual([[{ id: 'one', projectId: 'a' }], [{ id: 'two', projectId: 'b' }]]);
  const next = product.terminals.list('a');
  expect(fetch).toHaveBeenCalledTimes(2);
  respond(Response.json({ sessions: [] }));
  await expect(next).resolves.toEqual([]);
});

it('forwards cancellation to hosted snapshot requests', async () => {
  const controller = new AbortController();
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    expect(init?.signal).toBe(controller.signal);
    return Response.json({ text: 'tail', startOffset: 0, endOffset: 4 });
  });
  vi.stubGlobal('fetch', fetch);
  await expect(product.terminals.backlogSnapshot!('one', controller.signal)).resolves.toMatchObject({ text: 'tail' });
  expect(fetch).toHaveBeenCalledOnce();
});
