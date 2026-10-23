import { WorkUnitRecoveryGuardError, type RecordWorkerRecoveryInput, type WorkerApiErrorRecovery as DurableRecovery } from './store.js';

/**
 * Zana's ladder for a Squad engineer whose turn ended on an API error: nudge it, then
 * restart its session, then ask the user. Every collaborator is injected, so the ladder
 * is exercised with fake timers; the durable state lives on the work unit
 * (`apiErrorRecovery`) so each rung is tried once per claim even across turns.
 */
export const WORKER_API_ERROR_RECOVERY_DEFAULTS = {
  nudgeDelayMs: 30000, nudgeTurnMs: 90000, restartDelayMs: 60000, restartTurnMs: 120000
} as const;

/** Slack added to every recovery deadline so the lease sweep never reclaims a claim mid-ladder. */
const DEADLINE_SLACK_MS = 60000;
const RESTFUL_STATES = new Set(['idle', 'done', 'waiting']);

export type WorkerRecoveryTimings = { nudgeDelayMs: number; nudgeTurnMs: number; restartDelayMs: number; restartTurnMs: number };
type Fence = { claimId: string; claimGeneration: number };
type Claim = Fence & { workUnitId: string };
type RestartResult = { ok: true } | { ok: false; reason: string; message?: string };

export interface WorkerApiErrorRecoveryDeps {
  enabled(): boolean;
  findClaim(executionId: string, slotId: string): Promise<Claim | undefined>;
  getRecovery(executionId: string, workUnitId: string): Promise<DurableRecovery | undefined> | DurableRecovery | undefined;
  record(executionId: string, input: RecordWorkerRecoveryInput): Promise<unknown>;
  getAgentState(sessionId: string): string | undefined;
  nudge(sessionId: string, text: string): Promise<unknown> | unknown;
  restart(sessionId: string): Promise<RestartResult>;
  redeliver(executionId: string, workUnitId: string, fence: Fence, sessionId: string, preface: string): Promise<unknown>;
  blockToHuman(executionId: string, workUnitId: string, fence: Fence): Promise<unknown>;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  timings?: WorkerRecoveryTimings;
  log(message: string, error?: unknown): void;
}

interface Session extends Claim {
  executionId: string;
  slotId: string;
  /** In-flight transition: a turn that starts meanwhile is applied when it finishes. */
  busy: boolean;
  turnDuringTransition: boolean;
  restarting: boolean;
  recorded: 'waiting' | 'nudged' | 'restarted';
  timer?: unknown;
  epoch: number;
}

export class WorkerApiErrorRecovery {
  private readonly sessions = new Map<string, Session>();
  private readonly timings: WorkerRecoveryTimings;

  constructor(private readonly deps: WorkerApiErrorRecoveryDeps) {
    this.timings = deps.timings ?? WORKER_API_ERROR_RECOVERY_DEFAULTS;
  }

  async onApiErrorStop(
    sessionId: string, cohort: { executionId: string; slotId: string }, event: { error: string; text: string; retryable?: boolean }
  ): Promise<void> {
    try {
      if (!this.deps.enabled()) return;
      const claim = await this.deps.findClaim(cohort.executionId, cohort.slotId);
      if (!claim) return;
      this.drop(sessionId);
      const s: Session = { ...claim, executionId: cohort.executionId, slotId: cohort.slotId, busy: true, turnDuringTransition: false, restarting: false, recorded: 'waiting', epoch: 1 };
      this.sessions.set(sessionId, s);
      const kind = event.error;
      const base = { errorKind: kind, errorText: event.text };
      if (event.retryable === false) {
        if (await this.record(sessionId, s, { ...base, step: 'waiting', severity: 'warning', summary: `Engineer ${s.slotId} stopped on an API error Zana does not retry (${kind})` })) {
          await this.block(sessionId, s);
        }
        return;
      }
      const recovery = await this.deps.getRecovery(cohort.executionId, claim.workUnitId);
      const steps = recovery && recovery.claimId === claim.claimId && recovery.claimGeneration === claim.claimGeneration
        ? recovery.steps.map((entry) => entry.step) : [];
      const { nudgeDelayMs, nudgeTurnMs, restartDelayMs, restartTurnMs } = this.timings;
      if (steps.includes('restarted')) {
        await this.block(sessionId, s);
      } else if (steps.includes('nudged')) {
        const ok = await this.record(sessionId, s, {
          ...base, step: 'waiting', severity: 'warning', deadlineAt: this.deps.now() + restartDelayMs + restartTurnMs + DEADLINE_SLACK_MS,
          summary: `Engineer ${s.slotId} stopped on another temporary API error (${kind}); Zana will restart it in ${Math.round(restartDelayMs / 1000)} s`
        });
        if (ok) this.arm(sessionId, s, restartDelayMs, () => this.restartStep(sessionId, s.epoch));
      } else {
        const ok = await this.record(sessionId, s, {
          ...base, step: 'waiting', severity: 'warning', detail: event.text,
          deadlineAt: this.deps.now() + nudgeDelayMs + nudgeTurnMs + restartDelayMs + restartTurnMs + DEADLINE_SLACK_MS,
          summary: `Engineer ${s.slotId} stopped on a temporary API error (${kind}); Zana will nudge it in ${Math.round(nudgeDelayMs / 1000)} s`
        });
        if (ok) this.arm(sessionId, s, nudgeDelayMs, () => this.nudgeStep(sessionId, s.epoch));
      }
      if (this.sessions.get(sessionId) === s) s.busy = false;
    } catch (error) {
      this.deps.log(`Worker API-error recovery failed for ${sessionId}`, error);
    }
  }

  onTurnStarted(sessionId: string, priorState: string): void {
    try {
      const s = this.sessions.get(sessionId);
      if (!s || !RESTFUL_STATES.has(priorState)) return;
      if (s.busy) { s.turnDuringTransition = true; return; }
      void this.resume(sessionId, s);
    } catch (error) {
      this.deps.log(`Worker API-error recovery turn handling failed for ${sessionId}`, error);
    }
  }

  /** Drops a session unless its restart is in flight: the restart itself exits the session. */
  forget(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s?.restarting) return;
    this.drop(sessionId);
  }

  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.drop(id);
  }

  private drop(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.epoch += 1;
    if (s.timer !== undefined) this.deps.clearTimer(s.timer);
    this.sessions.delete(sessionId);
  }

  private arm(sessionId: string, s: Session, ms: number, fn: () => Promise<void>): void {
    if (s.timer !== undefined) this.deps.clearTimer(s.timer);
    s.epoch += 1;
    const epoch = s.epoch;
    s.timer = this.deps.setTimer(() => {
      if (this.sessions.get(sessionId) !== s || s.epoch !== epoch) return;
      s.timer = undefined;
      void fn().catch((error) => this.deps.log(`Worker API-error recovery timer failed for ${sessionId}`, error));
    }, ms);
  }

  private async sameFence(s: Session): Promise<boolean> {
    const claim = await this.deps.findClaim(s.executionId, s.slotId);
    return claim?.claimId === s.claimId && claim.claimGeneration === s.claimGeneration && claim.workUnitId === s.workUnitId;
  }

  /** Records one step; false (and the session dropped) when the claim moved on. */
  private async record(
    sessionId: string, s: Session,
    input: Omit<RecordWorkerRecoveryInput, 'workUnitId' | 'claimId' | 'claimGeneration' | 'slotId'>
  ): Promise<boolean> {
    try {
      await this.deps.record(s.executionId, { ...input, workUnitId: s.workUnitId, claimId: s.claimId, claimGeneration: s.claimGeneration, slotId: s.slotId });
      return true;
    } catch (error) {
      if (error instanceof WorkUnitRecoveryGuardError) { this.drop(sessionId); return false; }
      throw error;
    }
  }

  private async block(sessionId: string, s: Session): Promise<void> {
    this.drop(sessionId);
    await this.deps.blockToHuman(s.executionId, s.workUnitId, { claimId: s.claimId, claimGeneration: s.claimGeneration });
  }

  private async resume(sessionId: string, s: Session): Promise<void> {
    this.drop(sessionId);
    try {
      await this.deps.record(s.executionId, {
        workUnitId: s.workUnitId, claimId: s.claimId, claimGeneration: s.claimGeneration, slotId: s.slotId,
        step: 'resumed', severity: 'info', summary: `Engineer ${s.slotId} resumed work unit ${s.workUnitId} after an API error`
      });
    } catch (error) {
      if (!(error instanceof WorkUnitRecoveryGuardError)) this.deps.log(`Worker API-error recovery resume failed for ${sessionId}`, error);
    }
  }

  private live(sessionId: string, epoch: number): Session | undefined {
    const s = this.sessions.get(sessionId);
    return s && s.epoch === epoch ? s : undefined;
  }

  private async nudgeStep(sessionId: string, epoch: number): Promise<void> {
    const s = this.live(sessionId, epoch);
    if (!s) return;
    s.busy = true;
    if (!await this.sameFence(s)) { this.drop(sessionId); return; }
    const state = this.deps.getAgentState(sessionId);
    if (state === undefined || !RESTFUL_STATES.has(state)) { this.drop(sessionId); return; }
    await this.deps.nudge(sessionId, `The previous request failed with a temporary API error. Continue with your current assignment, work unit \`${s.workUnitId}\`.`);
    if (!this.live(sessionId, epoch)) return;
    if (!await this.record(sessionId, s, { step: 'nudged', severity: 'info', summary: `Nudged engineer ${s.slotId} to continue work unit ${s.workUnitId} after an API error` })) return;
    s.recorded = 'nudged';
    s.busy = false;
    if (s.turnDuringTransition) { await this.resume(sessionId, s); return; }
    this.arm(sessionId, s, this.timings.nudgeTurnMs, () => this.restartStep(sessionId, s.epoch));
  }

  private async restartStep(sessionId: string, epoch: number): Promise<void> {
    const s = this.live(sessionId, epoch);
    if (!s) return;
    s.busy = true;
    if (!await this.sameFence(s)) { this.drop(sessionId); return; }
    s.restarting = true;
    let result: RestartResult;
    try { result = await this.deps.restart(sessionId); } finally { s.restarting = false; }
    if (this.sessions.get(sessionId) !== s) return;
    if (!result.ok) {
      if (!await this.record(sessionId, s, { step: 'restart-failed', severity: 'warning', summary: `Could not restart engineer ${s.slotId}: ${result.message ?? result.reason}` })) return;
      if (await this.sameFence(s)) await this.block(sessionId, s); else this.drop(sessionId);
      return;
    }
    if (!await this.record(sessionId, s, { step: 'restarted', severity: 'info', summary: `Restarted engineer ${s.slotId} after an API error and delivered work unit ${s.workUnitId} again` })) return;
    s.recorded = 'restarted';
    await this.deps.redeliver(s.executionId, s.workUnitId, { claimId: s.claimId, claimGeneration: s.claimGeneration }, sessionId,
      'Zana restarted your session after an API error. Continue with this assignment.');
    if (this.sessions.get(sessionId) !== s) return;
    s.busy = false;
    if (s.turnDuringTransition) { await this.resume(sessionId, s); return; }
    this.arm(sessionId, s, this.timings.restartTurnMs, async () => {
      if (await this.sameFence(s)) await this.block(sessionId, s); else this.drop(sessionId);
    });
  }
}
