import { useMemo, useState } from 'react';
import { product } from '../../lib/product-client.js';
import { useData, useUi } from '../../store.js';
import type { Project, ScheduledTask, ScheduleRunOutcome, ScheduleRunRef, ScheduleRunRow } from '@zana-ai/zcc-domain/product';
import { canManualRetry, collectRunRows, isRecoveryMode } from '@zana-ai/zcc-domain/schedule-health';
import { RunOutcomeBadge } from './RunOutcomeBadge.js';
import './scheduler-problems.css';

type StateFilter = 'open' | 'problems' | 'all';
type RangeFilter = '24h' | '7d' | 'all';

const OUTCOMES: Array<{ value: ScheduleRunOutcome; label: string }> = [
  { value: 'error', label: 'Error' },
  { value: 'incomplete', label: 'Incomplete' },
  { value: 'missed', label: 'Missed' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'success', label: 'Success' }
];
const RANGE_MS: Record<Exclude<RangeFilter, 'all'>, number> = { '24h': 24 * 3600_000, '7d': 7 * 24 * 3600_000 };
const PAGE_SIZE = 25;
const BATCH = 50;

export interface ProblemsPanelProps {
  tasks: ScheduledTask[];
  projects: ReadonlyMap<string, Project>;
  onOpenSchedule: (taskId: string) => void;
  onOpenSession: (sessionId: string, projectId: string) => void;
  onTurnOnRecovery: () => void;
}

const rowKey = (row: ScheduleRunRow) => `${row.scheduleId}\u0000${row.run.id ?? ''}`;
const refOf = (row: ScheduleRunRow): ScheduleRunRef => ({ scheduleId: row.scheduleId, runId: row.run.id! });
function batches<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += BATCH) out.push(items.slice(i, i + BATCH));
  return out;
}

/** Full-width workbench of run problems, computed from the live schedule list (never over IPC). */
export function ProblemsPanel({ tasks, projects, onOpenSchedule, onOpenSession, onTurnOnRecovery }: ProblemsPanelProps) {
  const terminals = useData((s) => s.terminals);
  const pushToast = useUi((s) => s.pushToast);
  const [state, setState] = useState<StateFilter>('open');
  const [outcomes, setOutcomes] = useState<ScheduleRunOutcome[]>([]);
  const [range, setRange] = useState<RangeFilter>('all');
  const [projectId, setProjectId] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const classicCount = useMemo(() => tasks.filter((t) => !t.external && !isRecoveryMode(t)).length, [tasks]);
  const projectOptions = useMemo(
    () => [...new Set(tasks.map((t) => t.projectId))].map((id) => ({ id, name: projects.get(id)?.name ?? 'Project missing' })),
    [tasks, projects]
  );

  const rows = useMemo(() => {
    const now = Date.now();
    const { rows: found } = collectRunRows(tasks, {
      state,
      ...(outcomes.length ? { outcomes } : {}),
      ...(range !== 'all' ? { since: new Date(now - RANGE_MS[range]).toISOString() } : {}),
      ...(projectId ? { projectId } : {}),
      limit: 500
    }, now);
    const needle = search.trim().toLowerCase();
    return needle ? found.filter((r) => r.scheduleName.toLowerCase().includes(needle)) : found;
  }, [tasks, state, outcomes, range, projectId, search]);

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const retryable = (row: ScheduleRunRow) => !!row.run.id && canManualRetry(row);
  const retryableRows = rows.filter(retryable);
  const selectedRows = rows.filter((r) => !!r.run.id && selected.has(rowKey(r)));
  const selectedRetryable = selectedRows.filter(retryable);
  const selectedOpen = selectedRows.filter((r) => r.open);

  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(0); setSelected(new Set()); };
  const toggleOutcome = (value: ScheduleRunOutcome) =>
    reset(setOutcomes)(outcomes.includes(value) ? outcomes.filter((o) => o !== value) : [...outcomes, value]);
  const isLive = (row: ScheduleRunRow) =>
    !!row.run.sessionId && (terminals[row.projectId] ?? []).some((s) => s.id === row.run.sessionId);

  const doRetry = async (target: ScheduleRunRow[]) => {
    if (target.length === 0 || busy) return;
    setBusy(true);
    let started = 0, queued = 0, failed = 0;
    try {
      for (const chunk of batches(target.map(refOf))) {
        const result = await product.scheduler.retryRuns(chunk);
        if (!result.ok) { failed += chunk.length; continue; }
        for (const r of result.value) {
          if (!r.ok) failed++;
          else if (r.status === 'queued') queued++;
          else started++;
        }
      }
    } finally {
      setBusy(false);
      setSelected(new Set());
    }
    const parts = [started && `${started} started`, queued && `${queued} queued`, failed && `${failed} failed`].filter(Boolean);
    pushToast(parts.join(', ') || 'Nothing to retry', failed > 0 ? 'error' : 'info');
  };

  const doDismiss = async (target: ScheduleRunRow[]) => {
    if (target.length === 0 || busy) return;
    setBusy(true);
    let dismissed = 0, failed = 0;
    try {
      for (const chunk of batches(target.map(refOf))) {
        const result = await product.scheduler.dismissRuns(chunk);
        if (result.ok) dismissed += result.value;
        else failed += chunk.length;
      }
    } finally {
      setBusy(false);
      setSelected(new Set());
    }
    const parts = [dismissed && `${dismissed} dismissed`, failed && `${failed} failed`].filter(Boolean);
    pushToast(parts.join(', ') || 'Nothing to dismiss', failed > 0 ? 'error' : 'info');
  };

  const selectable = visible.filter((r) => !!r.run.id);
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(rowKey(r)));
  const toggleRow = (row: ScheduleRunRow) => {
    const next = new Set(selected);
    if (!next.delete(rowKey(row))) next.add(rowKey(row));
    setSelected(next);
  };
  const toggleAll = () => {
    const next = new Set(selected);
    for (const r of selectable) {
      if (allSelected) next.delete(rowKey(r));
      else next.add(rowKey(r));
    }
    setSelected(next);
  };

  return (
    <section className="problems-workbench problems-workbench--full" role="region" aria-label="Problems">
      {classicCount > 0 && (
        <button type="button" className="problems-classic-link" onClick={onTurnOnRecovery}>
          {classicCount} Classic {classicCount === 1 ? 'schedule' : 'schedules'} · Turn on recovery
        </button>
      )}
      <div className="problems-filters">
        <select aria-label="Show" value={state} onChange={(e) => reset(setState)(e.target.value as StateFilter)}>
          <option value="open">Open</option>
          <option value="problems">All problems</option>
          <option value="all">All runs</option>
        </select>
        <div className="problems-outcomes" role="group" aria-label="Outcome">
          {OUTCOMES.map((o) => (
            <button
              key={o.value}
              type="button"
              className={outcomes.includes(o.value) ? 'active' : ''}
              aria-pressed={outcomes.includes(o.value)}
              onClick={() => toggleOutcome(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
        <select aria-label="Range" value={range} onChange={(e) => reset(setRange)(e.target.value as RangeFilter)}>
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="all">All time</option>
        </select>
        <select aria-label="Project" value={projectId} onChange={(e) => reset(setProjectId)(e.target.value)}>
          <option value="">All projects</option>
          {projectOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input
          type="search"
          aria-label="Search schedules"
          placeholder="Search schedules"
          value={search}
          onChange={(e) => reset(setSearch)(e.target.value)}
        />
      </div>
      <div className="problems-bulk" role="toolbar" aria-label="Bulk actions">
        <button type="button" className="settings-btn" disabled={busy || selectedRetryable.length === 0} onClick={() => void doRetry(selectedRetryable)}>
          Retry selected
        </button>
        <button type="button" className="settings-btn" disabled={busy || retryableRows.length === 0} onClick={() => void doRetry(retryableRows)}>
          Retry all retryable ({retryableRows.length})
        </button>
        <button type="button" className="settings-btn" disabled={busy || selectedOpen.length === 0} onClick={() => void doDismiss(selectedOpen)}>
          Dismiss selected
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="problems-empty">
          {state === 'open' && outcomes.length === 0 && !projectId && !search.trim()
            ? 'No open problems. Self-healing handled everything.'
            : 'No runs match these filters.'}
        </p>
      ) : (
        <div className="problems-table-wrap">
          <table className="problems-table">
            <thead>
              <tr>
                <th><input type="checkbox" aria-label="Select all on this page" checked={allSelected} onChange={toggleAll} /></th>
                <th>When</th><th>Schedule</th><th>Project</th><th>Outcome</th><th>Attempts</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const task = taskById.get(row.scheduleId);
                const attempt = row.run.attempt ?? 1;
                const max = task?.retry ? task.retry.attempts + 1 : undefined;
                const hasId = !!row.run.id;
                return (
                  <tr key={rowKey(row) + row.run.at}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.scheduleName} run`}
                        disabled={!hasId}
                        checked={selected.has(rowKey(row))}
                        onChange={() => toggleRow(row)}
                      />
                    </td>
                    <td><time title={row.run.at}>{new Date(row.run.at).toLocaleString()}</time></td>
                    <td>
                      <button type="button" className="problems-link" onClick={() => onOpenSchedule(row.scheduleId)}>
                        {row.scheduleName}
                      </button>
                    </td>
                    <td>{projects.get(row.projectId)?.name ?? 'Project missing'}</td>
                    <td><RunOutcomeBadge run={row.run} maxAttempts={max} /></td>
                    <td>{max ? `${attempt}/${max}` : attempt}</td>
                    <td className="problems-actions">
                      {retryable(row) && (
                        <button
                          type="button"
                          className="settings-btn"
                          disabled={busy}
                          aria-label={`${row.outcome === 'missed' ? 'Run now' : 'Retry'} ${row.scheduleName} run`}
                          onClick={() => void doRetry([row])}
                        >
                          {row.outcome === 'missed' ? 'Run now' : 'Retry'}
                        </button>
                      )}
                      {isLive(row) && (
                        <button
                          type="button"
                          className="settings-btn"
                          aria-label={`Open session for ${row.scheduleName} run`}
                          onClick={() => onOpenSession(row.run.sessionId!, row.projectId)}
                        >
                          Open session
                        </button>
                      )}
                      {row.open && hasId && (
                        <button
                          type="button"
                          className="settings-btn"
                          disabled={busy}
                          aria-label={`Dismiss ${row.scheduleName} run`}
                          onClick={() => void doDismiss([row])}
                        >
                          Dismiss
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <footer className="schedule-pagination">
        <span role="status">
          {rows.length === 0 ? '0' : `${currentPage * PAGE_SIZE + 1}–${Math.min((currentPage + 1) * PAGE_SIZE, rows.length)}`} of {rows.length} runs
        </span>
        <div>
          <button type="button" className="settings-btn" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button>
          <button type="button" className="settings-btn" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>Next</button>
        </div>
      </footer>
    </section>
  );
}
