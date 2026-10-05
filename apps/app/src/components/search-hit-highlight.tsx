import type { SearchHit } from '@zana-ai/zcc-domain/product';

/** Matching belongs to the server worker. Render its offsets without executing a query. */
export function highlightSearchHit(hit: Pick<SearchHit, 'preview' | 'column' | 'match'>) {
  const start = hit.column - 1;
  if (!Number.isSafeInteger(start) || start < 0 || start >= hit.preview.length || !hit.match) return hit.preview;
  const end = Math.min(hit.preview.length, start + hit.match.length);
  return <>{hit.preview.slice(0, start)}<mark>{hit.preview.slice(start, end)}</mark>{hit.preview.slice(end)}</>;
}
