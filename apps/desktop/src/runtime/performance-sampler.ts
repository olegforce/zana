import type { ProcessMetric } from 'electron';
import type { RuntimePerformanceSnapshot, RuntimeProcessSample } from '@zana-ai/zcc-desktop-contract';

export const PERFORMANCE_SAMPLE_MS = 5_000;
const MAX_INTERVAL_MS = 15_000;

/** One app-wide, demand-driven sampler: no timer or process work when unused. */
export function createPerformanceSampler(deps: {
  metrics: () => ProcessMetric[];
  hostId: () => string | undefined;
  now?: () => number;
  monotonic?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const monotonic = deps.monotonic ?? (() => performance.now());
  let cached: RuntimePerformanceSnapshot | null = null;
  let sampledMono = -Infinity;
  let previous = new Map<string, { cpu: number; at: number }>();
  return {
    sample(): RuntimePerformanceSnapshot {
      const at = monotonic();
      const hostId = deps.hostId() ?? null;
      if (cached && cached.hostId === hostId && at - sampledMono >= 0 && at - sampledMono < PERFORMANCE_SAMPLE_MS && now() - cached.sampledAt < PERFORMANCE_SAMPLE_MS) return cached;
      const metrics = deps.metrics();
      const processes: RuntimeProcessSample[] = [];
      const next = new Map<string, { cpu: number; at: number }>();
      for (const [role, entry] of [['daemon', 'host-runtime.js'], ['server', 'server-runtime.js']] as const) {
        // Names are set by our supervisor, never supplied by the renderer. Do
        // not pick an arbitrary process if a shutdown/replacement overlaps.
        const matches = metrics.filter(metric => metric.type === 'Utility' &&
          metric.name?.startsWith('zcc-') && metric.name.replaceAll('\\', '/').endsWith(`/${entry}`));
        if (matches.length !== 1) continue;
        const metric = matches[0]!;
        const key = `${hostId}:${role}:${metric.pid}:${metric.creationTime}`;
        const old = previous.get(key);
        const cpu = metric.cpu.cumulativeCPUUsage;
        const elapsed = old ? at - old.at : 0;
        let cpuPercent: number | null = null;
        if (typeof cpu === 'number' && Number.isFinite(cpu) && cpu >= 0) {
          if (old && elapsed >= PERFORMANCE_SAMPLE_MS && elapsed <= MAX_INTERVAL_MS && cached && now() - cached.sampledAt <= MAX_INTERVAL_MS && cpu >= old.cpu) {
            cpuPercent = (cpu - old.cpu) * 100_000 / elapsed;
          }
          next.set(key, { cpu, at });
        }
        const memory = metric.memory?.workingSetSize;
        processes.push({ role, pid: metric.pid, createdAt: metric.creationTime, cpuPercent,
          memoryBytes: typeof memory === 'number' && Number.isFinite(memory) && memory >= 0 ? memory * 1024 : null });
      }
      previous = next;
      sampledMono = at;
      cached = { hostId, sampledAt: now(), processes };
      return cached;
    }
  };
}
