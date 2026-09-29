import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openDatabase } from '../connection.js';

it('installs polling indexes once and avoids sorting connections or scanning idle history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zcc-performance-indexes-'));
  const file = join(dir, 'runtime.sqlite');
  let db = openDatabase(file);
  try {
    // Simulate a database made by the prior release, then upgrade and reopen.
    db.sqlite.exec('DROP INDEX host_sessions_recent_idx; DROP INDEX threads_live_host_idx; DELETE FROM runtime_schema_migrations WHERE version = 25');
    db.close(); db = openDatabase(file);
    db.close(); db = openDatabase(file);
    const connectionPlan = db.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT created_at, closed_at, close_reason
      FROM host_sessions WHERE host_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 6`).all('host');
    expect(JSON.stringify(connectionPlan)).toContain('host_sessions_recent_idx');
    expect(JSON.stringify(connectionPlan)).not.toContain('TEMP B-TREE');
    const workPlan = db.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT id FROM threads
      WHERE host_id = ? AND status IN ('starting', 'active', 'stopping') LIMIT ?`).all('host', 1001);
    expect(JSON.stringify(workPlan)).toContain('threads_live_host_idx');
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM runtime_schema_migrations WHERE version = 25').get()).toEqual({ n: 1 });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
