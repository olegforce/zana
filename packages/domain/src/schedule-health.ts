/**
 * Pure helpers that interpret scheduled-run history: why a run didn't succeed,
 * whether it is an open problem, and the cross-schedule run query. Shared by the
 * main-process scheduler, the CLI/MCP surfaces and the renderer. Every function
 * is total: malformed input degrades to "no reason" / "not a problem", never a throw.
 */
import type {
  ScheduleRun,
  ScheduleRunOutcome,
  ScheduleRunQuery,
  ScheduleRunReasonCode,
  ScheduleRunRow,
  ScheduledTask
} from './product.js';

export interface ScheduleReasonInfo {
  /** Short chip label. */
  label: string;
  /** Counts as a problem (shows in Problems). */
  problem: boolean;
  /** Eligible for automatic retry when the schedule has a retry policy. */
  autoRetry: boolean;
  /** The user may retry (or "Run now" for missed) from the UI. */
  manualRetry: boolean;
  hint: string;
}

export const SCHEDULE_REASONS: Readonly<Record<ScheduleRunReasonCode, ScheduleReasonInfo>> = {
  'exit-nonzero': { label: 'Exited with an error', problem: true, autoRetry: true, manualRetry: true, hint: 'Open the session to see the output.' },
  'no-report': { label: 'No completion report', problem: true, autoRetry: true, manualRetry: true, hint: 'The run ended without filing a report; the connection may have dropped.' },
  timeout: { label: 'Hit max duration', problem: true, autoRetry: true, manualRetry: true, hint: 'Raise Max duration or split the task.' },
  'subagent-timeout': { label: 'Background agent timed out', problem: true, autoRetry: true, manualRetry: true, hint: 'A background subagent never finished.' },
  'launch-failed': { label: "Couldn't start", problem: true, autoRetry: true, manualRetry: true, hint: 'Check the profile, persona and project path.' },
  'worker-not-started': { label: 'Worker never started', problem: true, autoRetry: true, manualRetry: true, hint: 'Recovery confirmed the worker never started.' },
  'outcome-unknown': { label: 'Outcome not recorded', problem: true, autoRetry: false, manualRetry: true, hint: 'The worker exited but its result was lost.' },
  'project-missing': { label: 'Project missing', problem: true, autoRetry: false, manualRetry: false, hint: 'Re-add the project or move the schedule.' },
  'concurrency-cap': { label: 'Limit reached', problem: true, autoRetry: true, manualRetry: true, hint: 'Too many scheduled runs at once. Raise the limit or choose Queue in Settings → Agents → Scheduled.' },
  'queue-full': { label: 'Queue full', problem: true, autoRetry: true, manualRetry: true, hint: 'The run queue was full.' },
  'missed-asleep': { label: 'Laptop asleep', problem: true, autoRetry: false, manualRetry: true, hint: 'Times passed while the computer slept.' },
  'missed-app-closed': { label: 'Zana closed', problem: true, autoRetry: false, manualRetry: true, hint: "Times passed while Zana wasn't running." },
  overlap: { label: 'Previous run still active', problem: false, autoRetry: false, manualRetry: false, hint: 'The previous run covered this time.' },
  'in-flight': { label: 'Previous launch in progress', problem: false, autoRetry: false, manualRetry: false, hint: 'A launch was already starting.' },
  'squad-failed': { label: 'Squad run failed', problem: true, autoRetry: false, manualRetry: true, hint: 'Open the Squad run to see which work unit failed.' },
  'squad-stopped': { label: 'Squad run stopped', problem: false, autoRetry: false, manualRetry: true, hint: 'The Squad run was stopped before it finished.' }
};

/** Open problems older than this drop out of the Open view. */
export const OPEN_PROBLEM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_SCHEDULE_IDS = 50;

function isReasonCode(value: unknown): value is ScheduleRunReasonCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SCHEDULE_REASONS, value);
}

/** Recovery mode is selected by the presence of `catchUp`; absent = Classic. */
export function isRecoveryMode(task: Pick<ScheduledTask, 'catchUp'>): boolean {
  return !!task && task.catchUp !== undefined && task.catchUp !== null;
}

/**
 * The reason a run didn't succeed: the stamped `reasonCode`, else inferred from
 * the free-text message older versions wrote (so existing history gets reasons
 * without any file rewrite).
 */
export function runReason(run: ScheduleRun): ScheduleRunReasonCode | undefined {
  try {
    if (!run || typeof run !== 'object') return undefined;
    if (isReasonCode(run.reasonCode)) return run.reasonCode;
    const message = typeof run.message === 'string' ? run.message.trim() : '';
    if (message.startsWith('concurrency-cap:')) return 'concurrency-cap';
    if (message.includes('previous run still active')) return 'overlap';
    if (/^exit -?\d+$/.test(message)) return 'exit-nonzero';
    if (message.startsWith('exceeded maximum duration')) return 'timeout';
    if (message.startsWith('exited without filing a schedule_report')) return 'no-report';
    if (message.includes('background subagent timed out')) return 'subagent-timeout';
    if (/^project .* not found$/.test(message)) return 'project-missing';
    if (message === 'Recovery confirmed the worker never started.') return 'worker-not-started';
    if (message === 'Recovery confirmed the worker exited; its outcome was not recorded.') return 'outcome-unknown';
    if (run.result === 'error' && run.launchState === 'failed') return 'launch-failed';
    if (run.result === 'incomplete' && !message) return 'no-report';
    return undefined;
  } catch {
    return undefined;
  }
}

/** Display outcome: `missed` for `missed-*` reasons, else the stored result. */
export function runOutcome(run: ScheduleRun): ScheduleRunOutcome {
  const reason = runReason(run);
  if (reason && reason.startsWith('missed-')) return 'missed';
  return run?.result ?? 'skipped';
}

/** Whether the run counts as a problem (shows in Problems). */
export function isProblemRun(run: ScheduleRun): boolean {
  try {
    if (!run || typeof run !== 'object') return false;
    if (run.launchState === 'pending') return false;
    // Optimistic in-flight record: launched, not finished yet.
    if (run.launchState === 'running' && run.durationMs === undefined && run.result === 'success') return false;
    const reason = runReason(run);
    // A known reason decides; e.g. a Squad run the user stopped is an error
    // record but not a problem.
    if (reason) return SCHEDULE_REASONS[reason].problem;
    return run.result === 'error' || run.result === 'incomplete';
  } catch {
    return false;
  }
}

/** A problem not yet resolved, dismissed or aged out. */
export function isOpenProblem(run: ScheduleRun, nowMs: number): boolean {
  try {
    if (!isProblemRun(run)) return false;
    if (run.resolvedBy || run.dismissedAt) return false;
    const at = Date.parse(run.at);
    if (!Number.isFinite(at)) return false;
    return nowMs - at <= OPEN_PROBLEM_MAX_AGE_MS;
  } catch {
    return false;
  }
}

export function reasonLabel(code: ScheduleRunReasonCode | undefined): string {
  return isReasonCode(code) ? SCHEDULE_REASONS[code].label : '';
}

export function reasonHint(code: ScheduleRunReasonCode | undefined): string {
  return isReasonCode(code) ? SCHEDULE_REASONS[code].hint : '';
}

/** Whether the UI offers Retry (or Run now for missed) on this row. */
export function canManualRetry(row: Pick<ScheduleRunRow, 'manualRetry' | 'open'>): boolean {
  return !!row && row.manualRetry === true && row.open === true;
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.round(limit)));
}

function parseBound(iso: string | undefined): number | undefined {
  if (typeof iso !== 'string') return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Flatten schedule histories into filtered, newest-first rows. Foreign
 * (`external`) rows are skipped. `total` is the matching count before the
 * `limit` cap; `truncated` says rows were dropped.
 */
export function collectRunRows(
  tasks: readonly ScheduledTask[],
  query: ScheduleRunQuery | undefined,
  nowMs: number
): { rows: ScheduleRunRow[]; total: number; truncated: boolean } {
  const q = query ?? {};
  const state = q.state === 'problems' || q.state === 'all' ? q.state : 'open';
  const limit = clampLimit(q.limit);
  const since = parseBound(q.since);
  const until = parseBound(q.until);
  const scheduleIds = Array.isArray(q.scheduleIds) && q.scheduleIds.length > 0
    ? new Set(q.scheduleIds.slice(0, MAX_SCHEDULE_IDS))
    : undefined;
  const outcomes = q.outcomes?.length ? new Set(q.outcomes) : undefined;
  const reasons = q.reasonCodes?.length ? new Set(q.reasonCodes) : undefined;
  const matched: { row: ScheduleRunRow; at: number }[] = [];

  for (const task of tasks ?? []) {
    if (!task || task.external) continue;
    if (scheduleIds && !scheduleIds.has(task.id)) continue;
    if (q.projectId && task.projectId !== q.projectId) continue;
    for (const run of task.status?.runs ?? []) {
      const at = Date.parse(run?.at);
      if (!Number.isFinite(at)) continue;
      if (since !== undefined && at < since) continue;
      if (until !== undefined && at > until) continue;
      const problem = isProblemRun(run);
      const open = isOpenProblem(run, nowMs);
      if (state === 'open' && !open) continue;
      if (state === 'problems' && !problem) continue;
      const outcome = runOutcome(run);
      const reason = runReason(run);
      if (outcomes && !outcomes.has(outcome)) continue;
      if (reasons && (!reason || !reasons.has(reason))) continue;
      matched.push({
        at,
        row: {
          scheduleId: task.id,
          scheduleName: task.name,
          projectId: task.projectId,
          run,
          outcome,
          ...(reason ? { reason } : {}),
          problem,
          open,
          manualRetry: problem && (reason ? SCHEDULE_REASONS[reason].manualRetry : true)
        }
      });
    }
  }
  matched.sort((a, b) => b.at - a.at);
  const rows = matched.slice(0, limit).map((m) => m.row);
  return { rows, total: matched.length, truncated: matched.length > rows.length };
}
