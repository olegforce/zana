import { describe, expect, it } from 'vitest';
import type { RuntimePerformanceSnapshot } from '@zana-ai/zcc-desktop-contract';
import type { HostPerformanceSummary } from '@zana-ai/zcc-server-contract';
import { appendPerformanceSample, appendWorkloadSample, formatDuration, formatMemory, performanceTrend, workloadTrend, type WorkloadSample } from './performance-model.js';

export function sample(at: number, cpu: number | null = 12): RuntimePerformanceSnapshot {
  return { hostId: 'a', sampledAt: at, processes: [{ role: 'daemon', pid: 10, createdAt: 100, cpuPercent: cpu, memoryBytes: 1024 ** 2 }] };
}
describe('performance presentation', () => {
  it('caps history by count, time and host; ignores duplicate samples', () => {
    let history: RuntimePerformanceSnapshot[] = [];
    for (let i = 0; i < 150; i++) history = appendPerformanceSample(history, sample(i * 100));
    expect(history).toHaveLength(120);
    expect(appendPerformanceSample(history, history.at(-1)!)).toBe(history);
    expect(appendPerformanceSample(history, sample(800_000))).toHaveLength(1);
    expect(appendPerformanceSample(history, { ...sample(20_000), hostId: 'b' })).toHaveLength(1);
  });
  it('formats zero, missing, large and negative values clearly', () => {
    expect(formatMemory(null)).toBe('Unavailable'); expect(formatMemory(0)).toBe('0.0 MiB');
    expect(formatMemory(1024 ** 3)).toBe('1.00 GiB');
    expect(formatDuration(-1000)).toBe('0s'); expect(formatDuration(62_000)).toBe('1m 2s');
    expect(formatDuration(3_660_000)).toBe('1h 1m'); expect(formatDuration(90_000_000)).toBe('1d 1h');
  });
  it('breaks charts across missing samples, replacement processes and long gaps', () => {
    expect(performanceTrend([], 'cpuPercent')).toEqual({ segments: [], peak: null, count: 0 });
    const replaced = sample(20_000); replaced.processes[0]!.createdAt = 200;
    const history = [sample(0), sample(5_000), sample(10_000, null), sample(15_000), replaced, sample(80_000), { ...sample(85_000), processes: [] }];
    const trend = performanceTrend(history, 'cpuPercent');
    expect(trend.count).toBe(5); expect(trend.peak).toBe(12); expect(trend.segments).toHaveLength(4);
    expect(trend.segments[0]).toContain(' L');
    expect(performanceTrend([sample(0, 0), sample(5_000, 0)], 'cpuPercent').segments[0]).not.toMatch(/NaN|Infinity/);
    expect(performanceTrend(history, 'memoryBytes').peak).toBe(1024 ** 2);
  });
  it('retains only aggregate workload history with count, time and machine bounds', () => {
    const summary: HostPerformanceSummary = { hostId: 'remote', sampledAt: 100, connected: true, connectedAt: 1, lastHeartbeatAt: 1,
      workload: { activeThreads: 2, threadStates: { starting: 0, active: 1, waiting: 1, stopping: 0 }, terminals: 0, truncated: false },
      threads: [{ id: 'private-title', projectId: 'p', providerId: 'fake', title: 'private-title', visibility: 'hidden', state: 'active' }], recentConnections: [] };
    let history: WorkloadSample[] = [];
    for (let i = 0; i < 150; i++) history = appendWorkloadSample(history, { ...summary, sampledAt: i * 5000 });
    expect(history).toHaveLength(120);
    expect(JSON.stringify(history)).not.toContain('private-title');
    expect(appendWorkloadSample(history, { ...summary, sampledAt: 745_000 })).toBe(history);
    expect(appendWorkloadSample(history, { ...summary, hostId: 'other', sampledAt: 745_000 })).toHaveLength(1);
    expect(appendWorkloadSample(history, { ...summary, sampledAt: 2_000_000, connected: false })).toEqual([
      { hostId: 'remote', sampledAt: 2_000_000, count: null, connectedAt: 1, truncated: false }
    ]);
  });
  it('charts workload without CPU samples and breaks lines on disconnect, reconnect or gaps', () => {
    const point = (sampledAt: number, count: number | null, connectedAt = 1): WorkloadSample => ({ hostId: 'remote', sampledAt, count, connectedAt, truncated: false });
    expect(workloadTrend([])).toEqual({ segments: [], peak: null, count: 0, truncated: false });
    const history = [point(0, 0), point(5000, 3), point(10000, null), point(15000, 2), point(20000, 4, 2), point(50000, 1, 2)];
    expect(workloadTrend(history)).toMatchObject({ count: 5, peak: 4, truncated: false });
    expect(workloadTrend(history).segments).toHaveLength(4);
    expect(workloadTrend([point(0, 0), point(5000, 0)]).segments[0]).not.toMatch(/NaN|Infinity/);
    expect(workloadTrend([{ ...point(0, 1000), truncated: true }]).truncated).toBe(true);
    expect(workloadTrend([{ ...point(0, null), truncated: true }]).truncated).toBe(false);
  });
});
