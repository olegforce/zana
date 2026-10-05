import { Worker } from 'node:worker_threads';
import { createSqliteDatabase, sqliteWorkerConfiguration } from '@zana-ai/zcc-db';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_MARKERS = 100_000;
const stores = new Map<string, ReturnType<typeof createSqliteDatabase>>();
function database(dataDir: string) {
  const cached = stores.get(dataDir);
  if (cached) return cached;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = createSqliteDatabase(join(dataDir, 'thread-reads.sqlite'));
  chmodSync(join(dataDir, 'thread-reads.sqlite'), 0o600);
  db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 25');
  db.exec(`CREATE TABLE IF NOT EXISTS reads (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, touched INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS reads_retention ON reads(touched, id);
    CREATE TABLE IF NOT EXISTS migration (version INTEGER PRIMARY KEY);`);
  try {
    if (!db.prepare('SELECT 1 FROM migration WHERE version = 1').get()) {
      const legacy = join(dataDir, 'thread-reads.json');
      let entries: [string, unknown][] = [];
      if (existsSync(legacy)) {
        if (statSync(legacy).size > 64 * 1024 * 1024) throw new Error('Read marker migration exceeds 64 MiB');
        let parsed: unknown;
        try { parsed = JSON.parse(readFileSync(legacy, 'utf8')); } catch { parsed = null; }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) entries = Object.entries(parsed).slice(-MAX_MARKERS);
      }
      const insert = db.prepare('INSERT OR IGNORE INTO reads VALUES (?, ?, ?)');
      db.transaction(() => {
        let order = 0;
        for (const [id, seq] of entries) if (typeof seq === 'number' && Number.isFinite(seq) && seq >= -1) insert.run(id, Math.floor(seq), ++order);
        db.prepare('INSERT INTO migration VALUES (1)').run();
      })();
      // Retain the JSON file as a migration backup; hot reads never parse it.
    }
    stores.set(dataDir, db); return db;
  } catch (error) { db.close(); throw error; }
}
/** Run legacy migration before accepting requests. */
export async function prepareThreadReads(dataDir: string): Promise<void> {
  if (stores.has(dataDir)) return;
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    const fs = require('node:fs'); const { join } = require('node:path'); let db;
    try {
      fs.mkdirSync(workerData.dir, { recursive: true, mode: 0o700 });
      const Sqlite = require(workerData.modulePath);
      db = new Sqlite(join(workerData.dir, 'thread-reads.sqlite'), { nativeBinding: workerData.nativeBinding, timeout: 25 });
      fs.chmodSync(join(workerData.dir, 'thread-reads.sqlite'), 0o600);
      db.pragma('journal_mode = WAL');
      db.exec('CREATE TABLE IF NOT EXISTS reads (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, touched INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS reads_retention ON reads(touched, id); CREATE TABLE IF NOT EXISTS migration (version INTEGER PRIMARY KEY)');
      if (!db.prepare('SELECT 1 FROM migration WHERE version=1').get()) {
        const file = join(workerData.dir, 'thread-reads.json'); let entries = [];
        if (fs.existsSync(file)) {
          if (fs.statSync(file).size > 64 * 1024 * 1024) throw Error('Read marker migration exceeds 64 MiB');
          let parsed; try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { parsed = null; }
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) entries = Object.entries(parsed).slice(-100000);
        }
        const insert = db.prepare('INSERT OR IGNORE INTO reads VALUES (?, ?, ?)');
        db.transaction(() => {
          let order = 0;
          for (const [id, seq] of entries) if (typeof seq === 'number' && Number.isFinite(seq) && seq >= -1) insert.run(id, Math.floor(seq), ++order);
          db.prepare('INSERT INTO migration VALUES (1)').run();
        })();
      }
      parentPort.postMessage({ ok: true });
    } catch (error) { parentPort.postMessage({ error: error.message }); }
    finally { db?.close(); }
  `;
  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: { ...sqliteWorkerConfiguration(), dir: dataDir }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    let settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); void worker.terminate(); if (error) reject(error); else resolve(); };
    const timer = setTimeout(() => finish(new Error('Read marker migration timed out')), 10_000);
    worker.once('message', message => finish(message.error ? new Error(message.error) : undefined));
    worker.once('error', error => finish(error instanceof Error ? error : new Error(String(error)))); worker.once('exit', () => finish(new Error('Read marker migration worker stopped')));
  });
  database(dataDir);
}
export function closeThreadReads(dataDir: string): void { stores.get(dataDir)?.close(); stores.delete(dataDir); }
export function loadThreadReads(dataDir: string, ids?: readonly string[]): Record<string, number> {
  const db = database(dataDir);
  if (ids) {
    const lookup = db.prepare('SELECT seq FROM reads WHERE id = ?');
    const result: Record<string, number> = Object.create(null);
    for (const id of ids) { const row = lookup.get(id) as { seq: number } | undefined; if (row) result[id] = row.seq; }
    return result;
  }
  const rows = db.prepare('SELECT id, seq FROM reads LIMIT ?').all(MAX_MARKERS) as { id: string; seq: number }[];
  return Object.fromEntries(rows.map(row => [row.id, row.seq]));
}
/** Absent markers remain null so historical threads are not dumped as unread. */
export function peekThreadReadSeq(dataDir: string, threadId: string): number | null {
  const row = database(dataDir).prepare('SELECT seq FROM reads WHERE id = ?').get(threadId) as { seq: number } | undefined;
  return row?.seq ?? null;
}
export function getThreadReadSeq(dataDir: string, threadId: string): number { return peekThreadReadSeq(dataDir, threadId) ?? 0; }
export function markThreadRead(dataDir: string, threadId: string, lastReadSeq: number): number {
  if (!Number.isFinite(lastReadSeq)) throw new Error('Read sequence must be finite');
  const seq = Math.max(-1, Math.floor(lastReadSeq));
  const db = database(dataDir);
  db.transaction(() => {
    db.prepare('INSERT INTO reads VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET seq=excluded.seq, touched=excluded.touched').run(threadId, seq, Date.now());
    const { count } = db.prepare('SELECT COUNT(*) AS count FROM reads').get() as { count: number };
    if (count > MAX_MARKERS) db.prepare('DELETE FROM reads WHERE id IN (SELECT id FROM reads ORDER BY touched, id LIMIT ?)').run(count - MAX_MARKERS);
  })();
  return seq;
}
