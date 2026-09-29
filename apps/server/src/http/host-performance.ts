import type { HostPerformanceSummary, HostPerformanceThread } from '@zana-ai/zcc-server-contract';
import type { ProductHttpContext } from './product-context.js';

export const PERFORMANCE_WORKLOAD_CAP = 1_000;
export const PERFORMANCE_THREAD_LIST_CAP = 50;

type WorkRow = Omit<HostPerformanceThread, 'state'> & {
  status: 'starting' | 'active' | 'stopping';
  waiting: number;
  updatedAt: number;
};

// Both predicates use existing indexes. LIMIT bounds the scan before we sort
// the small preview; conversation histories and interaction payloads stay out.
export const PERFORMANCE_WORKLOAD_SQL = `SELECT t.id, t.project_id AS projectId, t.provider_id AS providerId,
  substr(t.title, 1, 256) AS title, t.visibility, t.status, t.updated_at AS updatedAt,
  EXISTS (SELECT 1 FROM pending_interactions pi WHERE pi.thread_id = t.id
    AND pi.status IN ('pending', 'resolving')) AS waiting
  FROM threads t WHERE t.host_id = ? AND t.status IN ('starting', 'active', 'stopping') LIMIT ?`;

/** Read bounded workload metadata, never histories, prompts or process output. */
export function readHostPerformance(ctx: Pick<ProductHttpContext, 'db' | 'hostHub' | 'terminalSessions'>, hostId: string): HostPerformanceSummary {
  const session = ctx.hostHub.getSession(hostId);
  const rows = ctx.db.sqlite.prepare(PERFORMANCE_WORKLOAD_SQL).all(hostId, PERFORMANCE_WORKLOAD_CAP + 1) as WorkRow[];
  const threadStates: HostPerformanceSummary['workload']['threadStates'] = { starting: 0, active: 0, waiting: 0, stopping: 0 };
  const counted = rows.slice(0, PERFORMANCE_WORKLOAD_CAP).map(row => {
    // A pending interaction is a subset of active work. Lifecycle transitions
    // retain their own state even if an interaction has not been cleared yet.
    const state: HostPerformanceThread['state'] = row.status === 'active' && row.waiting ? 'waiting' : row.status;
    threadStates[state]++;
    return { ...row, state };
  });
  counted.sort((a, b) => Number(b.state === 'waiting') - Number(a.state === 'waiting') || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const threads = counted.slice(0, PERFORMANCE_THREAD_LIST_CAP).map(({ id, projectId, providerId, title, visibility, state }) =>
    ({ id, projectId, providerId, title, visibility, state }));
  let terminals = 0;
  for (const terminal of ctx.terminalSessions.values()) {
    if (terminal.hostId === hostId && terminal.status !== 'exited') terminals++;
  }
  const recentConnections = ctx.db.sqlite.prepare(
    `SELECT created_at AS startedAt, closed_at AS closedAt, close_reason AS reason
     FROM host_sessions WHERE host_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 6`
  ).all(hostId) as HostPerformanceSummary['recentConnections'];
  return {
    hostId, sampledAt: Date.now(), connected: Boolean(session),
    connectedAt: session?.connectedAt ?? null,
    lastHeartbeatAt: session?.lastHeartbeatAt ?? null,
    workload: {
      activeThreads: counted.length,
      threadStates,
      terminals,
      truncated: rows.length > PERFORMANCE_WORKLOAD_CAP
    },
    threads,
    recentConnections
  };
}
