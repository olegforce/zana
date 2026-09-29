import { useState, type ReactNode, type RefObject } from 'react';
import { ChevronDown, FileText, GitCompare, Info, ListTodo, Plus, Search, X } from 'lucide-react';
import { activeClosableTab, activePinnedView, type ThreadSecondaryPanelState } from './threadSecondaryPanelState.js';

export function MobilePanelNavigation({ state, open, toggleRef, onToggle, showInfoPin, showDiffPin, showPlanPin,
  onSelectInfo, onSelectDiff, onSelectPlan, onActivateTab, onCloseTab, onNewTab, onHide }: {
  state: ThreadSecondaryPanelState;
  open: boolean;
  toggleRef: RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
  showInfoPin: boolean;
  showDiffPin?: boolean;
  showPlanPin?: boolean;
  onSelectInfo: () => void;
  onSelectDiff: () => void;
  onSelectPlan?: () => void;
  onActivateTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
  onHide: () => void;
}) {
  const [query, setQuery] = useState('');
  const pin = activePinnedView(state);
  const tab = activeClosableTab(state);
  const pinned = [
    { id: 'info', label: 'Overview', icon: Info, visible: showInfoPin, run: onSelectInfo, testId: 'thread-info-pin' },
    { id: 'diff', label: 'Changes', icon: GitCompare, visible: showDiffPin, run: onSelectDiff, testId: 'thread-diff-pin' },
    { id: 'plan', label: 'Plan', icon: ListTodo, visible: showPlanPin, run: onSelectPlan, testId: 'thread-plan-pin' }
  ].filter((item) => item.visible);
  const title = tab ? (tab.kind === 'new-tab' ? 'Tools & files' : tab.title) : pinned.find((item) => item.id === pin)?.label ?? 'Agent panel';
  const matches = (label: string) => label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const tabs = state.tabs.filter((item) => matches(item.title));
  const views = pinned.filter((item) => matches(item.label));
  const choose = (run: (() => void) | undefined) => { setQuery(''); onToggle(); run?.(); };
  const viewButton = (label: string, icon: ReactNode, active: boolean, run: () => void, testId?: string) => (
    <button type="button" aria-pressed={active} onClick={run} data-testid={testId}>
      {icon}<span>{label}</span>
    </button>
  );

  return <>
    <div className="mobile-panel-header" data-testid="thread-secondary-chrome">
      <button ref={toggleRef} className="mobile-panel-view-toggle" type="button" aria-label="Choose panel view"
        aria-expanded={open} aria-controls={open ? 'mobile-panel-views' : undefined} onClick={() => { setQuery(''); onToggle(); }}>
        <span>{open ? 'Panel views' : title}</span><ChevronDown size={18} aria-hidden="true" />
      </button>
      <button type="button" className="mobile-panel-tools" aria-label="New tab" data-testid="thread-secondary-new-tab"
        onClick={() => { if (open) onToggle(); onNewTab(); }}><Plus size={20} aria-hidden="true" /><span>Tools</span></button>
      <button type="button" className="mobile-panel-close" aria-label="Close panel" data-testid="thread-secondary-hide" onClick={onHide}>
        <X size={22} aria-hidden="true" />
      </button>
    </div>
    {open && <nav id="mobile-panel-views" className="mobile-panel-views" aria-label="Panel views">
      <label className="mobile-panel-search"><Search size={18} aria-hidden="true" />
        <input type="search" aria-label="Search panel views" placeholder="Search views and open tabs" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <div className="mobile-panel-view-grid">
        {views.map(({ id, label, icon: Icon, run, testId }) => <div key={id}>
          {viewButton(label, <Icon size={24} aria-hidden="true" />, pin === id, () => choose(run), testId)}
        </div>)}
      </div>
      {tabs.length > 0 && <section aria-label="Open tabs"><h2>Open tabs</h2>
        <div className="mobile-panel-open-tabs">{tabs.map((item) => <div key={item.id}>
          {viewButton(item.title, <FileText size={20} aria-hidden="true" />, tab?.id === item.id, () => choose(() => onActivateTab(item.id)))}
          <button type="button" aria-label={`Close ${item.title}`} onClick={() => { onCloseTab(item.id); toggleRef.current?.focus(); }}><X size={18} aria-hidden="true" /></button>
        </div>)}</div>
      </section>}
      {views.length === 0 && tabs.length === 0 && <p role="status">No matching views or tabs.</p>}
    </nav>}
  </>;
}
