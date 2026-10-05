import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { prepareThreadReads, closeThreadReads, loadThreadReads, markThreadRead, peekThreadReadSeq } from './thread-reads';
const dirs: string[] = [];
async function root() { const dir = await mkdtemp(join(tmpdir(), 'read-markers-')); dirs.push(dir); return dir; }
afterEach(async () => { for (const dir of dirs.splice(0)) { closeThreadReads(dir); await rm(dir, { recursive: true, force: true }); } });
it('migrates valid legacy markers off-loop once and retains the original backup', async () => {
  const dir = await root(); const legacy = JSON.stringify({ first: 3.8, unread: -1, invalid: 'bad', negative: -5 }); await writeFile(join(dir, 'thread-reads.json'), legacy);
  await prepareThreadReads(dir); expect(loadThreadReads(dir)).toEqual({ first: 3, unread: -1 }); expect(loadThreadReads(dir, ['first', 'unknown'])).toEqual({ first: 3 });
  markThreadRead(dir, 'first', 9); closeThreadReads(dir); await writeFile(join(dir, 'thread-reads.json'), '{}'); await prepareThreadReads(dir);
  expect(peekThreadReadSeq(dir, 'first')).toBe(9); expect(await readFile(join(dir, 'thread-reads.json'), 'utf8')).toBe('{}');
  await expect(prepareThreadReads(dir)).resolves.toBeUndefined(); expect(() => markThreadRead(dir, 'first', NaN)).toThrow('finite');
});
it('keeps corrupt legacy bytes as a backup without making app startup fail', async () => {
  const dir = await root(); await writeFile(join(dir, 'thread-reads.json'), '{bad'); await prepareThreadReads(dir); expect(loadThreadReads(dir)).toEqual({}); expect(await readFile(join(dir, 'thread-reads.json'), 'utf8')).toBe('{bad');
});
it('bounds migration and retention to the most recent 100000 markers', async () => {
  const dir = await root(); await writeFile(join(dir, 'thread-reads.json'), JSON.stringify(Object.fromEntries(Array.from({ length: 100005 }, (_, i) => [String(i), i]))));
  let ticks = 0; const timer = setInterval(() => ticks++, 1);
  try { await prepareThreadReads(dir); expect(ticks).toBeGreaterThan(5); } finally { clearInterval(timer); }
  expect(peekThreadReadSeq(dir, '0')).toBeNull(); markThreadRead(dir, 'new', 12); expect(Object.keys(loadThreadReads(dir))).toHaveLength(100000); expect(peekThreadReadSeq(dir, 'new')).toBe(12);
});

it('supports bounded cold callers and preserves invalid legacy record types', async () => {
  const dir = await root(); await writeFile(join(dir, 'thread-reads.json'), JSON.stringify({ a: 1.5, b: -1, c: 'bad', d: -10 }));
  expect(loadThreadReads(dir)).toEqual({ a: 1, b: -1 }); closeThreadReads(dir);
  await writeFile(join(dir, 'thread-reads.json'), '{}'); expect(loadThreadReads(dir)).toEqual({ a: 1, b: -1 });
  const invalid = await root(); await writeFile(join(invalid, 'thread-reads.json'), '[1,2]'); expect(loadThreadReads(invalid)).toEqual({});
});
it('closes a failed cold migration and leaves the oversized backup untouched', async () => {
  const { open } = await import('node:fs/promises'); const dir = await root(); const file = await open(join(dir, 'thread-reads.json'), 'w'); await file.truncate(64 * 1024 * 1024 + 1); await file.close();
  expect(() => loadThreadReads(dir)).toThrow('64 MiB'); await expect(prepareThreadReads(dir)).rejects.toThrow('64 MiB');
});
