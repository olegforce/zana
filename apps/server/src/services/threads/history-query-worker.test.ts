import { expect, it } from 'vitest';
import { historyQueryWorker } from './history-query-worker';
it('rejects missing databases and releases capacity after errors', async () => {
  for (let i = 0; i < 3; i++) await expect(historyQueryWorker('/tmp/nonexistent-zcc-history-' + i, 'SELECT 1', [])).rejects.toThrow();
});

it('bounds concurrency and queued searches, then recovers capacity', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path'); const { createSqliteDatabase } = await import('@zana-ai/zcc-db');
  const dir = await mkdtemp(join(tmpdir(), 'history-worker-')); const file = join(dir, 'test.sqlite'); const db = createSqliteDatabase(file); db.exec('CREATE TABLE seed (id INTEGER)'); db.close();
  try {
    const query = 'WITH RECURSIVE nums(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM nums WHERE x<20000) SELECT SUM(x) AS value FROM nums';
    const work = Array.from({ length: 18 }, () => historyQueryWorker<{ value: number }>(file, query, []));
    await expect(historyQueryWorker(file, query, [])).rejects.toThrow('busy');
    const rows = await Promise.all(work); expect(rows.every(row => row[0].value === 200010000)).toBe(true);
    await expect(historyQueryWorker(file, 'invalid sql', [])).rejects.toThrow();
    expect(await historyQueryWorker(file, 'SELECT 1 AS value', [])).toEqual([{ value: 1 }]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
