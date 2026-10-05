import { createHash } from 'node:crypto';
import type { PluginDatabase } from '@zana-ai/zcc-plugin-sdk';

export function applyPluginSqliteMigrations(
  runScript: (sql: string) => void,
  prepare: PluginDatabase['prepare'],
  transaction: PluginDatabase['transaction'],
  statements: readonly string[]
): void {
  runScript(
    'CREATE TABLE IF NOT EXISTS _zcc_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, statement_hash TEXT)'
  );
  const hashes = statements.map((statement) => createHash('sha256').update(statement).digest('hex'));
  const rows = prepare('SELECT id, statement_hash FROM _zcc_migrations ORDER BY id').all() as Array<{
    id: number;
    statement_hash: string | null;
  }>;
  const applied = new Map(rows.map((row) => [row.id, row.statement_hash]));
  hashes.forEach((hash, index) => {
    const recorded = applied.get(index);
    if (recorded && recorded !== hash) {
      throw new Error(
        `migration ${index} does not match the recorded statement; append a new migration instead of changing or reusing an index`
      );
    }
  });
  const record = prepare('INSERT INTO _zcc_migrations (id, applied_at, statement_hash) VALUES (?, ?, ?)');
  transaction(() => {
    statements.forEach((statement, index) => {
      if (applied.has(index)) return;
      const savepoint = `zcc_m${index}`;
      runScript(`SAVEPOINT ${savepoint}`);
      try {
        runScript(statement);
        runScript(`RELEASE SAVEPOINT ${savepoint}`);
      } catch (error) {
        runScript(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        runScript(`RELEASE SAVEPOINT ${savepoint}`);
        const message = error instanceof Error ? error.message : String(error);
        // Recover DBs that already applied ALTER ADD COLUMN before migrate became incremental.
        if (!/duplicate column name/i.test(message)) throw error;
      }
      record.run(index, Date.now(), hashes[index]);
    });
  });
}
