import { Calendar, LayoutGrid, List, Workflow } from 'lucide-react';
import { useData, useUi, useRunningSchedulerCount } from '../store.js';
import type { AgentsBoardView } from '../store.js';
import { useCompactLayout } from '../hooks/useCompactLayout.js';

/** View switch shared by global and project boards. Desktop persists its choice;
 * phones keep an independent choice for the current app session. */

const OPTIONS: Array<{ view: AgentsBoardView; icon: typeof LayoutGrid; label: string }> = [
  { view: 'board', icon: LayoutGrid, label: 'Board' },
  { view: 'list', icon: List, label: 'List' },
  { view: 'flow', icon: Workflow, label: 'Flow' }
];

/** Canvas is opt-in on phones; switching mobile views leaves desktop alone. */
export function useAgentsBoardView() {
  const preferred = useUi((s) => s.agentsBoardView);
  const compact = useCompactLayout();
  const mobileView = useUi((s) => s.mobileAgentsBoardView);
  const setDesktopView = useUi((s) => s.setAgentsBoardView);
  const setMobileView = useUi((s) => s.setMobileAgentsBoardView);
  return {
    view: compact ? mobileView ?? (preferred === 'flow' ? 'board' : preferred) : preferred,
    compact,
    setView: compact ? setMobileView : setDesktopView
  };
}

export function AgentViewToggle() {
  const { view, compact, setView } = useAgentsBoardView();

  return (
    <div className="agents-view-toggle" role="group" aria-label="Agents view">
      {OPTIONS.map(({ view: v, icon: Icon, label }) => (
        <button
          key={v}
          type="button"
          className={`agents-view-toggle-btn ${view === v ? 'active' : ''}`}
          onClick={() => setView(v)}
          aria-pressed={view === v}
          title={`${compact && v === 'flow' ? 'Canvas' : label} view`}
          aria-label={`${compact && v === 'flow' ? 'Canvas' : label} view`}
        >
          <Icon size={14} />
          {compact && v === 'flow' && <span className="agents-view-toggle-label">Canvas</span>}
        </button>
      ))}
    </div>
  );
}

/** Button title / aria for the Calendar toggle, including a live running count. */
export function scheduledColumnToggleLabel(includeScheduled: boolean, running: number): string {
  const action = includeScheduled ? 'Hide scheduled agents' : 'Show scheduled agents';
  return running > 0 ? `${running} running · ${action}` : action;
}

/**
 * Show/hide scheduled agents on the Agents board (and the matching list/flow
 * groups) — waiting jobs, armed schedules, and currently working/blocked runs.
 * Owns the AppConfig round-trip — same flag as Settings → Agents → Scheduled,
 * so the two stay in lockstep. A gold count badge appears while any scheduled
 * task has a live session, even when the toggle is off.
 */
export function ScheduledColumnToggle() {
  const includeScheduled = useData((s) => s.includeScheduledAgentsInAgentView);
  const setIncludeScheduled = useData((s) => s.setIncludeScheduledAgentsInAgentView);
  const runningSchedules = useRunningSchedulerCount();
  const label = scheduledColumnToggleLabel(includeScheduled, runningSchedules);

  return (
    <div className="agents-view-toggle" role="group" aria-label="Scheduled column">
      <button
        type="button"
        className={`agents-view-toggle-btn ${includeScheduled ? 'active' : ''}`}
        data-testid="agents-board-scheduled-toggle"
        onClick={() => void setIncludeScheduled(!includeScheduled)}
        aria-pressed={includeScheduled}
        title={label}
        aria-label={label}
      >
        <Calendar size={14} />
        {runningSchedules > 0 && (
          <span className="agents-scheduled-toggle-badge nav-badge nav-badge--running" aria-hidden="true">
            {runningSchedules > 99 ? '99+' : runningSchedules}
          </span>
        )}
      </button>
    </div>
  );
}
