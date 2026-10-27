import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disposeThreadWrapUps,
  ThreadWrapUpRegistry,
  threadWrapUps,
  WRAP_UP_SETTLE_MS,
  WRAP_UP_TIMEOUT_MS,
  type ThreadWrapUpHost
} from './thread-wrap-up.js';
import type { SessionCloseNote, SummarizeForCloseResult } from '../followups/close-summary.js';

const thread = { id: 't1', projectId: 'p1', hostId: 'h1', title: ' Build it ' };
const INSTRUCTIONS = 'Wrap up.\n1. Do it.';
const note = (over: Partial<SessionCloseNote> = {}): SessionCloseNote => ({ body: '## Did\n- a', unfinished: false, asksUser: false, ...over });

function make(over: Partial<ThreadWrapUpHost> = {}) {
  const listeners = new Set<(payload: unknown) => void>();
  const order: string[] = [];
  const state = { status: 'idle', pending: false, messages: [] as Array<{ seq: number; role: 'user' | 'assistant'; text: string }> };
  const host = {
    instructions: () => INSTRUCTIONS,
    hasPendingInteraction: vi.fn(() => state.pending),
    hostOnline: vi.fn(() => true),
    getStatus: vi.fn(() => state.status),
    send: vi.fn(async () => { order.push('send'); }),
    subscribe: vi.fn((l: (payload: unknown) => void) => {
      order.push('subscribe');
      listeners.add(l);
      return () => { listeners.delete(l); };
    }),
    messages: vi.fn(() => state.messages),
    digest: vi.fn(() => 'digest'),
    summarizeForClose: vi.fn(async (): Promise<SummarizeForCloseResult> => ({ ok: true, title: 'Build it', note: note() })),
    recordClose: vi.fn(async () => undefined),
    recordKeptOpen: vi.fn(async () => undefined),
    archive: vi.fn(async () => true),
    setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimer: (h: NodeJS.Timeout) => clearTimeout(h),
    log: vi.fn(),
    ...over
  } satisfies ThreadWrapUpHost;
  const registry = new ThreadWrapUpRegistry(host);
  const emit = (view: Record<string, unknown>) => {
    state.status = (view.status as string) ?? state.status;
    for (const l of [...listeners]) l({ id: 't1', ...view });
  };
  return { host, registry, emit, state, listeners, order };
}

/** Run a wrap-up to the point where the thread is active, then rested for the settle time. */
async function rest(h: ReturnType<typeof make>) {
  expect(await h.registry.request(thread)).toBe(true);
  h.emit({ status: 'active' });
  h.emit({ status: 'idle' });
  await vi.advanceTimersByTimeAsync(WRAP_UP_SETTLE_MS);
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('ThreadWrapUpRegistry', () => {
  it('subscribes before it sends the instructions once, line breaks kept', async () => {
    const h = make();
    expect(await h.registry.request(thread)).toBe(true);
    expect(h.order).toEqual(['subscribe', 'send']);
    expect(h.host.send).toHaveBeenCalledWith('t1', INSTRUCTIONS);
    expect(h.registry.isWrappingUp('t1')).toBe(true);
    expect(await h.registry.request(thread)).toBe(true);
    expect(h.host.send).toHaveBeenCalledTimes(1);
    expect(h.host.subscribe).toHaveBeenCalledTimes(1);
  });

  it('keeps the thread open with an inbox note when it already waits on the user', async () => {
    const h = make();
    h.state.pending = true;
    expect(await h.registry.request(thread)).toBe(true);
    expect(h.host.send).not.toHaveBeenCalled();
    expect(h.host.recordKeptOpen).toHaveBeenCalledWith('p1', 't1', 'Build it', 'asks-you', undefined);
    expect(h.registry.isWrappingUp('t1')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back to today\'s close when the host is offline or the send throws', async () => {
    const offline = make({ hostOnline: () => false });
    expect(await offline.registry.request(thread)).toBe(false);
    expect(offline.host.send).not.toHaveBeenCalled();
    expect(offline.host.subscribe).not.toHaveBeenCalled();
    const throwing = make({ send: vi.fn(async () => { throw new Error('queue full'); }) });
    expect(await throwing.registry.request(thread)).toBe(false);
    expect(throwing.host.log).toHaveBeenCalledWith(expect.stringContaining('send failed: queue full'));
    const plain = make({ send: vi.fn(async () => { throw 'nope'; }) });
    expect(await plain.registry.request(thread)).toBe(false);
    for (const h of [offline, throwing, plain]) {
      expect(h.registry.isWrappingUp('t1')).toBe(false);
      expect(h.listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('ignores an active edge seen before the send, and waits for the thread to leave a busy state first', async () => {
    const h = make();
    h.state.status = 'active';
    await h.registry.request(thread);
    h.emit({ status: 'active' }); // still the earlier turn
    h.emit({ status: 'idle' }); // the queued wrap-up message is sent after this
    await vi.advanceTimersByTimeAsync(WRAP_UP_SETTLE_MS);
    expect(h.host.summarizeForClose).not.toHaveBeenCalled();
    h.emit({ status: 'active' });
    h.emit({ status: 'idle' });
    await vi.advanceTimersByTimeAsync(WRAP_UP_SETTLE_MS);
    expect(h.host.recordClose).toHaveBeenCalledTimes(1);
  });

  it('summarises after a 5 s rest, records wrapped and archives', async () => {
    const h = make();
    await rest(h);
    expect(h.host.summarizeForClose).toHaveBeenCalledWith('p1', 't1', { digest: 'digest', title: 'Build it' });
    expect(h.host.recordClose).toHaveBeenCalledWith('p1', 't1', 'Build it', note(), 'wrapped');
    expect(h.host.archive).toHaveBeenCalledWith('t1');
    expect(h.registry.isWrappingUp('t1')).toBe(false);
    expect(h.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not finish when the rest is shorter than the settle time', async () => {
    const h = make();
    await h.registry.request(thread);
    h.emit({ status: 'active' });
    h.emit({ status: 'idle' });
    await vi.advanceTimersByTimeAsync(WRAP_UP_SETTLE_MS - 1000);
    h.emit({ status: 'active' });
    await vi.advanceTimersByTimeAsync(WRAP_UP_SETTLE_MS);
    expect(h.host.summarizeForClose).not.toHaveBeenCalled();
    h.emit({ status: 'idle' });
    h.emit({ status: 'idle' }); // a repeat event keeps the same wait
    await vi.advanceTimersByTimeAsync(WRAP_UP_SETTLE_MS);
    expect(h.host.recordClose).toHaveBeenCalledTimes(1);
  });

  it('re-checks the status when the rest timer fires', async () => {
    const h = make();
    await h.registry.request(thread);
    h.emit({ status: 'active' });
    h.emit({ status: 'idle' });
    h.state.status = 'active'; // flipped without an event
    await vi.advanceTimersByTimeAsync(WRAP_UP_SETTLE_MS);
    expect(h.host.summarizeForClose).not.toHaveBeenCalled();
    h.state.status = 'idle';
    h.state.pending = true;
    h.emit({ status: 'idle' });
    await vi.advanceTimersByTimeAsync(WRAP_UP_SETTLE_MS);
    expect(h.host.summarizeForClose).not.toHaveBeenCalled();
    h.state.pending = false;
    h.emit({ status: 'idle' });
    await vi.advanceTimersByTimeAsync(WRAP_UP_SETTLE_MS);
    expect(h.host.recordClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the thread open, with a note and no archive, when a question stays pending for 5 s', async () => {
    const h = make();
    await h.registry.request(thread);
    h.emit({ status: 'active' });
    h.state.pending = true;
    h.emit({ status: 'active', hasPendingInteraction: true });
    await vi.advanceTimersByTimeAsync(WRAP_UP_SETTLE_MS);
    expect(h.host.recordKeptOpen).toHaveBeenCalledWith('p1', 't1', 'Build it', 'asks-you', note());
    expect(h.host.archive).not.toHaveBeenCalled();
    expect(h.host.recordClose).not.toHaveBeenCalled();
    expect(h.registry.isWrappingUp('t1')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a pending interaction that is answered within the settle time or is gone when the timer fires', async () => {
    const h = make();
    await h.registry.request(thread);
    h.emit({ status: 'active' });
    h.state.pending = true;
    h.emit({ status: 'active', hasPendingInteraction: true });
    await vi.advanceTimersByTimeAsync(1000);
    h.state.pending = false;
    h.emit({ status: 'active', hasPendingInteraction: false });
    await vi.advanceTimersByTimeAsync(WRAP_UP_SETTLE_MS);
    expect(h.host.recordKeptOpen).not.toHaveBeenCalled();
    h.emit({ status: 'active', hasPendingInteraction: true });
    await vi.advanceTimersByTimeAsync(1000);
    h.state.pending = false; // answered without an event
    await vi.advanceTimersByTimeAsync(WRAP_UP_SETTLE_MS);
    expect(h.host.recordKeptOpen).not.toHaveBeenCalled();
  });

  it('records the block without a note when the summary fails', async () => {
    const h = make({ summarizeForClose: vi.fn(async () => ({ ok: false, reason: 'summary-failed' }) as const) });
    await h.registry.request(thread);
    h.emit({ status: 'active' });
    h.state.pending = true;
    h.emit({ status: 'active', hasPendingInteraction: true });
    await vi.advanceTimersByTimeAsync(WRAP_UP_SETTLE_MS);
    expect(h.host.recordKeptOpen).toHaveBeenCalledWith('p1', 't1', 'Build it', 'asks-you', undefined);
  });

  it('keeps the thread open when the summary says the agent asks the user', async () => {
    const h = make({ summarizeForClose: vi.fn(async () => ({ ok: true, title: 'Build it', note: note({ asksUser: true }) }) as const) });
    await rest(h);
    expect(h.host.recordKeptOpen).toHaveBeenCalledWith('p1', 't1', 'Build it', 'asks-you', note({ asksUser: true }));
    expect(h.host.archive).not.toHaveBeenCalled();
    expect(h.host.recordClose).not.toHaveBeenCalled();
  });

  it('still archives when the summary fails', async () => {
    const h = make({ summarizeForClose: vi.fn(async () => { throw new Error('llm down'); }) });
    await rest(h);
    expect(h.host.recordClose).not.toHaveBeenCalled();
    expect(h.host.archive).toHaveBeenCalledWith('t1');
    expect(h.host.log).toHaveBeenCalledWith(expect.stringContaining('summary failed: llm down'));
    const failed = make({ summarizeForClose: vi.fn(async () => ({ ok: false, reason: 'empty' }) as const) });
    await rest(failed);
    expect(failed.host.archive).toHaveBeenCalledWith('t1');
  });

  it('logs and releases everything when recording or archiving throws', async () => {
    const h = make({ archive: vi.fn(async () => { throw new Error('locked'); }) });
    await rest(h);
    expect(h.host.log).toHaveBeenCalledWith(expect.stringContaining('close failed: locked'));
    expect(h.registry.isWrappingUp('t1')).toBe(false);
    const k = make({ recordKeptOpen: vi.fn(async () => { throw new Error('disk'); }) });
    k.state.pending = true;
    await k.registry.request(thread);
    expect(k.host.log).toHaveBeenCalledWith(expect.stringContaining('record failed: disk'));
    expect(k.registry.isWrappingUp('t1')).toBe(false);
    const plain = make({ archive: vi.fn(async () => { throw 'x'; }) });
    await rest(plain);
    expect(plain.host.log).toHaveBeenCalledWith(expect.stringContaining('close failed: x'));
  });

  it('stops without a record or archive when the user writes in the thread after the wrap-up message', async () => {
    const h = make();
    h.state.messages = [{ seq: 4, role: 'assistant', text: 'earlier' }];
    await h.registry.request(thread);
    h.emit({ status: 'active' });
    h.state.messages = [
      { seq: 4, role: 'assistant', text: 'earlier' },
      { seq: 5, role: 'user', text: INSTRUCTIONS },
      { seq: 6, role: 'assistant', text: 'summary' },
      { seq: 7, role: 'user', text: 'actually, one more thing' }
    ];
    h.emit({ status: 'idle' });
    await vi.advanceTimersByTimeAsync(WRAP_UP_SETTLE_MS);
    expect(h.host.summarizeForClose).not.toHaveBeenCalled();
    expect(h.host.archive).not.toHaveBeenCalled();
    expect(h.host.recordClose).not.toHaveBeenCalled();
    expect(h.registry.isWrappingUp('t1')).toBe(false);
  });

  it('treats a different first user message as the user taking over', async () => {
    const h = make();
    await h.registry.request(thread);
    h.emit({ status: 'active' });
    h.state.messages = [{ seq: 1, role: 'user', text: 'something else' }];
    h.emit({ status: 'idle' });
    await vi.advanceTimersByTimeAsync(WRAP_UP_SETTLE_MS);
    expect(h.host.archive).not.toHaveBeenCalled();
  });

  it('records a turn error and keeps the thread open', async () => {
    const h = make();
    await h.registry.request(thread);
    h.emit({ status: 'error' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.host.recordKeptOpen).toHaveBeenCalledWith('p1', 't1', 'Build it', 'turn-error', undefined);
    expect(h.host.archive).not.toHaveBeenCalled();
    expect(h.registry.isWrappingUp('t1')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the thread open after 15 minutes, with no summary', async () => {
    const h = make();
    await h.registry.request(thread);
    await vi.advanceTimersByTimeAsync(WRAP_UP_TIMEOUT_MS);
    expect(h.host.recordKeptOpen).toHaveBeenCalledWith('p1', 't1', 'Build it', 'timeout', undefined);
    expect(h.host.summarizeForClose).not.toHaveBeenCalled();
    expect(h.registry.isWrappingUp('t1')).toBe(false);
    expect(h.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores other threads\' updates and junk payloads, and a throwing collaborator never escapes the listener', async () => {
    const h = make({ hasPendingInteraction: vi.fn(() => false) });
    await h.registry.request(thread);
    const [listener] = [...h.listeners];
    expect(() => listener(null)).not.toThrow();
    expect(() => listener({ id: 'other', status: 'error' })).not.toThrow();
    expect(h.host.recordKeptOpen).not.toHaveBeenCalled();
    h.host.getStatus = vi.fn(() => { throw new Error('boom'); });
    h.host.setTimer = (() => { throw new Error('no timers'); }) as never;
    expect(() => listener({ id: 't1', status: 'active' })).not.toThrow();
    expect(() => listener({ id: 't1', status: 'idle' })).not.toThrow();
    expect(h.host.log).toHaveBeenCalledWith(expect.stringContaining('listener failed: no timers'));
    h.registry.dispose();
  });

  it('logs a non-Error listener failure', async () => {
    const h = make();
    await h.registry.request(thread);
    h.host.setTimer = (() => { throw 'plain'; }) as never;
    const [listener] = [...h.listeners];
    listener({ id: 't1', status: 'active' });
    listener({ id: 't1', status: 'idle' });
    expect(h.host.log).toHaveBeenCalledWith(expect.stringContaining('listener failed: plain'));
    h.registry.dispose();
  });

  it('dispose releases every subscription and timer', async () => {
    const h = make();
    await h.registry.request(thread);
    await h.registry.request({ ...thread, id: 't2' });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    h.registry.dispose();
    expect(h.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.registry.isWrappingUp('t1')).toBe(false);
    h.registry.dispose();
  });

  it('uses a placeholder title for an untitled thread', async () => {
    const h = make();
    h.state.pending = true;
    await h.registry.request({ ...thread, title: null });
    expect(h.host.recordKeptOpen).toHaveBeenCalledWith('p1', 't1', 'Untitled agent', 'asks-you', undefined);
  });
});

describe('threadWrapUps', () => {
  it('builds one registry per ctx, wired to the live services, and disposes it with the ctx', async () => {
    const unsubscribe = vi.fn();
    const ctx = {
      config: { getConfig: () => ({ closeWrapUpInstructions: 'Be brief' }) },
      pendingInteractions: { hasPendingThreadInteraction: () => false },
      hostHub: { connectedHostIds: () => [] as string[] },
      hub: { subscribe: vi.fn(() => unsubscribe) }
    } as never;
    const registry = threadWrapUps(ctx);
    expect(threadWrapUps(ctx)).toBe(registry);
    // Host not connected: the request falls back without touching the thread store.
    expect(await registry.request(thread)).toBe(false);
    disposeThreadWrapUps(ctx);
    expect(threadWrapUps(ctx)).not.toBe(registry);
    disposeThreadWrapUps({} as never);
  });
});
