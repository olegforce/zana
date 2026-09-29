import type { ZccDatabase } from '../connection.js';

// SQLite's default trim removes only ASCII spaces; resume tokens historically
// use String.trim(), including tabs, newlines and Unicode whitespace.
const CHECKPOINT_WHITESPACE = '\u0009\u000a\u000b\u000c\u000d \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';

/** Read only the resume token, never materialize a conversation's transcript. */
export function getLatestConversationCheckpoint(
  db: ZccDatabase,
  threadId: string
): { sequence: number; checkpoint: string } | null {
  return db.sqlite.prepare(`
    SELECT sequence, (
      WITH RECURSIVE nested(value) AS (
        SELECT payload
        UNION ALL
        SELECT CASE WHEN json_type(value, '$.event') = 'object'
          THEN json_extract(value, '$.event') ELSE json_extract(value, '$.payload') END
        FROM nested
        WHERE (json_type(value, '$.providerCheckpointId') IS NOT 'text'
          OR trim(json_extract(value, '$.providerCheckpointId'), $whitespace) = '')
          AND (json_type(value, '$.event') = 'object' OR json_type(value, '$.payload') = 'object')
      )
      SELECT trim(json_extract(value, '$.providerCheckpointId'), $whitespace) FROM nested
      WHERE json_type(value, '$.providerCheckpointId') = 'text'
        AND trim(json_extract(value, '$.providerCheckpointId'), $whitespace) != '' LIMIT 1
    ) AS checkpoint
    FROM thread_events WHERE thread_id = $threadId AND checkpoint IS NOT NULL
    ORDER BY sequence DESC LIMIT 1
  `).get({ threadId, whitespace: CHECKPOINT_WHITESPACE }) as { sequence: number; checkpoint: string } | undefined ?? null;
}
