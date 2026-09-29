import { useState, useSyncExternalStore } from 'react';
import { AlertCircle, Folder, Search, SlidersHorizontal, Star } from 'lucide-react';
import type { MonitoredPr, PrRollupStatus } from '../../lib/types.js';
import type { SortDir, SortField } from './PrTileList.js';
import { formatRelative, statusLabel, statusPill } from './formatHelpers.js';
import { Dialog } from './Dialog.js';

const compactQuery = '(max-width: 1024px)';
function subscribeCompact(onChange: () => void) {
  const media = window.matchMedia?.(compactQuery);
  media?.addEventListener('change', onChange);
  return () => media?.removeEventListener('change', onChange);
}
export function usePrCompactLayout() {
  return useSyncExternalStore(subscribeCompact, () => window.matchMedia?.(compactQuery).matches ?? false, () => false);
}

export function PrMobileToolbar({ query, onQuery, status, onStatus, statuses, hosts, hostScope, onHostScope,
  sortField, sortDir, onSort, sortFields, shownCount,
}: {
  query: string; onQuery: (value: string) => void;
  status: 'all' | PrRollupStatus; onStatus: (value: 'all' | PrRollupStatus) => void;
  statuses: { id: PrRollupStatus; count: number }[];
  hosts: string[]; hostScope: string[]; onHostScope: (hosts: string[]) => void;
  sortField: SortField; sortDir: SortDir; onSort: (field: SortField, dir: SortDir) => void;
  sortFields: { id: SortField; label: string }[]; shownCount: number;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtered = status !== 'all' || hostScope.length > 0;
  return <>
    <div className="prm-mobile-toolbar">
      <div className="prm-search">
        <Search size={18} aria-hidden />
        <input type="search" className="prm-search-input" placeholder="Search PRs…" aria-label="Search PRs"
          value={query} onChange={(event) => onQuery(event.target.value)} />
      </div>
      <button type="button" className={`prm-btn${filtered ? ' is-active' : ''}`} aria-haspopup="dialog"
        aria-expanded={filtersOpen} onClick={() => setFiltersOpen(true)}>
        <SlidersHorizontal size={18} aria-hidden /> Filters{filtered && <span className="prm-mobile-filter-dot" />}
      </button>
    </div>
    <div className="prm-mobile-summary" aria-live="polite">
      <span>{shownCount} pull request{shownCount === 1 ? '' : 's'}{status !== 'all' && ` · ${statusLabel(status)}`}</span>
      {filtered && <button type="button" className="prm-text-btn" onClick={() => { onStatus('all'); onHostScope([]); }}>Clear filters</button>}
    </div>
    {filtersOpen && <Dialog title="Filter pull requests" closeLabel="Close PR filters" onClose={() => setFiltersOpen(false)}
      footer={<footer className="prm-modal-footer"><button type="button" className="prm-btn prm-btn--primary" onClick={() => setFiltersOpen(false)}>Show {shownCount} pull request{shownCount === 1 ? '' : 's'}</button></footer>}>
      <div className="prm-modal-body prm-mobile-filters">
        <label className="prm-field">Status
          <select aria-label="Status" className="prm-input" value={status} onChange={(event) => onStatus(event.target.value as typeof status)}>
            <option value="all">All statuses</option>
            {statuses.map(({ id, count }) => <option key={id} value={id}>{statusLabel(id)} ({count})</option>)}
          </select>
        </label>
        <label className="prm-field">Sort by
          <select aria-label="Sort by" className="prm-input" value={sortField} onChange={(event) => onSort(event.target.value as SortField, sortDir)}>
            {sortFields.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <label className="prm-field">Order
          <select aria-label="Order" className="prm-input" value={sortDir} disabled={sortField === 'favorites'} onChange={(event) => onSort(sortField, event.target.value as SortDir)}>
            <option value="asc">Ascending</option><option value="desc">Descending</option>
          </select>
        </label>
        <fieldset className="prm-mobile-hosts"><legend>Git hosts</legend>
          <button type="button" className="prm-btn" aria-pressed={hostScope.length === 0} onClick={() => onHostScope([])}>All hosts</button>
          {hosts.map((host) => <label key={host}>
            <input type="checkbox" checked={hostScope.includes(host)} onChange={() => onHostScope(hostScope.includes(host) ? hostScope.filter((value) => value !== host) : [...hostScope, host])} />{host}
          </label>)}
        </fieldset>
      </div>
    </Dialog>}
  </>;
}

export function PrMobileList({ prs, onOpen }: { prs: MonitoredPr[]; onOpen: (pr: MonitoredPr) => void }) {
  return <div className="prm-mobile-list">
    {prs.map((pr) => {
      const unread = pr.lastSeenAt === 0 || pr.lastStatusChange > (pr.lastSeenAt ?? pr.addedAt);
      const pill = statusPill(pr.status);
      return <button type="button" key={pr.url} className={`prm-mobile-card${unread ? ' is-unread' : ''}`} onClick={() => onOpen(pr)}>
        <span className="prm-mobile-card-repo"><Folder size={14} aria-hidden /><span>{pr.repo}</span><span>#{pr.number}</span>{pr.favorite && <Star size={14} fill="currentColor" aria-label="Favorite" />}</span>
        <span className="prm-mobile-card-title">{pr.title}</span>
        <span className="prm-mobile-card-meta"><span className={`prm-status-pill ${pill.className}`}>{pill.label}</span>{pr.isDraft && <span>Draft</span>}
          {pr.author && <span className="prm-mobile-author">{pr.author.name || pr.author.login}</span>}
          <span className="prm-mobile-card-time">{formatRelative(pr.updatedAt || pr.lastChecked || pr.lastStatusChange)}</span>
        </span>
        {pr.syncError && <span className="prm-mobile-sync-error"><AlertCircle size={14} aria-hidden />Sync failed · Open for details</span>}
      </button>;
    })}
  </div>;
}
