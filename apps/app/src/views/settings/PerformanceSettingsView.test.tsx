// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PerformanceState } from './use-performance.js';
import { PerformanceSettingsView } from './PerformanceSettingsView.js';

const mocks = vi.hoisted(() => ({ hosts: vi.fn(), state: vi.fn(), desktop: vi.fn(), refresh: vi.fn(), copy: vi.fn() }));
vi.mock('../../hooks/useHosts.js', () => ({ useHosts: mocks.hosts }));
vi.mock('./use-performance.js', () => ({ usePerformance: mocks.state }));
vi.mock('../../lib/app-surface.js', () => ({ hasDesktopBridge: mocks.desktop }));
vi.mock('../../lib/copy-text.js', () => ({ copyText: mocks.copy }));
vi.mock('../../store.js', () => ({ useData: (selector: (s: unknown) => unknown) => selector({ projects: [{ id: 'project', name: 'Example project' }] }) }));
let state: PerformanceState;
const renderView = () => render(<MemoryRouter><PerformanceSettingsView /></MemoryRouter>);
beforeEach(() => {
  mocks.hosts.mockReturnValue([{ id: 'a', name: 'This Mac', isPrimary: true, status: 'connected' }, { id: 'b', name: 'Remote', status: 'disconnected' }]);
  mocks.desktop.mockReturnValue(true);
  state = {
    hostId: 'a', now: 100_000, refreshing: false, error: null, resourceError: null,
    resources: { hostId: 'a', sampledAt: 100_000, processes: [
      { role: 'daemon', pid: 10, createdAt: 10_000, cpuPercent: 3.2, memoryBytes: 1024 ** 2 * 64 },
      { role: 'server', pid: 11, createdAt: 10_000, cpuPercent: 8.4, memoryBytes: 1024 ** 2 * 128 }
    ] },
    history: [], workloadHistory: [], summary: { hostId: 'a', sampledAt: 100_000, connected: true, connectedAt: 50_000, lastHeartbeatAt: 95_000,
      workload: { activeThreads: 2, threadStates: { starting: 0, active: 1, waiting: 1, stopping: 0 }, terminals: 1, truncated: false }, threads: [], recentConnections: [
        { startedAt: 50_000, closedAt: null, reason: null }, { startedAt: 10_000, closedAt: 40_000, reason: 'socket-closed' }
      ] }
  };
  mocks.state.mockImplementation(() => ({ ...state, refresh: mocks.refresh }));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mocks.copy } });
  mocks.copy.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('Performance Settings', () => {
  it('shows separate process resources, honest workload, heartbeat and diagnostics', async () => {
    state.history = [state.resources!, { ...state.resources!, sampledAt: 105_000 }];
    renderView();
    expect(screen.getByText('3.2%')).toBeDefined(); expect(screen.getByText('8.4%')).toBeDefined();
    expect(screen.getByText('64.0 MiB')).toBeDefined(); expect(screen.getByText('5s ago')).toBeDefined();
    expect(screen.getAllByRole('img')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Open Machines' }).getAttribute('href')).toBe('/settings/machines');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); expect(mocks.refresh).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
    await waitFor(() => expect(screen.getByText('Diagnostics copied')).toBeDefined());
    const copied = JSON.parse(mocks.copy.mock.calls[0]![0]); expect(copied.resources.processes).toHaveLength(2); expect(copied.stale).toBe(false);
    expect(screen.getByText(/Connection closed/)).toBeDefined();
  });
  it('selects hosts, shows unavailable remote/browser metrics and no fake zeros', () => {
    state.resources = null; state.summary = null; renderView();
    expect(screen.getByText(/Remote resource metrics are not available yet/)).toBeDefined();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } });
    expect(mocks.state).toHaveBeenLastCalledWith('b');
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(2);
    cleanup(); mocks.desktop.mockReturnValue(false); renderView();
    expect(screen.getByText(/Open the desktop app/)).toBeDefined();
  });
  it('shows stale and disconnected values and explains capped counts', () => {
    state.error = 'Connection data could not refresh'; state.resourceError = 'Resources could not refresh';
    state.summary!.connected = false; state.summary!.workload.truncated = true;
    state.summary!.recentConnections = [{ startedAt: 1, closedAt: null, reason: null }];
    renderView();
    expect(screen.getByText('Connection data stale')).toBeDefined(); expect(screen.getByText('Resource measurements are stale.')).toBeDefined();
    expect(screen.getByText('2+')).toBeDefined(); expect(screen.getByText('End time not recorded')).toBeDefined();
    expect(screen.getByText(/Counts are lower bounds/)).toBeDefined();
    expect(screen.getByText('No threads in the last sample.')).toBeDefined();
    expect(screen.getAllByRole('alert')).toHaveLength(2);
  });
  it('handles warm-up, overdue heartbeats, copy failure and empty machines', async () => {
    state.resources!.processes[0]!.cpuPercent = null; state.summary!.lastHeartbeatAt = 1;
    state.summary!.recentConnections = [{ startedAt: 10, closedAt: 20, reason: 'replaced' }];
    mocks.copy.mockRejectedValue(new Error('clipboard denied')); renderView();
    expect(screen.getByText('Warming up')).toBeDefined(); expect(screen.getByText(/overdue/)).toBeDefined();
    expect(screen.getByText(/Connection replaced/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
    await waitFor(() => expect(screen.getByText('Could not copy diagnostics')).toBeDefined());
    cleanup(); mocks.hosts.mockReturnValue([]); state.summary = null; state.resources = null; state.refreshing = true; renderView();
    expect(screen.getByText('No machines available')).toBeDefined(); expect(screen.getByText('Loading performance…')).toBeDefined();
    expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows thread states, hidden work, project/provider details and encoded navigation links', () => {
    state.resources = null;
    state.workloadHistory = [100_000, 105_000].map(sampledAt => ({ hostId: 'a', sampledAt, count: 2, connectedAt: 1, truncated: true }));
    state.summary!.threads = [
      { id: 'wait/1', projectId: 'project', providerId: 'codex', title: 'Review changes', state: 'waiting', visibility: 'hidden' },
      { id: 'run/2', projectId: 'deleted', providerId: 'fake', title: null, state: 'active', visibility: 'visible' }
    ];
    renderView();
    expect(screen.getByRole('img', { name: /Thread load trend. Observed peak 2\+/ })).toBeDefined();
    expect(screen.getByRole('link', { name: /Review changes/ }).getAttribute('href')).toBe('/projects/project/threads/wait%2F1');
    expect(screen.getByRole('link', { name: /Untitled thread/ }).getAttribute('href')).toBe('/threads/run%2F2');
    expect(screen.getByText(/Example project · Provider: codex/)).toBeDefined();
    expect(screen.getByText(/Unregistered project · Provider: fake/)).toBeDefined();
    expect(screen.getByText('Hidden')).toBeDefined();
    expect(screen.getAllByText('Waiting for input')).toHaveLength(2);
    expect(screen.getByText('Showing 2 of 2 threads. Waiting threads appear first.')).toBeDefined();
  });
  it('shows a quiet machine without treating a disconnected sample as zero load', () => {
    state.summary!.workload = { activeThreads: 0, threadStates: { starting: 0, active: 0, waiting: 0, stopping: 0 }, terminals: 0, truncated: false };
    state.workloadHistory = [100_000, 105_000].map(sampledAt => ({ hostId: 'a', sampledAt, count: 0, connectedAt: 1, truncated: false }));
    renderView();
    expect(screen.getByText('No threads in progress.')).toBeDefined();
    expect(screen.getByRole('img', { name: /Thread load trend. Observed peak 0/ })).toBeDefined();
    cleanup(); state.workloadHistory = [{ hostId: 'a', sampledAt: 110_000, count: null, connectedAt: null, truncated: false }];
    state.summary!.connected = false; renderView();
    expect(screen.queryByRole('img', { name: /Thread load trend/ })).toBeNull();
    expect(screen.getByText('Waiting for connected samples')).toBeDefined();
  });
});
