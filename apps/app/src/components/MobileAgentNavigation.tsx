import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft, Ellipsis, Folder, Inbox, LayoutGrid, MessageSquare, Search, SquarePen, X } from 'lucide-react';
import { useAgentStatus, useData, useUnreadInboxCount } from '../store';
import { useThreads } from '../thread-store';
import { useEnsureThreads } from '../hooks/useEnsureThreads';
import { getAgentsRoutePath, getInboxRoutePath, getNewThreadRoutePath, sessionIdFromPath, threadIdFromPath } from '../lib/route-paths';
import { useMobileNavDismiss } from './mobile-nav-context';
import { filterMobileAgents, mobileAgentItems } from './mobile-agent-items';
import '../styles/mobile-agent-navigation.css';

/** Everyday phone navigation is agents first; More opens the live tool picker. */
export function MobileAgentNavigation({ enabled, projectId, children }: {
  enabled: boolean;
  projectId?: string;
  children: ReactNode;
}) {
  return enabled ? <AgentNavigation projectId={projectId}>{children}</AgentNavigation> : children;
}

function AgentNavigation({ projectId, children }: { projectId?: string; children: ReactNode }) {
  const [advanced, setAdvanced] = useState(false);
  const [search, setSearch] = useState('');
  const back = useRef<HTMLButtonElement>(null);
  const advancedButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const switched = useRef(false);
  const dismiss = useMobileNavDismiss();
  const { pathname } = useLocation();
  const unreadInbox = useUnreadInboxCount();
  const agentsPath = getAgentsRoutePath();
  const agentsActive = pathname === agentsPath || pathname.startsWith(`${agentsPath}/`);
  const inboxPath = getInboxRoutePath();
  const inboxActive = pathname === inboxPath || pathname.startsWith(`${inboxPath}/`);
  const activeThreadId = threadIdFromPath(pathname);
  const activeSessionId = sessionIdFromPath(pathname);
  const activeKey = activeThreadId ? `thread:${activeThreadId}` : activeSessionId ? `session:${activeSessionId}` : undefined;
  const projects = useData((state) => state.projects);
  const terminals = useData((state) => state.terminals);
  const states = useAgentStatus((state) => state.byId);
  const since = useAgentStatus((state) => state.since);
  const threads = useThreads((state) => state.threads);
  const loading = useThreads((state) => state.loading);
  useEnsureThreads();
  const items = useMemo(() => mobileAgentItems({ projects, threads, terminals, states, since, projectId }),
    [projects, threads, terminals, states, since, projectId]);
  const visible = useMemo(() => filterMobileAgents(items, search), [items, search]);

  useEffect(() => {
    // Switching rails removes the focused button. Keep keyboard focus in the drawer.
    if (switched.current) (advanced ? back.current : advancedButton.current)?.focus();
    switched.current = true;
  }, [advanced]);

  if (advanced) return (
    <div className="mobile-advanced-navigation">
      <button ref={back} type="button" className="mobile-agents-back" onClick={() => setAdvanced(false)}>
        <ArrowLeft size={18} aria-hidden="true" /> All agents
      </button>
      {children}
    </div>
  );

  return (
    <nav className="mobile-agent-navigation" aria-label="Agents navigation">
      <div className="mobile-agent-actions">
        <Link className="mobile-agent-new" to={getNewThreadRoutePath(projectId)} onClick={() => dismiss?.()}>
          <SquarePen size={20} aria-hidden="true" /> New agent
        </Link>
        <div className="mobile-agent-shortcuts">
          <Link className="mobile-agent-shortcut" to={agentsPath} data-testid="mobile-nav-agents"
            title="Agents overview: kanban, list and canvas"
            aria-current={agentsActive ? 'page' : undefined} onClick={() => dismiss?.()}>
            <LayoutGrid size={20} aria-hidden="true" /><span>Agents</span>
          </Link>
          <Link className="mobile-agent-shortcut" to={inboxPath} data-testid="mobile-nav-inbox"
            aria-current={inboxActive ? 'page' : undefined} onClick={() => dismiss?.()}>
            <Inbox size={20} aria-hidden="true" /><span>Inbox</span>
            {unreadInbox > 0 && <span className="mobile-agent-inbox-count" aria-label={`${unreadInbox} unread`}>
              {unreadInbox > 99 ? '99+' : unreadInbox}
            </span>}
          </Link>
          <button ref={advancedButton} type="button" className="mobile-agent-shortcut" onClick={() => setAdvanced(true)}
            title="More: plugins, history, projects and other tools">
            <Ellipsis size={20} aria-hidden="true" /><span>More</span>
          </button>
        </div>
        <div className="mobile-agent-search">
          <Search size={18} aria-hidden="true" />
          <input ref={searchInput} type="search" aria-label="Search agents" placeholder="Search agents"
            value={search} onChange={(event) => setSearch(event.target.value)} />
          {search && <button type="button" aria-label="Clear search" onClick={() => {
            setSearch('');
            searchInput.current?.focus();
          }}><X size={16} aria-hidden="true" /></button>}
        </div>
        <div className="mobile-agent-list-heading" aria-hidden="true">
          <span>Your agents</span><span>{visible.length}</span>
        </div>
      </div>
      <div className="mobile-agent-history">
        {visible.length > 0 ? <ul aria-label="Your agents">
          {visible.map((item) => (
            <li key={item.key}>
              <Link to={item.to} onClick={() => dismiss?.()} className="mobile-agent-row"
                aria-current={activeKey === item.key ? 'page' : undefined}>
                <MessageSquare size={19} aria-hidden="true" />
                <span className="mobile-agent-row-copy">
                  <span className="mobile-agent-row-title">{item.title}</span>
                  <span className="mobile-agent-row-detail">
                    <span className="mobile-agent-project" title={item.projectName}>
                      <Folder size={12} aria-hidden="true" />
                      <span>{item.projectName}</span>
                    </span>
                    <span className="mobile-agent-status" data-status={item.status}>{item.status}</span>
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul> : <div className="mobile-agent-history-empty" role="status">
          <MessageSquare size={28} aria-hidden="true" />
          <p>{search.trim() ? 'No agents match your search' : loading ? 'Loading agents…' : 'Your agents will appear here'}</p>
          <span>{search.trim() ? 'Try an agent name or project.' : 'Start with New agent above.'}</span>
        </div>}
      </div>
    </nav>
  );
}
