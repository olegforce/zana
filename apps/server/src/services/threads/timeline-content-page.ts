import type { TimelineRow } from '@zana-ai/zcc-server-contract';
import { ThreadCreateError } from '../../http/thread-create.js';

export const TIMELINE_PAGE_BYTES = 4 * 1024 * 1024;
export const TIMELINE_PAGE_LEAVES = 500;

export function nestedTimelineRows(row: TimelineRow): TimelineRow[] | null {
  if (row.kind === 'turn') return row.children?.length ? row.children : null;
  if (row.kind === 'work' && row.workKind === 'delegation') return row.childRows.length ? row.childRows : null;
  return null;
}

function replaceChildren(row: TimelineRow, children: TimelineRow[]): TimelineRow {
  if (row.kind === 'turn') return { ...row, children };
  if (row.kind === 'work' && row.workKind === 'delegation') return { ...row, childRows: children };
  return row;
}

/** Pages leaves, retaining parent identities so callers can merge nested turns. */
export function pageTimelineRows(rows: TimelineRow[], before?: number, maxBytes = TIMELINE_PAGE_BYTES, maxLeaves = TIMELINE_PAGE_LEAVES) {
  const costs: number[] = [];
  const measure = (items: TimelineRow[], parentBytes: number): void => {
    for (const row of items) {
      const children = nestedTimelineRows(row);
      if (children) measure(children, parentBytes + Buffer.byteLength(JSON.stringify(replaceChildren(row, []))));
      else costs.push(parentBytes + Buffer.byteLength(JSON.stringify(row)));
    }
  };
  measure(rows, 0);
  const end = Math.min(before ?? costs.length, costs.length);
  let start = end;
  let bytes = 0;
  while (start > 0 && end - start < maxLeaves) {
    const cost = costs[start - 1]!;
    if (start < end && bytes + cost > maxBytes) break;
    bytes += cost;
    start--;
  }
  let position = 0;
  const select = (items: TimelineRow[]): TimelineRow[] => items.flatMap(row => {
    const children = nestedTimelineRows(row);
    if (!children) { const index = position++; return index >= start && index < end ? [row] : []; }
    const selected = select(children);
    return selected.length ? [replaceChildren(row, selected)] : [];
  });
  return { rows: select(rows), start, end, total: costs.length };
}

export interface HistoryCursor {
  v: 1; threadId: string; surface: string; start: number; end: number; beforeLeaf?: number; tip: number;
}
export function encodeHistoryCursor(cursor: Omit<HistoryCursor, 'v'>): string {
  return 'history1:' + Buffer.from(JSON.stringify({ v: 1, ...cursor })).toString('base64url');
}
export function decodeHistoryCursor(raw: string | null | undefined, threadId: string, surface: string): HistoryCursor | null {
  if (!raw?.startsWith('history1:')) return null;
  try {
    if (raw.length > 2048) throw new Error();
    const cursor = JSON.parse(Buffer.from(raw.slice(9), 'base64url').toString('utf8')) as HistoryCursor;
    if (cursor.v !== 1 || cursor.threadId !== threadId || cursor.surface !== surface
      || ![cursor.start, cursor.end, cursor.tip].every(n => Number.isSafeInteger(n) && n >= 0)
      || cursor.start < 1 || cursor.start >= cursor.end || cursor.end > cursor.tip + 1
      || (cursor.beforeLeaf !== undefined && (!Number.isSafeInteger(cursor.beforeLeaf) || cursor.beforeLeaf < 1))) throw new Error();
    return cursor;
  } catch { throw new ThreadCreateError(400, 'invalid-history-cursor', 'This history page is no longer available. Reload the conversation.'); }
}
