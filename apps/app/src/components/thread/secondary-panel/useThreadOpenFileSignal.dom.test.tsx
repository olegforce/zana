/** @vitest-environment happy-dom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { dispatchThreadOpenFile, installThreadOpenFileSignals, resetThreadOpenFileBuffer, useThreadOpenFileSignal } from './useThreadOpenFileSignal.js';

const { listeners } = vi.hoisted(() => ({ listeners: new Set<(payload: unknown) => void>() }));
vi.mock('../../../lib/product-client.js', () => ({ product: { threads: {
  onOpen: (listener: (payload: unknown) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
} } }));

let stopCollector: () => void;
beforeEach(() => { stopCollector = installThreadOpenFileSignals(); });
afterEach(() => { cleanup(); stopCollector(); resetThreadOpenFileBuffer(); expect(listeners.size).toBe(0); });
function emit(threadId: string, path: string) {
  for (const listener of listeners) listener({
    type: 'thread-open', projectId: 'p1', threadId, split: 'right',
    file: { source: 'workspace', path, lineNumber: null }
  });
}

it('does not replay a previous preview when two thread views are mounted', () => {
  const openA = vi.fn();
  const openB = vi.fn();
  renderHook(() => useThreadOpenFileSignal({ threadId: 'a', environmentId: 'env-a', openTab: openA }));
  renderHook(() => useThreadOpenFileSignal({ threadId: 'b', environmentId: 'env-b', openTab: openB }));
  act(() => emit('a', 'first.md'));
  act(() => emit('a', 'second.md'));
  expect(openA.mock.calls.map(([tab]) => tab.path)).toEqual(['first.md', 'second.md']);
  expect(openB).not.toHaveBeenCalled();
});

it('drains all previews that arrived while a different thread was visible', () => {
  const open = vi.fn();
  const view = renderHook(({ id }) => useThreadOpenFileSignal({ threadId: id, environmentId: 'env', openTab: open }), {
    initialProps: { id: 'a' }
  });
  act(() => emit('b', 'first.md'));
  act(() => emit('b', 'second.md'));
  view.rerender({ id: 'b' });
  expect(open.mock.calls.map(([tab]) => tab.path)).toEqual(['first.md', 'second.md']);
});

it('retains a preview requested while no agent view was mounted', () => {
  const open = vi.fn();
  act(() => emit('a', 'report.md'));
  renderHook(() => useThreadOpenFileSignal({ threadId: 'a', environmentId: 'env-a', openTab: open }));
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ path: 'report.md' }));
});

it('subscribes once and releases the product listener after its final owner', () => {
  const release = installThreadOpenFileSignals();
  expect(listeners.size).toBe(1);
  stopCollector();
  stopCollector();
  expect(listeners.size).toBe(1);
  release();
  expect(listeners.size).toBe(0);
});

it('delivers to every mounted view of the same thread once and uses current callbacks', () => {
  const openA = vi.fn();
  const openB = vi.fn();
  const updated = vi.fn();
  const first = renderHook(({ openTab }) => useThreadOpenFileSignal({ threadId: 'a', environmentId: null, openTab }), {
    initialProps: { openTab: openA }
  });
  renderHook(() => useThreadOpenFileSignal({ threadId: 'a', environmentId: null, openTab: openB }));
  first.rerender({ openTab: updated });
  act(() => dispatchThreadOpenFile('a', 'local.md', 5));
  expect(openA).not.toHaveBeenCalled();
  expect(updated).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path: 'local.md', lineNumber: 5 }));
  expect(openB).toHaveBeenCalledTimes(1);
  first.unmount();
  act(() => emit('a', 'next.md'));
  expect(updated).toHaveBeenCalledTimes(1);
  expect(openB).toHaveBeenCalledTimes(2);
});

it('buffers until a thread becomes ready and ignores malformed signals', () => {
  const open = vi.fn();
  const view = renderHook(({ environmentId }) => useThreadOpenFileSignal({ threadId: 'a', environmentId, openTab: open }), {
    initialProps: { environmentId: undefined as string | undefined }
  });
  act(() => {
    for (const listener of listeners) listener({ threadId: 'a', file: null });
    emit('a', 'ready.md');
  });
  expect(open).not.toHaveBeenCalled();
  view.rerender({ environmentId: 'env' });
  expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path: 'ready.md' }));
});
