import type { ExecutionBoardSnapshot } from '@zana-ai/zcc-domain/product';
export const JOB_EVENT_LIMIT = 500;

/** Match backend retention; never retain a pruned lifetime history in the renderer. */
export function mergeExecutionEvents(current: ExecutionBoardSnapshot | null, next: ExecutionBoardSnapshot, after: number): ExecutionBoardSnapshot {
  const events = after > 0 && current ? current.events.concat(next.events) : next.events;
  const seen = new Set<string>();
  const tail: ExecutionBoardSnapshot['events'] = [];
  let dropped = false;
  for (let i = events.length - 1; i >= 0; i--) {
    if (seen.has(events[i].id)) continue;
    seen.add(events[i].id);
    if (tail.length < JOB_EVENT_LIMIT) tail.push(events[i]); else dropped = true;
  }
  tail.reverse();
  return { ...next, events: tail, truncated: next.truncated || dropped || (!!current?.truncated && after > 0) };
}
