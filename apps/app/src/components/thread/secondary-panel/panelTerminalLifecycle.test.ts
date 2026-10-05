import { expect, it, vi } from 'vitest';
import { closePanelTab, waitForPanelTerminalExit } from './panelTerminalLifecycle.js';
const tab = { id: 't', kind: 'terminal' as const, title: 'Terminal', sessionId: 's' };
const deps = () => ({ close: vi.fn().mockResolvedValue(true), released: vi.fn(), remove: vi.fn() });
it('confirms stop before releasing the terminal and removing the view', async () => {
  const d = deps(); let resolve!: (value: boolean) => void;
  d.close.mockImplementation(() => new Promise(r => { resolve = r; }));
  const task = closePanelTab(tab, [tab], d);
  expect(d.remove).not.toHaveBeenCalled(); resolve(true); await task;
  expect(d.released).toHaveBeenCalledExactlyOnceWith('s'); expect(d.remove).toHaveBeenCalledExactlyOnceWith('t');
});
it('keeps the tab until an accepted stop has actually exited and retains it on deadline', async () => {
  const d = { ...deps(), waitForExit: vi.fn().mockResolvedValue(false) };
  await expect(closePanelTab(tab, [tab], d)).rejects.toThrow('not stopped');
  expect(d.remove).not.toHaveBeenCalled();
  d.waitForExit.mockResolvedValue(true);
  await closePanelTab(tab, [tab], d); expect(d.remove).toHaveBeenCalledWith('t');
});
it('polls confirmed exit with a bounded deadline and propagates roster failures', async () => {
  vi.useFakeTimers();
  try {
    const list = vi.fn().mockResolvedValueOnce([{ id: 's', status: 'running' }]).mockResolvedValue([{ id: 's', status: 'exited' }]);
    const task = waitForPanelTerminalExit('s', list);
    await vi.advanceTimersByTimeAsync(100); await expect(task).resolves.toBe(true);
    await expect(waitForPanelTerminalExit('gone', async () => [])).resolves.toBe(true);
    await expect(waitForPanelTerminalExit('s', async () => [{ id: 's', status: 'running' }], 0)).resolves.toBe(false);
    const timeout = waitForPanelTerminalExit('s', async () => [{ id: 's', status: 'running' }], 100);
    await vi.advanceTimersByTimeAsync(100); await expect(timeout).resolves.toBe(false);
    await expect(waitForPanelTerminalExit('s', async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
it.each([false, new Error('offline')])('retains the view when close fails: %s', async value => {
  const d = deps();
  if (value instanceof Error) d.close.mockRejectedValue(value); else d.close.mockResolvedValue(value);
  await expect(closePanelTab(tab, [tab], d)).rejects.toThrow();
  expect(d.released).not.toHaveBeenCalled(); expect(d.remove).not.toHaveBeenCalled();
});
it('releases only the reference when another tab owns the same shell', async () => {
  const d = deps(); await closePanelTab(tab, [tab, { ...tab, id: 'other' }], d);
  expect(d.close).not.toHaveBeenCalled(); expect(d.remove).toHaveBeenCalledWith('t');
  await closePanelTab({ ...tab, openerKey: 'shared-terminal' }, [tab], d); expect(d.close).not.toHaveBeenCalled();
  await closePanelTab({ ...tab, kind: 'file-preview' }, [tab], d); expect(d.close).not.toHaveBeenCalled();
  await closePanelTab(undefined, [], d); expect(d.remove).toHaveBeenCalledTimes(3);
});
