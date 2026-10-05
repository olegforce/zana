// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';

vi.mock('../../../lib/product-client.js', () => ({
  product: {
    terminals: { create: vi.fn(), write: vi.fn(), close: vi.fn(), onExit: vi.fn(() => vi.fn()) },
    threads: { onOpen: vi.fn(() => vi.fn()) }
  }
}));
const store = vi.hoisted(() => ({ data: { terminals: {} as Record<string, any[]>, createTerminal: vi.fn(), dismissTerminals: vi.fn() }, ui: { selectTab: vi.fn(), pushToast: vi.fn() } }));
vi.mock('../../../store.js', () => ({ useData: { getState: () => store.data }, useUi: { getState: () => store.ui } }));

import {
  openThreadPanelTerminal, openProjectStripTerminal, forgetAgentTerminal,
  AGENT_TERMINAL_CAP,
  AGENT_TERMINAL_OPENER_KEY,
  agentOwnedTerminalTabs,
  bufferThreadOpenTerminal,
  consumePendingOpenTerminal,
  parseThreadOpenTerminalPayload,
  resetThreadOpenTerminalBuffer, useThreadOpenTerminalSignal, useCliAgentTerminalSignal, THREAD_OPEN_TERMINAL_EVENT
} from './useThreadOpenTerminalSignal.js';

import { product } from '../../../lib/product-client.js';
afterEach(() => { cleanup(); resetThreadOpenTerminalBuffer(); vi.clearAllMocks(); store.data.terminals = {}; });
describe('thread-open terminal signal', () => {
  afterEach(() => {
    resetThreadOpenTerminalBuffer(); vi.clearAllMocks(); store.data.terminals = {};
  });

  it('parses a terminal intent and ignores file-only payloads', () => {
    expect(parseThreadOpenTerminalPayload(null)).toBeNull();
    expect(parseThreadOpenTerminalPayload({
      threadId: 't1',
      projectId: 'p1',
      file: { source: 'workspace', path: 'a.ts' }
    })).toEqual({ threadId: 't1', projectId: 'p1', terminal: null });
    expect(parseThreadOpenTerminalPayload({
      type: 'thread-open',
      projectId: 'p1',
      threadId: 't1',
      split: 'right',
      file: null,
      terminal: { command: 'npm run dev', title: 'Dev' }
    })).toEqual({
      threadId: 't1',
      projectId: 'p1',
      terminal: { command: 'npm run dev', title: 'Dev' }
    });
  });

  it('buffers then drains the oldest terminal for a thread', () => {
    bufferThreadOpenTerminal('t1', { command: 'ls', title: 'List' });
    bufferThreadOpenTerminal('t1', { command: null, title: null });
    expect(consumePendingOpenTerminal('missing')).toBeNull();
    expect(consumePendingOpenTerminal('t1')).toEqual({ command: 'ls', title: 'List' });
    expect(consumePendingOpenTerminal('t1')).toEqual({ command: null, title: null });
    expect(consumePendingOpenTerminal('t1')).toBeNull();
  });

  it('counts only agent-owned terminal tabs toward the cap', () => {
    expect(AGENT_TERMINAL_CAP).toBe(3);
    expect(agentOwnedTerminalTabs([
      { id: 'user', kind: 'terminal', title: 'Terminal', sessionId: 's0' },
      { id: 'a1', kind: 'terminal', title: 'Dev', sessionId: 's1', openerKey: AGENT_TERMINAL_OPENER_KEY },
      { id: 'file', kind: 'file-preview', title: 'a.ts', path: 'a.ts' }
    ])).toHaveLength(1);
  });
});

it('serializes simultaneous panel requests and reuses the third shell', async () => {
  resetThreadOpenTerminalBuffer();
  const panel: any = { state: { tabs: [] }, activateTab: vi.fn(), addTab: vi.fn() };
  vi.mocked(product.terminals.create).mockImplementation(async () => ({ ok: true, value: { id: `s${vi.mocked(product.terminals.create).mock.calls.length}` } } as any));
  await Promise.all(Array.from({ length: 6 }, () => openThreadPanelTerminal({ ownerId: 'o', projectId: 'p', panel, intent: { command: 'echo', title: null } })));
  expect(product.terminals.create).toHaveBeenCalledTimes(3); expect(panel.addTab).toHaveBeenCalledTimes(3);
  expect(product.terminals.write).toHaveBeenCalledTimes(3); expect(panel.activateTab).toHaveBeenLastCalledWith('s3');
  forgetAgentTerminal('s3');
  await openThreadPanelTerminal({ ownerId: 'o', projectId: 'p', panel, intent: { command: null, title: null } });
  expect(product.terminals.create).toHaveBeenCalledTimes(4);
});
it('releases failed queue entries and cleans shells created after navigation', async () => {
  resetThreadOpenTerminalBuffer(); vi.clearAllMocks();
  const panel: any = { state: { tabs: [] }, activateTab: vi.fn(), addTab: vi.fn() };
  vi.mocked(product.terminals.create).mockResolvedValueOnce({ ok: false, message: 'failed' } as any);
  await expect(openThreadPanelTerminal({ projectId: 'p', panel, intent: { command: null, title: null } })).rejects.toThrow('failed');
  let current = true;
  vi.mocked(product.terminals.create).mockImplementationOnce(async () => { current = false; return { ok: true, value: { id: 'late' } } as any; });
  vi.mocked(product.terminals.close).mockResolvedValue(true);
  await openThreadPanelTerminal({ projectId: 'p', panel, intent: { command: null, title: null }, isCurrent: () => current });
  expect(product.terminals.close).toHaveBeenCalledWith('late'); expect(panel.addTab).not.toHaveBeenCalled();
  await openThreadPanelTerminal({ projectId: 'p', panel, intent: { command: null, title: null }, isCurrent: () => false });
  expect(product.terminals.create).toHaveBeenCalledTimes(2);
});
it('keeps CLI Agent ownership bookkeeping across concurrent shell creates', async () => {
  resetThreadOpenTerminalBuffer(); vi.clearAllMocks(); store.data.terminals = { p: [] };
  store.data.createTerminal.mockImplementation(async () => { const value = { id: `c${store.data.createTerminal.mock.calls.length}`, status: 'running' }; store.data.terminals.p.push(value); return value; });
  await Promise.all(Array.from({ length: 6 }, () => openProjectStripTerminal({ ownerId: 'cli', projectId: 'p', intent: { command: 'echo', title: null } })));
  expect(store.data.createTerminal).toHaveBeenCalledTimes(3); expect(store.ui.selectTab).toHaveBeenLastCalledWith('p', 'c3');
});
it('bounds buffered intent queues', () => {
  resetThreadOpenTerminalBuffer(); vi.clearAllMocks();
  for (let i = 0; i < 20; i++) bufferThreadOpenTerminal('o', { command: null, title: null });
  let count = 0; while (consumePendingOpenTerminal('o')) count++;
  expect(count).toBe(12); expect(store.ui.pushToast).toHaveBeenCalled();
});

it('uses one app subscription to route CLI opens and buffer Modern opens, and releases it', async () => {
  store.data.terminals = { p: [{ id: 'cli', status: 'running' }, { id: 'exited', status: 'exited' }] };
  store.data.createTerminal.mockResolvedValueOnce({ id: 'shell' });
  const hook = renderHook(() => useCliAgentTerminalSignal());
  const open = vi.mocked(product.threads.onOpen).mock.calls[0][0];
  open(null); open({ threadId: 'modern' });
  open({ threadId: 'cli', terminal: { command: 'echo cli' } });
  await waitFor(() => expect(store.ui.selectTab).toHaveBeenCalledWith('p', 'shell'));
  open({ threadId: 'exited', terminal: { title: 'Buffered' } });
  expect(consumePendingOpenTerminal('exited')).toEqual({ command: null, title: 'Buffered' });
  const stopOpen = vi.mocked(product.threads.onOpen).mock.results[0].value;
  const stopExit = vi.mocked(product.terminals.onExit).mock.results[0].value;
  hook.unmount(); expect(stopOpen).toHaveBeenCalledOnce(); expect(stopExit).toHaveBeenCalledOnce();
});

it('drains buffered and local-event opens only for the current mounted thread', async () => {
  const panel: any = { state: { tabs: [] }, addTab: vi.fn(), activateTab: vi.fn() };
  vi.mocked(product.terminals.create).mockResolvedValue({ ok: true, value: { id: 'new' } } as any);
  bufferThreadOpenTerminal('modern', { title: 'Before mount', command: null });
  const hook = renderHook(({ threadId }) => useThreadOpenTerminalSignal({ threadId, environmentId: null, projectId: 'p', panel }), { initialProps: { threadId: 'modern' } });
  await waitFor(() => expect(panel.addTab).toHaveBeenCalledOnce());
  bufferThreadOpenTerminal('modern', { title: 'After mount', command: null });
  window.dispatchEvent(new CustomEvent(THREAD_OPEN_TERMINAL_EVENT, { detail: { threadId: 'elsewhere' } }));
  expect(panel.addTab).toHaveBeenCalledOnce();
  window.dispatchEvent(new CustomEvent(THREAD_OPEN_TERMINAL_EVENT, { detail: { threadId: 'modern' } }));
  await waitFor(() => expect(panel.addTab).toHaveBeenCalledTimes(2));
  hook.rerender({ threadId: 'elsewhere' }); hook.unmount();
  bufferThreadOpenTerminal('modern', { title: 'After unmount', command: null });
  window.dispatchEvent(new CustomEvent(THREAD_OPEN_TERMINAL_EVENT, { detail: { threadId: 'modern' } }));
  expect(panel.addTab).toHaveBeenCalledTimes(2);
});
