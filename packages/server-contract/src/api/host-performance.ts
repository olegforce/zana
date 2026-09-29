export type HostPerformanceThreadState = 'starting' | 'active' | 'waiting' | 'stopping';

export interface HostPerformanceThread {
  id: string;
  projectId: string;
  providerId: string;
  title: string | null;
  visibility: 'visible' | 'hidden';
  state: HostPerformanceThreadState;
}

export interface HostPerformanceSummary {
  hostId: string;
  sampledAt: number;
  connected: boolean;
  connectedAt: number | null;
  lastHeartbeatAt: number | null;
  workload: {
    activeThreads: number;
    /** Disjoint states; these add up to activeThreads. */
    threadStates: Record<HostPerformanceThreadState, number>;
    terminals: number;
    /** Counts are lower bounds when the scan cap is reached. */
    truncated: boolean;
  };
  /** Bounded preview of the counted threads, with waiting threads first. */
  threads: HostPerformanceThread[];
  recentConnections: Array<{
    startedAt: number;
    closedAt: number | null;
    reason: string | null;
  }>;
}
