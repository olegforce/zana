import { useEffect, useRef, useState } from 'react';
import type { RuntimePerformanceSnapshot } from '@zana-ai/zcc-desktop-contract';
import type { HostPerformanceSummary } from '@zana-ai/zcc-server-contract';
import { apiJson } from '../../lib/fetch-with-app-surface.js';
import { hasDesktopBridge } from '../../lib/app-surface.js';
import { appendPerformanceSample, appendWorkloadSample, PERFORMANCE_INTERVAL_MS, type WorkloadSample } from './performance-model.js';

export interface PerformanceState {
  hostId: string | null;
  summary: HostPerformanceSummary | null;
  resources: RuntimePerformanceSnapshot | null;
  history: RuntimePerformanceSnapshot[];
  workloadHistory: WorkloadSample[];
  error: string | null;
  resourceError: string | null;
  refreshing: boolean;
  now: number;
}
const empty = (hostId: string | null): PerformanceState => ({ hostId, summary: null, resources: null, history: [], workloadHistory: [], error: null, resourceError: null, refreshing: false, now: Date.now() });

export function usePerformance(hostId: string | null) {
  const [state, setState] = useState<PerformanceState>(() => empty(hostId));
  const refresh = useRef(() => {});
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let controller: AbortController | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    setState(empty(hostId));
    const read = async () => {
      if (!hostId || disposed || inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      controller = new AbortController();
      const signal = controller.signal;
      const expired = new Promise<never>((_, reject) => {
        cancel = () => { controller?.abort(); reject(new Error('Performance refresh interrupted')); };
        timeout = setTimeout(cancel, 8_000);
      });
      setState(old => ({ ...old, refreshing: true, now: Date.now() }));
      const [summary, resources] = await Promise.allSettled([
        Promise.race([apiJson<HostPerformanceSummary>(`/hosts/${encodeURIComponent(hostId)}/performance`, { signal }), expired]),
        Promise.race([Promise.resolve().then(async () => {
          if (!hasDesktopBridge() || !window.cc.app.performance) return null;
          const snapshot = await window.cc.app.performance();
          if (!snapshot) throw new Error('Resource metrics unavailable');
          return snapshot;
        }), expired])
      ]);
      clearTimeout(timeout);
      cancel = undefined;
      inFlight = false;
      if (disposed) return;
      setState(old => {
        const snapshot = resources.status === 'fulfilled' ? resources.value : old.resources;
        const local = snapshot?.hostId === hostId ? snapshot : null;
        return {
          hostId, summary: summary.status === 'fulfilled' ? summary.value : old.summary,
          resources: local,
          history: local && resources.status === 'fulfilled' ? appendPerformanceSample(old.history, local) : old.history,
          workloadHistory: summary.status === 'fulfilled' ? appendWorkloadSample(old.workloadHistory, summary.value) : old.workloadHistory,
          error: summary.status === 'rejected' ? 'Connection and workload data could not be refreshed. Previously sampled values may be stale.' : null,
          resourceError: resources.status === 'rejected' ? 'Resource data could not be refreshed. Previously sampled values may be stale.' : null,
          refreshing: false, now: Date.now()
        };
      });
    };
    refresh.current = () => { void read(); };
    void read();
    const timer = setInterval(() => { void read(); }, PERFORMANCE_INTERVAL_MS);
    const onVisibility = () => { if (document.visibilityState !== 'hidden') void read(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      cancel?.();
      clearTimeout(timeout);
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      refresh.current = () => {};
    };
  }, [hostId]);
  return { ...(state.hostId === hostId ? state : empty(hostId)), refresh: () => refresh.current() };
}
