import type { ZccDatabase } from '@zana-ai/zcc-db';
import type { HostTerminalSessionRecord } from './host-hub.js';

/** SQLite and the bounded terminal cache advance together. Records are flat;
 * retained strings are immutable, so the checkpoint doesn't copy tail bytes.
 * No notification or asynchronous work belongs inside apply().
 */
export function commitHostEventBatch(
  db: ZccDatabase,
  terminals: Map<string, HostTerminalSessionRecord>,
  apply: () => void
): void {
  const before = new Map([...terminals].map(([id, row]) => [id, { reference: row, value: { ...row } }]));
  try { db.transaction(apply); }
  catch (error) {
    // SQLite has rolled back already. Restore only the memory cache, bypassing
    // PersistentTerminalSessions' database writes (which could also be failing).
    Map.prototype.clear.call(terminals);
    for (const [id, { reference, value }] of before) {
      // Launch acknowledgements may still hold this exact record object.
      for (const key of Object.keys(reference)) if (!(key in value)) delete (reference as unknown as Record<string, unknown>)[key];
      Object.assign(reference, value);
      Map.prototype.set.call(terminals, id, reference);
    }
    throw error;
  }
}
