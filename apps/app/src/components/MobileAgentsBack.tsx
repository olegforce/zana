import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useCompactLayout } from '../hooks/useCompactLayout.js';
import { useRouteState } from '../hooks/useRouteState.js';
import { getAgentsRoutePath, getProjectRoutePath } from '../lib/route-paths.js';

/** A direct return to agent management, including from a bookmarked conversation. */
export function MobileAgentsBack({ hidden = false }: { hidden?: boolean }) {
  const compact = useCompactLayout();
  const route = useRouteState();
  if (!compact || hidden || (!route.threadId && !route.sessionId)) return null;
  const to = route.focusedProjectId ? getProjectRoutePath(route.focusedProjectId) : getAgentsRoutePath();
  return (
    <Link to={to} className="sidebar-expand-control mobile-agents-return"
      aria-label="Back to agents" title="Back to agents">
      <ArrowLeft size={18} aria-hidden="true" />
    </Link>
  );
}
