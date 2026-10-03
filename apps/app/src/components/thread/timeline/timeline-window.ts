export const TIMELINE_WINDOW_SIZE = 200;
export const TERMINAL_EXPANSION_RETENTION = 24;

export function retainTerminalExpansionIds(
  previous: readonly string[],
  incoming: Iterable<string>,
  cap = TERMINAL_EXPANSION_RETENTION
): string[] {
  const next = [...previous];
  let added = false;
  for (const id of incoming) {
    if (!next.includes(id)) {
      next.push(id);
      added = true;
    }
  }
  if (next.length > cap) return next.slice(next.length - cap);
  return added ? next : (previous as string[]);
}

export function windowTimelineRows<T extends { id: string }>(
  rows: readonly T[],
  windowSize = TIMELINE_WINDOW_SIZE,
  options: { startId?: string | null; keepId?: string | null; isContextRow?: (row: T) => boolean } = {}
): { visible: readonly T[]; hiddenCount: number; hiddenAfterCount: number } {
  let start = Math.max(0, rows.length - windowSize);
  if (options.startId) {
    const index = rows.findIndex(row => row.id === options.startId);
    if (index >= 0) start = Math.min(index, start);
  }
  if (options.keepId) {
    const index = rows.findIndex((row) => row.id === options.keepId);
    if (index >= 0 && (index < start || index >= start + windowSize)) {
      start = Math.min(index, Math.max(0, rows.length - windowSize));
    }
  }
  let context: T | undefined;
  if (start > 0 && options.isContextRow && !options.isContextRow(rows[start]!)) {
    for (let index = start - 1; index >= 0; index--) {
      if (options.isContextRow(rows[index]!)) { context = rows[index]; break; }
    }
  }
  // Reserve one slot for the prompt whose reply crosses this page boundary.
  // The contiguous content tail remains pageable; search targets never disappear.
  if (context && start + windowSize >= rows.length && rows[start]?.id !== options.keepId) start++;
  const content = rows.slice(start, start + windowSize - (context ? 1 : 0));
  const visible = context ? [context, ...content] : content;
  return { visible, hiddenCount: start, hiddenAfterCount: rows.length - start - content.length };
}
