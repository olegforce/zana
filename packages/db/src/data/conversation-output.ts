import type { ZccDatabase } from '../connection.js';

export const CONVERSATION_OUTPUT_THRESHOLD = 32 * 1024;
export const CONVERSATION_OUTPUT_PREVIEW_CHARS = 2 * 1024;
export const CONVERSATION_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const OUTPUT_PATHS: Record<string, string> = {
  commandExecution: 'aggregatedOutput', toolCall: 'result', imageGeneration: 'result',
  webFetch: 'resultText', webSearch: 'resultText'
};

function object(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function prepareConversationOutput(type: string, payload: unknown, now: number): {
  payload: unknown;
  output?: { path: string; value: string; expiresAt: number };
} {
  if (type !== 'item/completed' || !object(payload)) return { payload };
  const wrapped = object(payload.event);
  const event = wrapped ? payload.event : payload;
  if (!object(event.item)) return { payload };
  const path = OUTPUT_PATHS[event.item.type];
  const value = path && event.item[path];
  if (typeof value !== 'string' || value.length <= CONVERSATION_OUTPUT_THRESHOLD) return { payload };
  const expiresAt = now + CONVERSATION_OUTPUT_RETENTION_MS;
  const item = { ...event.item, [path]: outputPreview(value), truncation: {
    ...(object(event.item.truncation) ? event.item.truncation : {}),
    [path]: { originalLength: value.length, retainedHeadLength: CONVERSATION_OUTPUT_PREVIEW_CHARS,
      retainedTailLength: CONVERSATION_OUTPUT_PREVIEW_CHARS, truncatedAt: expiresAt }
  } };
  return { payload: wrapped ? { ...payload, event: { ...event, item } } : { ...event, item },
    output: { path, value, expiresAt } };
}

function outputPreview(value: string): string {
  // Avoid splitting a surrogate pair at either edge.
  let head = CONVERSATION_OUTPUT_PREVIEW_CHARS;
  let tail = value.length - CONVERSATION_OUTPUT_PREVIEW_CHARS;
  if (/[\uD800-\uDBFF]/.test(value[head - 1]!)) head--;
  if (/[\uDC00-\uDFFF]/.test(value[tail]!)) tail++;
  return value.slice(0, head) + '\n\n[… output preview; full output retained for seven days …]\n\n' + value.slice(tail);
}

export function storeConversationOutput(db: ZccDatabase, eventId: string, output: {
  path: string; value: string; expiresAt: number;
}): void {
  db.sqlite.prepare(`INSERT INTO conversation_event_outputs (event_id, output_path, value, expires_at)
    VALUES (?, ?, ?, ?)`).run(eventId, output.path, output.value, output.expiresAt);
}

/** SQL measures the escaped value before allowing it across the native boundary. */
export function hydrateConversationOutputs<T extends { id: string; payload: unknown }>(
  db: ZccDatabase, rows: T[], maxBytes: number, now = Date.now()
): T[] {
  let remaining = maxBytes - rows.reduce((n, row) => n + Buffer.byteLength(JSON.stringify(row.payload)), 0);
  const query = db.sqlite.prepare(`SELECT output_path, CASE WHEN length(CAST(json_quote(value) AS BLOB)) <= ?
    THEN value ELSE NULL END AS value FROM conversation_event_outputs WHERE event_id = ? AND expires_at > ?`);
  return rows.map(row => {
    if (remaining <= 0 || !object(row.payload)) return row;
    const output = query.get(remaining, row.id, now) as { output_path: string; value: string | null } | undefined;
    if (!output || output.value === null) return row;
    const wrapped = object(row.payload.event);
    const event = wrapped ? row.payload.event : row.payload;
    if (!object(event.item)) return row;
    const item = { ...event.item, [output.output_path]: output.value };
    if (object(item.truncation)) {
      item.truncation = { ...item.truncation };
      delete item.truncation[output.output_path];
    }
    remaining -= Buffer.byteLength(JSON.stringify(output.value));
    return { ...row, payload: wrapped ? { ...row.payload, event: { ...event, item } } : { ...event, item } };
  });
}

/** Also bounds old inline outputs without rewriting or loading their full bodies. */
export function conversationPreviewPayloadSql(maxChars: number): string {
  const max = Math.max(256, Math.min(CONVERSATION_OUTPUT_THRESHOLD, Math.floor(maxChars)));
  const paths = ['$.item.aggregatedOutput', '$.item.result', '$.item.resultText',
    '$.event.item.aggregatedOutput', '$.event.item.result', '$.event.item.resultText'];
  const replacements = paths.flatMap(path => [
    `CASE WHEN json_type(payload, '${path}') = 'text' AND length(json_extract(payload, '${path}')) > ${max} THEN '${path}' ELSE '$.__no_output_preview__' END`,
    `substr(json_extract(payload, '${path}'), 1, ${Math.floor(max / 2)}) || char(10) || '[… output preview …]' || char(10) || substr(json_extract(payload, '${path}'), -${Math.floor(max / 2)})`
  ]);
  return `CASE WHEN type IN ('item/started', 'item/completed') AND length(payload) > ${max}
    THEN json_replace(payload, ${replacements.join(', ')}) ELSE payload END`;
}

/** Small, resumable maintenance; no history payload enters JavaScript. */
export function maintainConversationHistory(db: ZccDatabase, now = Date.now()): { snapshots: number; outputs: number } {
  return db.transaction(() => {
    const outputs = db.sqlite.prepare(`DELETE FROM conversation_event_outputs WHERE event_id IN (
      SELECT event_id FROM conversation_event_outputs WHERE expires_at <= ? ORDER BY expires_at LIMIT 32
    )`).run(now).changes;
    const cursor = db.sqlite.prepare("SELECT thread_id, sequence FROM conversation_history_maintenance WHERE key = 'diffs'")
      .get() as { thread_id: string; sequence: number } | undefined;
    const candidates = db.sqlite.prepare(`SELECT id, thread_id, sequence FROM thread_events INDEXED BY thread_events_diff_cleanup_idx
      WHERE type = 'turn/diff/updated' AND (thread_id, sequence) > (?, ?)
      ORDER BY thread_id, sequence LIMIT 32`).all(cursor?.thread_id ?? '', cursor?.sequence ?? 0) as
      { id: string; thread_id: string; sequence: number }[];
    // Bound scanned rows as well as deletions. Preserve each thread's current
    // high-water mark, then revisit it after a subsequent sweep wraps around.
    const remove = db.sqlite.prepare(`DELETE FROM thread_events WHERE id = ? AND sequence < (
      SELECT MAX(sequence) FROM thread_events AS latest WHERE latest.thread_id = thread_events.thread_id)`);
    let snapshots = 0;
    for (const row of candidates) snapshots += remove.run(row.id).changes;
    const last = candidates.at(-1);
    db.sqlite.prepare(`INSERT INTO conversation_history_maintenance (key, thread_id, sequence) VALUES ('diffs', ?, ?)
      ON CONFLICT(key) DO UPDATE SET thread_id = excluded.thread_id, sequence = excluded.sequence`)
      .run(last?.thread_id ?? '', last?.sequence ?? 0);
    return { snapshots, outputs };
  });
}
