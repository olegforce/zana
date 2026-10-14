/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, ScheduledTask, ScheduleRun } from '@zana-ai/zcc-domain/product';

const h = vi.hoisted(() => ({
  terminals: {} as Record<string, Array<{ id: string }>>,
  pushToast: vi.fn(), retryRuns: vi.fn(), dismissRuns: vi.fn()
}));
vi.mock('../../lib/product-client.js', () => ({ product: { scheduler: { retryRuns: h.retryRuns, dismissRuns: h.dismissRuns } } }));
vi.mock('../../store.js', () => ({
  useData: (select: (s: { terminals: typeof h.terminals }) => unknown) => select({ terminals: h.terminals }),
  useUi: (select: (s: { pushToast: typeof h.pushToast }) => unknown) => select({ pushToast: h.pushToast })
}));
import { ProblemsPanel } from './ProblemsPanel.js';

const projects = new Map([['p1', { id: 'p1', name: 'Garden' } as Project], ['p2', { id: 'p2', name: 'Shop' } as Project]]);
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const HOUR = 3600_000;
const make = (id: string, runs: Partial<ScheduleRun>[], over: Partial<ScheduledTask> = {}) => ({
  id, name: id, projectId: 'p1', enabled: true, profile: 'claude', schedule: { every: '1h' }, overlap: 'skip',
  history: { retain: 10 }, createdAt: '', updatedAt: '', catchUp: { mode: 'once' },
  status: { runCount: runs.length, runs }, ...over
}) as unknown as ScheduledTask;
const failed = (id: string, over: Partial<ScheduleRun> = {}): Partial<ScheduleRun> => ({ id, at: ago(HOUR), result: 'error', reasonCode: 'exit-nonzero', ...over });

function mount(tasks: ScheduledTask[]) {
  const props = { tasks, projects, onOpenSchedule: vi.fn(), onOpenSession: vi.fn(), onTurnOnRecovery: vi.fn() };
  render(<ProblemsPanel {...props} />);
  return props;
}
const sel = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement;
const rowCount = () => document.querySelectorAll('tbody tr').length;

beforeEach(() => {
  h.terminals = {};
  h.pushToast.mockReset();
  h.retryRuns.mockReset().mockResolvedValue({ ok: true, value: [] });
  h.dismissRuns.mockReset().mockResolvedValue({ ok: true, value: 0 });
});
afterEach(cleanup);

describe('ProblemsPanel', () => {
  it('is a full-width region and shows the healthy empty state', () => {
    mount([make('ok', [{ id: 'a', at: ago(HOUR), result: 'success' }])]);
    const region = screen.getByRole('region', { name: 'Problems' });
    expect(region.className).toContain('problems-workbench--full');
    expect(screen.getByText('No open problems. Self-healing handled everything.')).toBeTruthy();
  });

  it('lists open problems with schedule, project, outcome and attempts', () => {
    const props = mount([make('Nightly', [failed('r1', { attempt: 2 })], { retry: { attempts: 2, delayMinutes: 5 } })]);
    const row = document.querySelector('tbody tr') as HTMLElement;
    expect(within(row).getByText('Garden')).toBeTruthy();
    expect(within(row).getByText('Error')).toBeTruthy();
    expect(within(row).getByText('2/3')).toBeTruthy();
    expect(row.querySelector('time')!.getAttribute('title')).toMatch(/^\d{4}-/);
    fireEvent.click(within(row).getByRole('button', { name: 'Nightly' }));
    expect(props.onOpenSchedule).toHaveBeenCalledWith('Nightly');
  });

  it('shows every open problem by default, including ones days old (matches the banner count)', () => {
    mount([make('Old', [failed('r1', { at: ago(5 * 24 * HOUR) })]), make('New', [failed('r2')])]);
    expect(sel('Range').value).toBe('all');
    expect(rowCount()).toBe(2);
  });

  it('filters by state, outcome, range, project and search', () => {
    mount([
      make('Err', [failed('e')]),
      make('Missed', [{ id: 'm', at: ago(2 * HOUR), result: 'skipped', reasonCode: 'missed-asleep' }], { projectId: 'p2' }),
      make('Old', [failed('o', { at: ago(3 * 24 * HOUR) })]),
      make('Fine', [{ id: 'f', at: ago(HOUR), result: 'success' }]),
      make('Dismissed', [failed('d', { dismissedAt: ago(1000) })])
    ]);
    expect(rowCount()).toBe(3);
    fireEvent.change(sel('Range'), { target: { value: '7d' } });
    expect(rowCount()).toBe(3);
    fireEvent.change(sel('Range'), { target: { value: '24h' } });
    expect(rowCount()).toBe(2);
    fireEvent.change(sel('Show'), { target: { value: 'problems' } });
    expect(rowCount()).toBe(3);
    fireEvent.change(sel('Show'), { target: { value: 'all' } });
    expect(rowCount()).toBe(4);
    fireEvent.click(within(screen.getByRole('group', { name: 'Outcome' })).getByRole('button', { name: 'Missed' }));
    expect(rowCount()).toBe(1);
    fireEvent.click(within(screen.getByRole('group', { name: 'Outcome' })).getByRole('button', { name: 'Missed' }));
    fireEvent.change(sel('Project'), { target: { value: 'p2' } });
    expect(rowCount()).toBe(1);
    fireEvent.change(sel('Project'), { target: { value: '' } });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search schedules' }), { target: { value: 'ERR' } });
    expect(rowCount()).toBe(1);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search schedules' }), { target: { value: 'nothing' } });
    expect(screen.getByText('No runs match these filters.')).toBeTruthy();
  });

  it('paginates at 25', () => {
    mount([make('Many', Array.from({ length: 30 }, (_, i) => failed(`r${i}`, { at: ago(HOUR + i * 1000) })))]);
    expect(rowCount()).toBe(25);
    expect(screen.getByRole('status').textContent).toBe('1–25 of 30 runs');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(rowCount()).toBe(5);
    expect(screen.getByRole('status').textContent).toBe('26–30 of 30 runs');
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(rowCount()).toBe(25);
  });

  it('retries a row, labels missed rows Run now, and reports the summary', async () => {
    h.retryRuns.mockResolvedValue({ ok: true, value: [{ scheduleId: 'A', runId: 'r1', ok: true, status: 'started' }] });
    mount([make('A', [failed('r1')]), make('B', [{ id: 'm', at: ago(HOUR), result: 'skipped', reasonCode: 'missed-asleep' }])]);
    expect(screen.getByRole('button', { name: 'Run now B run' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry A run' }));
    await vi.waitFor(() => expect(h.pushToast).toHaveBeenCalledWith('1 started', 'info'));
    expect(h.retryRuns).toHaveBeenCalledWith([{ scheduleId: 'A', runId: 'r1' }]);
  });

  it('hides Retry for non-retryable, id-less and closed rows; Dismiss only when open', () => {
    mount([
      make('Overlap', [{ id: 'o', at: ago(HOUR), result: 'error', reasonCode: 'overlap' }]),
      make('NoId', [{ at: ago(HOUR), result: 'error', reasonCode: 'exit-nonzero' }]),
      make('Closed', [failed('c', { dismissedAt: ago(10) })])
    ]);
    fireEvent.change(sel('Show'), { target: { value: 'problems' } });
    expect(screen.queryByRole('button', { name: /Retry Overlap/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Retry NoId/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Dismiss NoId/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Retry Closed/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Dismiss Closed/ })).toBeNull();
    expect((screen.getByRole('checkbox', { name: 'Select NoId run' }) as HTMLInputElement).disabled).toBe(true);
  });

  it('opens a session only while it is still listed', () => {
    h.terminals = { p1: [{ id: 'live' }] };
    const props = mount([make('Live', [failed('a', { sessionId: 'live' })]), make('Gone', [failed('b', { sessionId: 'gone' })])]);
    expect(screen.queryByRole('button', { name: 'Open session for Gone run' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open session for Live run' }));
    expect(props.onOpenSession).toHaveBeenCalledWith('live', 'p1');
  });

  it('dismisses a row and summarises failures', async () => {
    h.dismissRuns.mockResolvedValueOnce({ ok: true, value: 1 }).mockResolvedValueOnce({ ok: false, message: 'x' });
    mount([make('A', [failed('r1')])]);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss A run' }));
    await vi.waitFor(() => expect(h.pushToast).toHaveBeenCalledWith('1 dismissed', 'info'));
    await vi.waitFor(() => expect((screen.getByRole('button', { name: 'Dismiss A run' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss A run' }));
    await vi.waitFor(() => expect(h.pushToast).toHaveBeenCalledWith('1 failed', 'error'));
  });

  it('bulk retries selected and all retryable runs in batches of 50, summarising mixed results', async () => {
    const runs = Array.from({ length: 120 }, (_, i) => failed(`r${i}`, { at: ago(HOUR + i * 1000) }));
    h.retryRuns.mockImplementation(async (refs: Array<{ runId: string }>) => ({
      ok: true,
      value: refs.map((r, i) => ({ scheduleId: 'Big', runId: r.runId, ok: i % 10 !== 0, status: i % 2 ? 'queued' : 'started' }))
    }));
    mount([make('Big', runs)]);
    expect((screen.getByRole('button', { name: 'Retry selected' }) as HTMLButtonElement).disabled).toBe(true);
    // Raise the limit so 120 rows are all listed (500 cap, paged at 25).
    fireEvent.click(screen.getByRole('button', { name: 'Retry all retryable (120)' }));
    await vi.waitFor(() => expect(h.retryRuns).toHaveBeenCalledTimes(3));
    expect(h.retryRuns.mock.calls.map((c) => c[0].length)).toEqual([50, 50, 20]);
    const [message, kind] = h.pushToast.mock.calls[0]!;
    expect(message).toMatch(/^\d+ started, \d+ queued, 12 failed$/);
    expect(kind).toBe('error');
  });

  it('retries and dismisses only the selected rows, counting failed batches', async () => {
    h.retryRuns.mockResolvedValue({ ok: false, message: 'nope' });
    mount([make('A', [failed('r1')]), make('B', [failed('r2')])]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select A run' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry selected' }));
    await vi.waitFor(() => expect(h.pushToast).toHaveBeenCalledWith('1 failed', 'error'));
    expect(h.retryRuns).toHaveBeenCalledWith([{ scheduleId: 'A', runId: 'r1' }]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all on this page' }));
    h.dismissRuns.mockResolvedValue({ ok: true, value: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss selected' }));
    await vi.waitFor(() => expect(h.pushToast).toHaveBeenCalledWith('2 dismissed', 'info'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all on this page' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all on this page' }));
  });

  it('offers Turn on recovery only when Classic schedules exist', () => {
    const props = mount([make('Classic', [], { catchUp: undefined }), make('Ext', [], { external: { kind: 'claude-loop' } as ScheduledTask['external'], catchUp: undefined })]);
    fireEvent.click(screen.getByRole('button', { name: '1 Classic schedule · Turn on recovery' }));
    expect(props.onTurnOnRecovery).toHaveBeenCalledOnce();
    cleanup();
    mount([make('Recovery', [])]);
    expect(screen.queryByText(/Turn on recovery/)).toBeNull();
  });
});
