import type { RuntimePerformanceSnapshot } from '@zana-ai/zcc-desktop-contract';
import type { HostPerformanceSummary, HostPerformanceThreadState } from '@zana-ai/zcc-server-contract';

export const PERFORMANCE_INTERVAL_MS = 5_000;
export const PERFORMANCE_HISTORY_MS = 10 * 60_000;
export const PERFORMANCE_HISTORY_CAP = 120;

export const THREAD_STATE_LABELS: Record<HostPerformanceThreadState, string> = {
  starting: 'Starting', active: 'Active', waiting: 'Waiting for input', stopping: 'Stopping'
};

export interface WorkloadSample {
  hostId: string;
  sampledAt: number;
  count: number | null;
  connectedAt: number | null;
  truncated: boolean;
}

export function appendPerformanceSample<T extends { hostId: string | null; sampledAt: number }>(history: T[], next: T): T[] {
  if (history.at(-1)?.sampledAt === next.sampledAt && history.at(-1)?.hostId === next.hostId) return history;
  return [...history.filter(sample => sample.hostId === next.hostId && sample.sampledAt > next.sampledAt - PERFORMANCE_HISTORY_MS), next]
    .slice(-PERFORMANCE_HISTORY_CAP);
}

export function appendWorkloadSample(history: WorkloadSample[], summary: HostPerformanceSummary): WorkloadSample[] {
  return appendPerformanceSample(history, {
    hostId: summary.hostId, sampledAt: summary.sampledAt,
    count: summary.connected ? summary.workload.activeThreads : null,
    connectedAt: summary.connectedAt, truncated: summary.workload.truncated
  });
}

export function formatMemory(bytes: number | null | undefined): string {
  if (bytes == null) return 'Unavailable';
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function performanceTrend(history: RuntimePerformanceSnapshot[], metric: 'cpuPercent' | 'memoryBytes') {
  return chartTrend(history.map(sample => {
    const process = sample.processes.find(item => item.role === 'daemon');
    return { sampledAt: sample.sampledAt, value: process?.[metric] ?? null, identity: `${sample.hostId}:${process?.pid}:${process?.createdAt}` };
  }));
}

export function workloadTrend(history: WorkloadSample[]) {
  return {
    ...chartTrend(history.map(sample => ({ sampledAt: sample.sampledAt, value: sample.count, identity: `${sample.hostId}:${sample.connectedAt}` }))),
    truncated: history.some(sample => sample.count !== null && sample.truncated)
  };
}

interface ChartPoint { sampledAt: number; value: number | null; identity: string }
function chartTrend(points: ChartPoint[]) {
  const start = points[0]?.sampledAt ?? 0;
  const span = Math.max(PERFORMANCE_INTERVAL_MS, (points.at(-1)?.sampledAt ?? start) - start);
  const values = points.flatMap(point => point.value == null ? [] : [point.value]);
  const peak = values.length ? Math.max(...values) : null;
  const ceiling = Math.max(1, peak ?? 0);
  const segments: string[] = [];
  let path = '';
  let previous: ChartPoint | null = null;
  for (const point of points) {
    const { value } = point;
    const continues = previous && point.identity === previous.identity &&
      point.sampledAt - previous.sampledAt <= PERFORMANCE_INTERVAL_MS * 3;
    if (value == null || !continues) {
      if (path) segments.push(path);
      path = '';
    }
    if (value != null) {
      const x = 4 + (point.sampledAt - start) / span * 392;
      const y = 94 - value / ceiling * 84;
      path += `${path ? ' L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
      previous = point;
    } else previous = null;
  }
  if (path) segments.push(path);
  return { segments, peak, count: values.length };
}
