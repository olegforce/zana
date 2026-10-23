import { realpathSync } from 'node:fs';
import type {
  CreateTerminalRequest,
  Project,
  Result,
  TeamCoordinationMode,
  TerminalSession
} from '@zana-ai/zcc-domain/product';
import type { RestoreCapability } from '@zana-ai/zcc-server/services/launch/restore-capability-store';
import { isWithinRetainedSquadWorktreeBase } from './inbox-actions/squad-instruct.js';
import {
  restoreCapabilityLaunch,
  type CapabilityReservations,
  type FollowUpClaimOps,
  type RestoreLaunchInput,
  type RestoreLaunchPrincipal
} from './terminal-restore-launch.js';

export type SquadWorkerRestartResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'not-found' | 'not-a-worker' | 'remote' | 'no-capability' | 'busy' | 'exit-timeout' | 'relaunch-failed';
      message?: string;
    };

/** The slice of an execution record a restart needs. */
export interface RestartExecutionRecord {
  squadWorktree?: { path: string; branch: string };
  coordinationMode?: TeamCoordinationMode;
}

export interface SquadWorkerRestartDeps {
  getSession(sessionId: string): TerminalSession | undefined;
  getProject(projectId: string): Pick<Project, 'path' | 'remote'> | undefined;
  getExecution(projectId: string, executionId: string): Promise<RestartExecutionRecord | undefined>;
  teamLaunchEnabled(): boolean;
  restoreCapabilities: CapabilityReservations & {
    reserve(id: string): { capability: RestoreCapability; reservationId: string } | undefined;
  };
  followUp: FollowUpClaimOps;
  restorePrincipal(capability: RestoreCapability): RestoreLaunchPrincipal;
  isTeamWorkerRestore(request: CreateTerminalRequest): boolean;
  launchAuthorizedTerminal(
    request: CreateTerminalRequest,
    principal: RestoreLaunchPrincipal,
    spawnOpts: Record<string, unknown>,
    teamId?: string,
    ...rest: unknown[]
  ): Promise<Result<TerminalSession>>;
  /** Expected close plus tmux kill, without dropping the restore capability. */
  closeSession(sessionId: string): Promise<unknown>;
  /** Runs after a successful relaunch, once the exit listener has already cleaned up. */
  onRelaunched(session: TerminalSession): void;
  exitTimeoutMs?: number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

const DEFAULT_EXIT_TIMEOUT_MS = 10_000;

/** Same rule as the team launch: autonomous teams, or freeform with the team-launch setting on. */
export function squadWorkerAutonomous(mode: TeamCoordinationMode, teamLaunchEnabled: boolean): boolean {
  return mode === 'autonomous-team' || (mode === 'freeform' && teamLaunchEnabled);
}

/** Same rule as the team launch: durable modes suppress the persona's typed-in initial prompt. */
export function squadWorkerDurableCoordination(mode: TeamCoordinationMode): boolean {
  return mode === 'job-team' || mode === 'structured' || mode === 'freeform';
}

function fail(code: string, message: string): Result<never> {
  return { ok: false, code, message } as Result<never>;
}

/** Relaunch one Squad worker through its restore capability, back in its Squad worktree. */
export async function relaunchSquadWorker(
  deps: SquadWorkerRestartDeps,
  session: TerminalSession
): Promise<Result<TerminalSession>> {
  const reserved = session.restoreCapabilityId
    ? deps.restoreCapabilities.reserve(session.restoreCapabilityId)
    : undefined;
  if (!reserved) return fail('DENIED', 'restore capability unavailable or already reserved');
  const executionId = session.cohort?.executionId;
  const executionLookup = executionId
    ? () => deps.getExecution(session.projectId, executionId)
    : async () => undefined;

  return restoreCapabilityLaunch({
    capability: reserved.capability,
    reservationId: reserved.reservationId,
    reservations: deps.restoreCapabilities,
    followUp: deps.followUp,
    restorePrincipal: (capability) => deps.restorePrincipal(capability),
    isTeamWorkerRestore: (request) => deps.isTeamWorkerRestore(request),
    resolveWorktree: async (request) => {
      try {
        const record = await executionLookup();
        if (!record?.squadWorktree) return { ok: true, value: request };
        const project = deps.getProject(session.projectId);
        if (!project || project.remote) throw new Error('project unavailable');
        const root = realpathSync(project.path);
        const path = realpathSync(record.squadWorktree.path);
        if (!isWithinRetainedSquadWorktreeBase(path, root)) throw new Error('squad worktree is outside the project');
        return { ok: true, value: { ...request, worktreeInfo: { path, branch: record.squadWorktree.branch } } };
      } catch (error) {
        return fail('WORKTREE_UNAVAILABLE', `squad worktree unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    launch: async (input: RestoreLaunchInput) => {
      const record = await executionLookup().catch(() => undefined);
      const coordinationMode = record?.coordinationMode ?? session.cohort?.coordinationMode ?? 'interactive-team';
      return deps.launchAuthorizedTerminal(
        input.request,
        input.principal,
        {
          ...input.spawnOpts,
          coordinationMode,
          autonomous: squadWorkerAutonomous(coordinationMode, deps.teamLaunchEnabled()),
          suppressPersonaInitialPrompt: squadWorkerDurableCoordination(coordinationMode),
          tabNamerPrompt: null
        },
        input.teamId,
        undefined,
        undefined,
        undefined,
        undefined,
        input.legacyPersonaFacetCompatibility,
        undefined,
        input.followUpExecutionId
      );
    }
  });
}

interface PendingRestart {
  session: TerminalSession;
  finalizeExit?: () => Promise<void>;
  exitTimer?: unknown;
  relaunchTimer?: unknown;
  settle(result: SquadWorkerRestartResult): void;
}

export function createSquadWorkerRestarter(deps: SquadWorkerRestartDeps) {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
  const exitTimeoutMs = deps.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS;
  const pending = new Map<string, PendingRestart>();

  function refusal(sessionId: string): SquadWorkerRestartResult | undefined {
    const session = deps.getSession(sessionId);
    if (!session || session.status === 'exited') return { ok: false, reason: 'not-found' };
    const cohort = session.cohort;
    if (cohort?.role !== 'worker' || !cohort.executionId || !cohort.slotId) return { ok: false, reason: 'not-a-worker' };
    if (session.remoteTmuxId || deps.getProject(session.projectId)?.remote) return { ok: false, reason: 'remote' };
    if (session.workspaceEnvironmentId || (session.environment && session.environment !== 'local')) {
      return { ok: false, reason: 'remote', message: 'session runs in a managed environment' };
    }
    if (!session.restoreCapabilityId) return { ok: false, reason: 'no-capability' };
    if (pending.has(sessionId)) return { ok: false, reason: 'busy' };
    return undefined;
  }

  async function runRelaunch(sessionId: string, entry: PendingRestart): Promise<void> {
    let message: string | undefined;
    try {
      const result = await relaunchSquadWorker(deps, entry.session);
      if (result.ok) {
        pending.delete(sessionId);
        entry.finalizeExit = undefined;
        deps.onRelaunched(entry.session);
        entry.settle({ ok: true });
        return;
      }
      message = `${result.code}: ${result.message}`;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    pending.delete(sessionId);
    const finalize = entry.finalizeExit;
    entry.finalizeExit = undefined;
    // The engine must learn the worker is gone when the relaunch did not happen.
    await finalize?.().catch(() => undefined);
    entry.settle({ ok: false, reason: 'relaunch-failed', message });
  }

  return {
    async restart(sessionId: string): Promise<SquadWorkerRestartResult> {
      const refused = refusal(sessionId);
      if (refused) return refused;
      const session = deps.getSession(sessionId)!;
      return new Promise<SquadWorkerRestartResult>((resolve) => {
        const entry: PendingRestart = {
          session,
          settle: (result) => {
            if (entry.exitTimer !== undefined) clearTimer(entry.exitTimer);
            if (entry.relaunchTimer !== undefined) clearTimer(entry.relaunchTimer);
            resolve(result);
          }
        };
        pending.set(sessionId, entry);
        entry.exitTimer = setTimer(() => {
          if (pending.get(sessionId) !== entry || entry.relaunchTimer !== undefined) return;
          pending.delete(sessionId);
          entry.settle({ ok: false, reason: 'exit-timeout' });
        }, exitTimeoutMs);
        Promise.resolve()
          .then(() => deps.closeSession(sessionId))
          .catch((error) => {
            if (pending.get(sessionId) !== entry) return;
            pending.delete(sessionId);
            entry.settle({
              ok: false,
              reason: 'relaunch-failed',
              message: error instanceof Error ? error.message : String(error)
            });
          });
      });
    },

    onSessionExit(sessionId: string, finalizeExit: () => Promise<void>): void {
      const entry = pending.get(sessionId);
      if (!entry) {
        void finalizeExit();
        return;
      }
      if (entry.exitTimer !== undefined) clearTimer(entry.exitTimer);
      entry.finalizeExit = finalizeExit;
      // Let the rest of the exit listener (refreshRestoreCapability included) run first.
      entry.relaunchTimer = setTimer(() => void runRelaunch(sessionId, entry), 0);
    },

    isRestarting(sessionId: string): boolean {
      return pending.has(sessionId);
    },

    dispose(): void {
      for (const [sessionId, entry] of [...pending]) {
        pending.delete(sessionId);
        entry.finalizeExit = undefined;
        entry.settle({ ok: false, reason: 'relaunch-failed', message: 'disposed' });
      }
    }
  };
}

export type SquadWorkerRestarter = ReturnType<typeof createSquadWorkerRestarter>;
