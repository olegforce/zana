import { describe, expect, it, vi } from 'vitest';
import type { ProcessMetric } from 'electron';
import { createPerformanceSampler } from './performance-sampler.js';

function metric(overrides: Partial<ProcessMetric> = {}): ProcessMetric {
  return { pid: 10, type: 'Utility', name: 'zcc-/app/runtime/host-runtime.js', serviceName: 'node.mojom.NodeService', creationTime: 100,
    cpu: { cumulativeCPUUsage: 1, percentCPUUsage: 999, idleWakeupsPerSecond: 0 },
    memory: { workingSetSize: 2048, peakWorkingSetSize: 4096 }, ...overrides };
}
function setup() {
  let time = 1_000;
  let wall = 100_000;
  let host = 'host-a';
  let rows = [metric(), metric({ pid: 11, name: 'zcc-/app/runtime/server-runtime.js' })];
  const metrics = vi.fn(() => rows);
  const sampler = createPerformanceSampler({ metrics, hostId: () => host, now: () => wall, monotonic: () => time });
  return { sampler, metrics, setRows: (next: ProcessMetric[]) => { rows = next; }, host: (next: string) => { host = next; },
    advance: (ms = 5_000) => { time += ms; wall += ms; }, sleep: () => { wall += 100_000; } };
}

describe('runtime performance sampler', () => {
  it('returns only our utility roles, converts KiB and warms up CPU', () => {
    const f = setup();
    f.setRows([metric(), metric({ name: 'untrusted-/host-runtime.js' }), metric({ type: 'Tab', name: 'zcc-/host-runtime.js' })]);
    expect(f.sampler.sample()).toEqual({ hostId: 'host-a', sampledAt: 100_000, processes: [
      { role: 'daemon', pid: 10, createdAt: 100, cpuPercent: null, memoryBytes: 2_097_152 }
    ] });
  });
  it('shares samples across clients and computes one-core CPU from cumulative deltas', () => {
    const f = setup();
    const first = f.sampler.sample();
    f.advance(4_999);
    expect(f.sampler.sample()).toBe(first);
    expect(f.metrics).toHaveBeenCalledTimes(1);
    f.advance(1);
    f.setRows([metric({ cpu: { cumulativeCPUUsage: 8.5, percentCPUUsage: 0, idleWakeupsPerSecond: 0 } })]);
    expect(f.sampler.sample().processes[0]?.cpuPercent).toBe(150);
  });
  it('resets on PID reuse, missing processes and changed host identity', () => {
    const f = setup(); f.sampler.sample(); f.advance();
    f.setRows([metric({ creationTime: 200 })]);
    expect(f.sampler.sample().processes[0]?.cpuPercent).toBeNull();
    f.advance(); f.setRows([]); expect(f.sampler.sample().processes).toEqual([]);
    f.advance(); f.setRows([metric()]); expect(f.sampler.sample().processes[0]?.cpuPercent).toBeNull();
    f.host('host-b'); expect(f.sampler.sample().hostId).toBe('host-b');
    expect(f.sampler.sample().processes[0]?.cpuPercent).toBeNull();
  });
  it('does not bridge long gaps or machine sleep', () => {
    const f = setup(); f.sampler.sample(); f.advance(30_000);
    expect(f.sampler.sample().processes[0]?.cpuPercent).toBeNull();
    f.advance(); f.sleep(); expect(f.sampler.sample().processes[0]?.cpuPercent).toBeNull();
  });
  it('reports missing/invalid CPU and memory as unavailable and handles Windows paths', () => {
    const f = setup();
    f.setRows([metric({ name: 'zcc-C:\\runtime\\host-runtime.js', cpu: { percentCPUUsage: 5, idleWakeupsPerSecond: 0 }, memory: { workingSetSize: NaN, peakWorkingSetSize: 0 } })]);
    expect(f.sampler.sample().processes[0]).toMatchObject({ role: 'daemon', cpuPercent: null, memoryBytes: null });
    f.advance(); f.setRows([metric({ cpu: { cumulativeCPUUsage: -1, percentCPUUsage: 0, idleWakeupsPerSecond: 0 } })]);
    expect(f.sampler.sample().processes[0]?.cpuPercent).toBeNull();
  });
  it('does not pick one of two overlapping processes or swallow collection failure', () => {
    const f = setup(); f.setRows([metric(), metric({ pid: 12 })]);
    expect(f.sampler.sample().processes).toEqual([]);
    f.advance(); f.metrics.mockImplementationOnce(() => { throw new Error('unavailable'); });
    expect(() => f.sampler.sample()).toThrow('unavailable');
    f.setRows([metric()]); expect(f.sampler.sample().processes).toHaveLength(1);
  });
  it('handles an unenrolled desktop with default clocks', () => {
    expect(createPerformanceSampler({ metrics: () => [], hostId: () => undefined }).sample()).toMatchObject({ hostId: null, processes: [] });
  });
});
