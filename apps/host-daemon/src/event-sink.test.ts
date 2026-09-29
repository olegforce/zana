import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEventSink } from './event-sink.js';

describe('event sink', () => {
  afterEach(() => vi.useRealTimers());
  it('automatically retries a lost acknowledgement without another event or reconnect', async () => {
    vi.useFakeTimers();
    const postEvents = vi.fn().mockRejectedValueOnce(new Error('lost ack')).mockResolvedValue(undefined);
    const sink = createEventSink({ isSessionOpen: () => true, postEvents });
    sink.emit({ kind: 'terminal.exited', payload: { exitCode: 0 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(postEvents).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(250);
    expect(postEvents).toHaveBeenCalledTimes(2);
    expect(postEvents.mock.calls[1]).toEqual(postEvents.mock.calls[0]);
    await sink.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not strand an event emitted while the completed drain is releasing its promise', async () => {
    vi.useFakeTimers();
    let sink: ReturnType<typeof createEventSink>;
    let inject = true;
    const posted: string[] = [];
    sink = createEventSink({ isSessionOpen: () => true, postEvents: async events => {
      posted.push(...events.map(event => event.kind));
      if (inject) {
        inject = false;
        // The second microtask runs after the drain sees an empty queue, but
        // before its finally handler releases the in-flight promise.
        void Promise.resolve().then(() => Promise.resolve().then(() => sink.emit({ kind: 'terminal.exited' })));
      }
    } });
    sink.emit({ kind: 'terminal.output' });
    await vi.advanceTimersByTimeAsync(1);
    expect(posted).toEqual(['terminal.output', 'terminal.exited']);
    await sink.dispose();
  });

  it('backs off repeated failures, stops retrying offline and clears timers on disposal', async () => {
    vi.useFakeTimers();
    let online = true;
    const postEvents = vi.fn().mockRejectedValue(new Error('unavailable'));
    const sink = createEventSink({ isSessionOpen: () => online, postEvents });
    sink.emit({ kind: 'terminal.exited' });
    await vi.advanceTimersByTimeAsync(249);
    expect(postEvents).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(postEvents).toHaveBeenCalledTimes(2);
    sink.emit({ kind: 'terminal.output' });
    await vi.advanceTimersByTimeAsync(499);
    expect(postEvents).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(postEvents).toHaveBeenCalledTimes(3);
    online = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(postEvents).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    online = true;
    await sink.flush();
    expect(postEvents).toHaveBeenCalledTimes(4);
    await sink.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(postEvents).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('retains the same immutable batch on a lost ack, then drains later events in order', async () => {
    let online = false; let fail = true;
    const posted: Array<{ id: string; events: unknown[] }> = [];
    const sink = createEventSink({ isSessionOpen: () => online, postEvents: async (events, id) => { posted.push({ id, events }); if (fail) throw new Error('lost ack'); } });
    const event = { kind: 'thread.started' as const, payload: { name: 'original' } };
    sink.emit(event); event.payload.name = 'mutated'; await sink.flush(); online = true;
    await sink.flush();
    sink.emit({ kind: 'thread.event', payload: { name: 'later' } }); fail = false;
    await sink.flush();
    expect(posted[0]).toEqual(posted[1]);
    expect(posted[0]!.events).toEqual([{ kind: 'thread.started', payload: { name: 'original' } }]);
    expect(posted[2]!.events).toEqual([{ kind: 'thread.event', payload: { name: 'later' } }]);
    expect(posted[2]!.id).not.toBe(posted[0]!.id); await sink.dispose();
  });
  it.each([{ maxBytes: 1 }, { maxEvents: 1 }])('stops instead of growing an unbounded offline queue: %j', async limits => {
    const onOverflow = vi.fn(), postEvents = vi.fn();
    const sink = createEventSink({ isSessionOpen: () => false, postEvents, onOverflow, ...limits });
    for (let n = 0; n < 10; n++) sink.emit({ kind: 'thread.event' });
    await sink.flush(); await sink.dispose();
    expect(onOverflow).toHaveBeenCalledOnce(); expect(postEvents).not.toHaveBeenCalled();
  });
  it('drains bounded batches and releases queued events on disposal', async () => {
    let online = false; const batches: number[] = [];
    const sink = createEventSink({ isSessionOpen: () => online, postEvents: async events => { batches.push(events.length); }, debounceMs: 1 });
    for (let n = 0; n < 300; n++) sink.emit({ kind: 'thread.event' });
    online = true;
    await vi.waitFor(() => expect(batches).toEqual([256, 44]));
    await sink.dispose(); sink.emit({ kind: 'thread.started' }); await sink.flush();
    expect(batches).toEqual([256, 44]);
  });
  it('posts host events without a sequence field', async () => {
    const posted: unknown[] = [];
    const sink = createEventSink({
      isSessionOpen: () => true,
      postEvents: async (events) => {
        posted.push(...events);
      },
      debounceMs: 1
    });
    sink.emit({ threadId: '11111111-1111-4111-8111-111111111111', kind: 'thread.started' });
    await sink.flush();
    expect(posted).toEqual([
      expect.objectContaining({ kind: 'thread.started' })
    ]);
    expect(posted[0]).not.toHaveProperty('sequence');
  });

  it('retries a failed post while the session stays open', async () => {
    const posted: unknown[] = [];
    let fail = true;
    const sink = createEventSink({
      isSessionOpen: () => true,
      postEvents: async (events) => {
        if (fail) throw new Error('transient');
        posted.push(...events);
      },
      debounceMs: 1
    });
    sink.emit({ threadId: '11111111-1111-4111-8111-111111111111', kind: 'turn.completed' });
    await sink.flush();
    expect(posted).toHaveLength(0);
    fail = false;
    await sink.flush();
    expect(posted).toEqual([expect.objectContaining({ kind: 'turn.completed' })]);
  });
});
