import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKER_API_ERROR_RECOVERY_DEFAULTS, WorkerApiErrorRecovery, type WorkerApiErrorRecoveryDeps } from '../worker-api-error-recovery.js';
import { WorkUnitRecoveryGuardError, type WorkerApiErrorRecovery as Durable } from '../store.js';

const T = WORKER_API_ERROR_RECOVERY_DEFAULTS;
const COHORT = { executionId: 'e1', slotId: 'slot-1' };
const TEMP = { error: 'rate_limit', text: '429', retryable: true };
const CLAIM2 = { workUnitId: 'u1', claimId: 'c2', claimGeneration: 2 };

function setup(over: Partial<WorkerApiErrorRecoveryDeps> = {}) {
  const state = {
    claim: { workUnitId: 'u1', claimId: 'c1', claimGeneration: 1 } as { workUnitId: string; claimId: string; claimGeneration: number } | undefined,
    agent: 'idle' as string | undefined,
    steps: [] as Durable['steps'],
    restart: { ok: true } as { ok: true } | { ok: false; reason: string; message?: string },
    onRestart: undefined as (() => void) | undefined
  };
  const calls: string[] = [];
  const records: Array<{ step: string; summary: string; deadlineAt?: number }> = [];
  const deps: WorkerApiErrorRecoveryDeps = {
    enabled: () => true,
    findClaim: async () => state.claim,
    getRecovery: () => state.steps.length && state.claim
      ? { claimId: state.claim.claimId, claimGeneration: state.claim.claimGeneration, slotId: 'slot-1', executionAttempt: 1, step: 'waiting', startedAt: 0, updatedAt: 0, steps: state.steps }
      : undefined,
    record: async (_id, input) => {
      calls.push(`record:${input.step}`);
      records.push({ step: input.step, summary: input.summary, deadlineAt: input.deadlineAt });
      state.steps.push({ step: input.step, at: Date.now() });
    },
    getAgentState: () => state.agent,
    nudge: async (_s, text) => { calls.push('nudge'); expect(text).toContain('`u1`'); },
    restart: async () => { calls.push('restart'); state.onRestart?.(); return state.restart; },
    redeliver: async () => { calls.push('redeliver'); return true; },
    blockToHuman: async () => { calls.push('block'); },
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    log: vi.fn(),
    ...over
  };
  const engine = new WorkerApiErrorRecovery(deps);
  return { engine, state, calls, records, deps };
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe('WorkerApiErrorRecovery', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('nudges after the delay and records resumed when a turn starts', async () => {
    const { engine, calls, records } = setup();
    await engine.onApiErrorStop('s1', COHORT, TEMP);
    expect(records[0].summary).toBe('Engineer slot-1 stopped on a temporary API error (rate_limit); Zana will nudge it in 30 s');
    expect(records[0].deadlineAt).toBe(Date.now() + T.nudgeDelayMs + T.nudgeTurnMs + T.restartDelayMs + T.restartTurnMs + 60000);
    await advance(T.nudgeDelayMs);
    expect(calls).toEqual(['record:waiting', 'nudge', 'record:nudged']);
    engine.onTurnStarted('s1', 'idle');
    await advance(0);
    expect(calls.at(-1)).toBe('record:resumed');
    await advance(T.nudgeTurnMs + T.restartDelayMs);
    expect(calls).not.toContain('restart');
  });

  it('restarts on a second temporary stop after a nudge that started a turn', async () => {
    const { engine, calls, records } = setup();
    await engine.onApiErrorStop('s1', COHORT, TEMP);
    await advance(T.nudgeDelayMs);
    engine.onTurnStarted('s1', 'idle');
    await advance(0);
    await engine.onApiErrorStop('s1', COHORT, TEMP);
    expect(records.at(-1)?.summary).toBe('Engineer slot-1 stopped on another temporary API error (rate_limit); Zana will restart it in 60 s');
    expect(records.at(-1)?.deadlineAt).toBe(Date.now() + T.restartDelayMs + T.restartTurnMs + 60000);
    await advance(T.restartDelayMs);
    expect(calls.slice(-3)).toEqual(['restart', 'record:restarted', 'redeliver']);
  });

  it('ignores a turn start whose prior state is working', async () => {
    const { engine, calls } = setup();
    await engine.onApiErrorStop('s1', COHORT, TEMP);
    engine.onTurnStarted('s1', 'working');
    await advance(T.nudgeDelayMs);
    expect(calls).toEqual(['record:waiting', 'nudge', 'record:nudged']);
  });

  it('restarts when the nudge starts no turn, then resumes', async () => {
    const { engine, calls, records } = setup();
    await engine.onApiErrorStop('s1', COHORT, TEMP);
    await advance(T.nudgeDelayMs + T.nudgeTurnMs);
    expect(calls).toEqual(['record:waiting', 'nudge', 'record:nudged', 'restart', 'record:restarted', 'redeliver']);
    expect(records.at(-1)?.summary).toBe('Restarted engineer slot-1 after an API error and delivered work unit u1 again');
    engine.onTurnStarted('s1', 'idle');
    await advance(0);
    expect(calls.at(-1)).toBe('record:resumed');
    await advance(T.restartTurnMs);
    expect(calls).not.toContain('block');
  });

  it('restarts after the delay when a second temporary error follows the nudge', async () => {
    const { engine, calls } = setup();
    await engine.onApiErrorStop('s1', COHORT, TEMP);
    await advance(T.nudgeDelayMs);
    await engine.onApiErrorStop('s1', COHORT, TEMP);
    await advance(T.restartDelayMs);
    expect(calls.filter((c) => c === 'restart')).toHaveLength(1);
    expect(calls.filter((c) => c === 'nudge')).toHaveLength(1);
  });

  it('asks the user for an error after the restart', async () => {
    const { engine, calls } = setup();
    await engine.onApiErrorStop('s1', COHORT, TEMP);
    await advance(T.nudgeDelayMs + T.nudgeTurnMs);
    await engine.onApiErrorStop('s1', COHORT, TEMP);
    expect(calls.at(-1)).toBe('block');
    await advance(T.restartTurnMs);
    expect(calls.filter((c) => c === 'block')).toHaveLength(1);
  });

  it('blocks when the restart fails and the fence still holds', async () => {
    const { engine, calls, state, records } = setup();
    state.restart = { ok: false, reason: 'no-capability' };
    await engine.onApiErrorStop('s1', COHORT, TEMP);
    await advance(T.nudgeDelayMs + T.nudgeTurnMs);
    expect(calls.slice(-2)).toEqual(['record:restart-failed', 'block']);
    expect(records.at(-1)?.summary).toBe('Could not restart engineer slot-1: no-capability');
  });

  it('stops quietly when the restart fails and the fence changed', async () => {
    const { engine, calls, state } = setup();
    state.restart = { ok: false, reason: 'gone', message: 'session gone' };
    state.onRestart = () => { state.claim = CLAIM2; };
    await engine.onApiErrorStop('s1', COHORT, TEMP);
    await advance(T.nudgeDelayMs + T.nudgeTurnMs);
    expect(calls.at(-1)).toBe('record:restart-failed');
    expect(calls).not.toContain('block');
  });

  it('blocks when the redelivered assignment starts no turn', async () => {
    const { engine, calls } = setup();
    await engine.onApiErrorStop('s1', COHORT, TEMP);
    await advance(T.nudgeDelayMs + T.nudgeTurnMs + T.restartTurnMs);
    expect(calls.at(-1)).toBe('block');
  });

  it('blocks a permanent error at once without a nudge', async () => {
    const { engine, calls, records } = setup();
    await engine.onApiErrorStop('s1', COHORT, { error: 'billing_error', text: 'x', retryable: false });
    expect(calls).toEqual(['record:waiting', 'block']);
    expect(records[0].summary).toBe('Engineer slot-1 stopped on an API error Zana does not retry (billing_error)');
    await advance(T.nudgeDelayMs);
    expect(calls).toEqual(['record:waiting', 'block']);
  });

  it('does nothing when disabled or without a claim', async () => {
    const off = setup({ enabled: () => false });
    await off.engine.onApiErrorStop('s1', COHORT, TEMP);
    const none = setup();
    none.state.claim = undefined;
    await none.engine.onApiErrorStop('s1', COHORT, TEMP);
    await advance(T.nudgeDelayMs * 10);
    expect(off.calls).toEqual([]);
    expect(none.calls).toEqual([]);
  });

  it('treats an absent retryable as temporary', async () => {
    const { engine, calls } = setup();
    await engine.onApiErrorStop('s1', COHORT, { error: 'unknown', text: '' });
    await advance(T.nudgeDelayMs);
    expect(calls).toContain('nudge');
  });

  it('does not nudge a busy worker', async () => {
    const { engine, calls, state } = setup();
    await engine.onApiErrorStop('s1', COHORT, TEMP);
    state.agent = 'working';
    await advance(T.nudgeDelayMs + T.nudgeTurnMs + T.restartDelayMs);
    expect(calls).toEqual(['record:waiting']);
  });

  it('resumes without a nudge when a turn started before the nudge time', async () => {
    const { engine, calls } = setup();
    await engine.onApiErrorStop('s1', COHORT, TEMP);
    engine.onTurnStarted('s1', 'waiting');
    await advance(T.nudgeDelayMs * 2);
    expect(calls).toEqual(['record:waiting', 'record:resumed']);
  });

  it('applies a turn that starts while the nudge is in flight', async () => {
    let release!: () => void;
    const { engine, calls } = setup({ nudge: () => new Promise<void>((r) => { release = r; }) });
    await engine.onApiErrorStop('s1', COHORT, TEMP);
    await advance(T.nudgeDelayMs);
    engine.onTurnStarted('s1', 'idle');
    release();
    await advance(0);
    expect(calls).toEqual(['record:waiting', 'record:nudged', 'record:resumed']);
  });

  it.each([
    ['nudge', T.nudgeDelayMs],
    ['restart after the nudge', T.nudgeDelayMs + T.nudgeTurnMs],
    ['block after the redelivery', T.nudgeDelayMs + T.nudgeTurnMs + T.restartTurnMs]
  ])('stops when the claim fence changed before the %s timer', async (_name, delay) => {
    const { engine, calls, state } = setup();
    await engine.onApiErrorStop('s1', COHORT, TEMP);
    await advance(delay - 1);
    const before = calls.length;
    state.claim = CLAIM2;
    await advance(T.restartTurnMs * 3);
    expect(calls).not.toContain('block');
    expect(calls.slice(before)).toEqual([]);
  });

  it('stops quietly when a record call reports the claim moved on', async () => {
    const { engine, calls } = setup({ record: async () => { throw new WorkUnitRecoveryGuardError('moved'); } });
    await engine.onApiErrorStop('s1', COHORT, TEMP);
    await advance(T.nudgeDelayMs * 5);
    expect(calls).toEqual([]);
  });

  it('keeps the session through a restart in flight on forget, but drops it otherwise', async () => {
    let finish!: (r: { ok: true }) => void;
    const { engine, calls } = setup({ restart: () => new Promise((r) => { finish = r; }) });
    await engine.onApiErrorStop('s1', COHORT, TEMP);
    await advance(T.nudgeDelayMs + T.nudgeTurnMs);
    engine.forget('s1');
    finish({ ok: true });
    await advance(0);
    expect(calls).toContain('record:restarted');

    const other = setup();
    await other.engine.onApiErrorStop('s2', COHORT, TEMP);
    other.engine.forget('s2');
    await advance(T.nudgeDelayMs);
    expect(other.calls).toEqual(['record:waiting']);
  });

  it('dispose clears every timer', async () => {
    const { engine, calls } = setup();
    await engine.onApiErrorStop('s1', COHORT, TEMP);
    engine.dispose();
    await advance(T.nudgeDelayMs * 10);
    expect(calls).toEqual(['record:waiting']);
  });

  it('logs and never throws when a dependency throws', async () => {
    const log = vi.fn();
    const boom = setup({ findClaim: async () => { throw new Error('x'); }, log });
    await expect(boom.engine.onApiErrorStop('s1', COHORT, TEMP)).resolves.toBeUndefined();
    const nudgeBoom = setup({ nudge: async () => { throw new Error('n'); }, log });
    await nudgeBoom.engine.onApiErrorStop('s1', COHORT, TEMP);
    await advance(T.nudgeDelayMs);
    expect(log).toHaveBeenCalledTimes(2);
    expect(() => nudgeBoom.engine.onTurnStarted('s1', 'idle')).not.toThrow();
    expect(() => nudgeBoom.engine.forget('zzz')).not.toThrow();
  });
});
