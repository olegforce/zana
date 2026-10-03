import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let now = Date.now();
const snapshot = () => now;
const idleSubscribe = () => () => {};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** Only live elapsed-time labels subscribe; the transcript itself never ticks. */
export function useTimelineClock(enabled: boolean): number {
  const current = useSyncExternalStore(enabled ? subscribe : idleSubscribe, snapshot, snapshot);
  return enabled ? current : Date.now();
}
