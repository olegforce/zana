// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TerminalSession } from '@zana-ai/zcc-domain/product';
import type { ThreadListItem } from '../thread-store';
import { MobileNavDismiss } from './mobile-nav-context';
import { MobileAgentNavigation } from './MobileAgentNavigation';

const h = vi.hoisted(() => ({
  data: { projects: [{ id: 'p', name: 'Zana project' }], terminals: {} as Record<string, TerminalSession[]> },
  roster: { threads: [] as ThreadListItem[], loading: false },
  status: { byId: {}, since: {} }, unread: 0, ensure: vi.fn(), dismiss: vi.fn()
}));
vi.mock('../store', () => ({
  useData: (select: (state: typeof h.data) => unknown) => select(h.data),
  useAgentStatus: (select: (state: typeof h.status) => unknown) => select(h.status),
  useUnreadInboxCount: () => h.unread
}));
vi.mock('../thread-store', () => ({ useThreads: (select: (state: typeof h.roster) => unknown) => select(h.roster) }));
vi.mock('../hooks/useEnsureThreads', () => ({ useEnsureThreads: h.ensure }));
const makeThread = (): ThreadListItem => ({
  id: 't', projectId: 'p', hostId: 'h', environmentId: null, providerId: 'fake', status: 'idle',
  title: 'Improve the menu', createdAt: 1, cwd: null, branchName: null, isWorktree: false
});
const Location = () => <div data-testid="location">{useLocation().pathname}</div>;
function mount({ enabled = true, path = '/threads/t', projectId }: { enabled?: boolean; path?: string; projectId?: string } = {}) {
  return render(<MemoryRouter initialEntries={[path]}><MobileNavDismiss.Provider value={h.dismiss}>
    <MobileAgentNavigation enabled={enabled} projectId={projectId}><aside>Full navigation</aside></MobileAgentNavigation>
    <Location />
  </MobileNavDismiss.Provider></MemoryRouter>);
}
beforeEach(() => {
  vi.clearAllMocks();
  h.unread = 0;
  h.roster = { threads: [makeThread()], loading: false };
  h.data.terminals = { p: [{ id: 'cli', projectId: 'p', title: 'Terminal agent', profile: 'codex', cwd: '/test', status: 'running', createdAt: 2 }] };
});
afterEach(cleanup);

it('shows both agent types in a flat history and opens each as a page, dismissing the drawer', () => {
  mount({ path: '/projects/p/threads/t' });
  expect(screen.getByRole('navigation', { name: 'Agents navigation' })).toBeTruthy();
  expect(h.ensure).toHaveBeenCalled();
  expect(screen.queryByText('Full navigation')).toBeNull();
  const thread = screen.getByRole('link', { name: /Improve the menu/ });
  expect(thread.getAttribute('aria-current')).toBe('page');
  fireEvent.click(screen.getByRole('link', { name: /Terminal agent/ }));
  expect(screen.getByTestId('location').textContent).toBe('/sessions/cli');
  expect(screen.getByRole('link', { name: /Terminal agent/ }).getAttribute('aria-current')).toBe('page');
  fireEvent.click(thread);
  expect(screen.getByTestId('location').textContent).toBe('/threads/t');
  expect(h.dismiss).toHaveBeenCalledTimes(2);
});

it('searches names and projects, clears with focus returned to search, and reports no results', () => {
  mount();
  const search = screen.getByRole('searchbox', { name: 'Search agents' });
  fireEvent.change(search, { target: { value: 'menu' } });
  expect(screen.queryByRole('link', { name: /Terminal agent/ })).toBeNull();
  fireEvent.change(search, { target: { value: 'ZANA project' } });
  expect(screen.getByRole('link', { name: /Terminal agent/ })).toBeTruthy();
  fireEvent.change(search, { target: { value: 'missing' } });
  expect(screen.getByRole('status').textContent).toContain('No agents match');
  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
  expect(search).toBe(document.activeElement);
  expect(screen.getByRole('link', { name: /Terminal agent/ })).toBeTruthy();
});

it('opens the existing new-agent composer and closes the menu', () => {
  mount({ path: '/' });
  fireEvent.click(screen.getByRole('link', { name: 'New agent' }));
  expect(screen.getByTestId('location').textContent).toBe('/threads/new');
  expect(h.dismiss).toHaveBeenCalledOnce();
});

it('keeps new-agent navigation scoped in a dedicated project window', () => {
  mount({ projectId: 'p' });
  expect(screen.getByRole('link', { name: 'New agent' }).getAttribute('href')).toBe('/projects/p/threads/new');
});

it.each([undefined, 'p'])('opens the global Agents overview and closes the menu (project=%s)', (projectId) => {
  mount({ projectId });
  const agents = screen.getByRole('link', { name: 'Agents', exact: true });
  expect(agents.getAttribute('href')).toBe('/agents');
  expect(agents.getAttribute('aria-current')).toBeNull();
  expect(agents.parentElement).toBe(screen.getByTestId('mobile-nav-inbox').parentElement);
  expect(agents.parentElement).toBe(screen.getByRole('button', { name: 'More' }).parentElement);
  fireEvent.click(agents);
  expect(screen.getByTestId('location').textContent).toBe('/agents');
  expect(agents.getAttribute('aria-current')).toBe('page');
  expect(h.dismiss).toHaveBeenCalledOnce();
});

it.each(['/agents/', '/agents/team'])('marks the overview shortcut active at %s', (path) => {
  mount({ path });
  expect(screen.getByTestId('mobile-nav-agents').getAttribute('aria-current')).toBe('page');
  expect(screen.getByTestId('mobile-nav-inbox').getAttribute('aria-current')).toBeNull();
});

it.each([[0, null], [12, '12'], [120, '99+']] as const)('opens Inbox and presents %s unread items', (unread, badge) => {
  h.unread = unread;
  mount();
  const inbox = screen.getByTestId('mobile-nav-inbox');
  expect(inbox.getAttribute('href')).toBe('/inbox');
  expect(inbox.getAttribute('aria-current')).toBeNull();
  if (badge) expect(screen.getByLabelText(`${unread} unread`).textContent).toBe(badge);
  else expect(inbox.querySelector('.mobile-agent-inbox-count')).toBeNull();
  fireEvent.click(inbox);
  expect(h.dismiss).toHaveBeenCalledOnce();
  expect(screen.getByTestId('location').textContent).toBe('/inbox');
  expect(inbox.getAttribute('aria-current')).toBe('page');
});

it('marks Inbox active on its subpages and keeps its existing route in a project window', () => {
  mount({ path: '/inbox/saved', projectId: 'p' });
  expect(screen.getByTestId('mobile-nav-inbox').getAttribute('aria-current')).toBe('page');
  expect(screen.getByTestId('mobile-nav-inbox').getAttribute('href')).toBe('/inbox');
});

it('opens and leaves More without losing focus or the search', () => {
  mount();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'menu' } });
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  expect(screen.getByText('Full navigation')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'All agents' })).toBe(document.activeElement);
  fireEvent.click(screen.getByRole('button', { name: 'All agents' }));
  expect(screen.getByRole('button', { name: 'More' })).toBe(document.activeElement);
  expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('menu');
});

it.each([true, false])('handles an empty roster while loading=%s', (loading) => {
  h.roster = { threads: [], loading };
  h.data.terminals = {};
  mount();
  expect(screen.getByRole('status').textContent).toContain(loading ? 'Loading agents' : 'Your agents will appear here');
  expect(screen.getByRole('link', { name: 'New agent' })).toBeTruthy();
});

it('leaves desktop and the dedicated settings rail unchanged without loading another roster', () => {
  mount({ enabled: false });
  expect(screen.getByText('Full navigation')).toBeTruthy();
  expect(screen.queryByRole('searchbox')).toBeNull();
  expect(h.ensure).not.toHaveBeenCalled();
});
