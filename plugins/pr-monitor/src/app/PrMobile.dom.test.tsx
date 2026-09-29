/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PrMobileList, PrMobileToolbar, usePrCompactLayout } from './PrMobile.js';
import { PrTileList, type SortDir, type SortField } from './PrTileList.js';
import PrMonitorPanel from './PrMonitorPanel.js';
import { DEFAULT_PR_MONITOR_SETTINGS, type MonitoredPr, type PrRollupStatus } from '../../lib/types.js';
import type { ModuleHost } from './host.js';

let compact = true;
const listeners = new Set<() => void>();
beforeEach(() => {
  compact = true;
  vi.spyOn(window, 'matchMedia').mockImplementation(() => ({
    get matches() { return compact; },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }) as unknown as MediaQueryList);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); listeners.clear(); });
const NOW = Date.now();
function pr(overrides: Partial<MonitoredPr> = {}): MonitoredPr {
  return { url: 'https://github.com/acme/app/pull/1', repo: 'acme/app', number: 1, title: 'Fix the mobile layout', status: 'failed', checks: [], addedAt: NOW, lastChecked: NOW, lastStatusChange: NOW, lastSeenAt: 0, ...overrides };
}
function host(prs: MonitoredPr[] = [pr()]) {
  const storage = new Map<string, unknown>([['settings', { ...DEFAULT_PR_MONITOR_SETTINGS, autoSyncEnabled: false, authorDiscovered: true, orgDiscovered: true }], ['listView', 'board']]);
  const cache = new Map<string, unknown>();
  return {
    call: vi.fn(async (method: string) => method === 'listPrs' ? prs : method === 'listRepos' ? { ok: true, repos: [] } : { ok: true, prs }),
    storage: { get: vi.fn(async (key: string) => storage.get(key)), set: vi.fn(async (key: string, value: unknown) => { storage.set(key, value); }) },
    cache: { get: (key: string) => cache.get(key), set: (key: string, value: unknown) => cache.set(key, value), refreshBadge: vi.fn() },
    listProjects: () => [], getScopedProjectId: () => null, on: () => () => {}, openExternal: vi.fn(), toast: vi.fn(),
  } as unknown as ModuleHost;
}
function Toolbar() {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | PrRollupStatus>('all');
  const [hosts, setHosts] = useState<string[]>([]);
  const [sort, setSort] = useState<SortField>('status');
  const [dir, setDir] = useState<SortDir>('asc');
  return <PrMobileToolbar query={query} onQuery={setQuery} status={status} onStatus={setStatus}
    statuses={[{ id: 'failed', count: 1 }]} hosts={['github.com', 'git.example.com']} hostScope={hosts} onHostScope={setHosts}
    sortField={sort} sortDir={dir} onSort={(field, direction) => { setSort(field); setDir(direction); }}
    sortFields={[{ id: 'status', label: 'Status' }, { id: 'favorites', label: 'Favorites first' }]} shownCount={status === 'all' ? 2 : 1} />;
}

describe('mobile PR flow', () => {
  it('subscribes to layout changes and releases listeners on unmount', () => {
    function Layout() { return <span>{usePrCompactLayout() ? 'mobile' : 'desktop'}</span>; }
    const view = render(<Layout />);
    expect(screen.getByText('mobile')).toBeTruthy();
    act(() => { compact = false; listeners.forEach((listener) => listener()); });
    expect(screen.getByText('desktop')).toBeTruthy();
    view.unmount();
    expect(listeners.size).toBe(0);
    // Missing matchMedia is a desktop fallback (e.g. non-browser consumers).
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined });
    render(<Layout />);
    expect(screen.getByText('desktop')).toBeTruthy();
  });

  it('keeps query, status, sorting and host filters accessible with a close/return path', () => {
    render(<Toolbar />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'mobile' } });
    const trigger = screen.getByRole('button', { name: 'Filters' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'failed' } });
    fireEvent.change(screen.getByLabelText('Order'), { target: { value: 'desc' } });
    expect((screen.getByLabelText('Order') as HTMLSelectElement).value).toBe('desc');
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'favorites' } });
    expect((screen.getByLabelText('Order') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('github.com'));
    expect((screen.getByLabelText('github.com') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText('github.com'));
    expect((screen.getByLabelText('github.com') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByLabelText('git.example.com'));
    fireEvent.click(screen.getByRole('button', { name: 'All hosts' }));
    expect((screen.getByLabelText('git.example.com') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 pull request' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('mobile');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('2 pull requests')).toBeTruthy();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Close PR filters' }));
    fireEvent.click(trigger);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows repository, status, draft, author, unread/favorite and sync errors without nested actions', () => {
    const open = vi.fn();
    const first = pr({ favorite: true, isDraft: true, author: { login: 'alex', name: 'Alex' }, syncError: 'Offline' });
    const second = pr({ url: 'https://git.example.com/app/pull/2', number: 2, title: 'Second', author: { login: 'sam' }, lastSeenAt: NOW + 1, updatedAt: NOW });
    const third = pr({ url: 'https://github.com/acme/app/pull/3', number: 3, title: 'Third', lastSeenAt: undefined, lastChecked: 0 });
    const { container } = render(<PrMobileList prs={[first, second, third]} onOpen={open} />);
    expect(screen.getByLabelText('Favorite')).toBeTruthy();
    expect(screen.getByText('Draft')).toBeTruthy();
    expect(screen.getByText('Alex')).toBeTruthy();
    expect(screen.getByText('sam')).toBeTruthy();
    expect(screen.getByText('Sync failed · Open for details')).toBeTruthy();
    expect(container.querySelectorAll('.is-unread').length).toBe(1);
    expect(container.querySelector('button button')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Fix the mobile layout/ }));
    expect(open).toHaveBeenCalledWith(first);
  });

  it('opens details, marks only unread PRs seen, and restores the desktop board without saving a new preference', async () => {
    const service = host();
    const prs = [pr(), pr({ url: 'https://github.com/acme/app/pull/2', number: 2, title: 'Read PR', status: 'green', lastSeenAt: NOW + 1 })];
    const changeView = vi.fn();
    render(<PrTileList prs={prs} host={service} projects={[]} viewMode="board" onViewModeChange={changeView}
      sortField="status" sortDir="asc" onSortChange={vi.fn()} hostScope={[]} onHostScopeChange={vi.fn()}
      awaitingFirstSync={false} syncing={false} autoSyncEnabled={false} onDismiss={vi.fn()} onProjectAssign={vi.fn()}
      onBulkSetSeen={vi.fn()} onBulkDismiss={vi.fn()} onBulkSetFavorite={vi.fn()} />);
    await act(async () => {});
    const card = screen.getByRole('button', { name: /Fix the mobile layout/ });
    card.focus(); fireEvent.click(card);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(service.call).toHaveBeenCalledWith('markPrAsSeen', { url: prs[0].url });
    fireEvent.click(screen.getByRole('button', { name: 'Close PR details' }));
    expect(document.activeElement).toBe(card);
    fireEvent.click(screen.getByRole('button', { name: /Read PR/ }));
    expect(vi.mocked(service.call).mock.calls.filter(([name]) => name === 'markPrAsSeen')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close PR details' }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing-title' } });
    expect(screen.getByText('No PRs match the current filter')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'failed' } });
    expect(document.querySelectorAll('.prm-mobile-card')).toHaveLength(1);
    act(() => { compact = false; listeners.forEach((listener) => listener()); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelectorAll('.prm-board-card')).toHaveLength(2);
    expect(changeView).not.toHaveBeenCalled();
    expect(service.storage.set).not.toHaveBeenCalled();
  });

  it('keeps mobile Sync busy until completion and surfaces a failed refresh', async () => {
    const service = host();
    render(<PrMonitorPanel host={service} />);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Sync pull requests' }) as HTMLButtonElement).disabled).toBe(false));
    const sync = screen.getByRole('button', { name: 'Sync pull requests' });
    let finish!: (value: unknown) => void;
    vi.mocked(service.call).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(sync);
    expect((sync as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish({ ok: true, prs: [pr()], deltas: [] }));
    await waitFor(() => expect((sync as HTMLButtonElement).disabled).toBe(false));
    vi.mocked(service.call).mockRejectedValueOnce(new Error('Connection unavailable'));
    fireEvent.click(sync);
    await waitFor(() => expect(screen.getByText('Connection unavailable')).toBeTruthy());
    expect((sync as HTMLButtonElement).disabled).toBe(false);
  });

  it('puts secondary header actions in a sheet and closes it before Add PR or Settings', async () => {
    const service = host();
    render(<PrMonitorPanel host={service} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'PR Monitor actions' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'PR Monitor actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add PR' }));
    expect(screen.queryByRole('dialog', { name: 'PR Monitor actions' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'PR Monitor actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Settings', exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'PRs' }));
    expect(screen.getByRole('heading', { name: 'PR Monitor', exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'PR Monitor actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close PR actions' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
