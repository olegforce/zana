import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, resetDbForTests, resolveDialect } from '../index.ts';

const roots: string[] = [];
afterEach(async () => {
  await resetDbForTests();
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'zcc-website-db-'));
  roots.push(dir);
  return dir;
}

it('shares one SQLite handle across twenty simultaneous initial requests and closes on reset', async () => {
  vi.stubEnv('DATABASE_URL', `file:${join(temp(), 'nested', 'test.db')}`);
  const clients = await Promise.all(Array.from({ length: 20 }, () => getDb()));
  expect(new Set(clients).size).toBe(1);
  const first = clients[0];
  if (first.dialect !== 'sqlite') throw new Error('Expected sqlite');
  expect(first.db.$client.open).toBe(true);
  await resetDbForTests();
  expect(first.db.$client.open).toBe(false);
  expect(await getDb()).not.toBe(first);
});

it('shares a failed initialization and permits a later corrected configuration to retry', async () => {
  const dir = temp();
  writeFileSync(join(dir, 'file'), 'not a directory');
  vi.stubEnv('DATABASE_URL', join(dir, 'file', 'db.sqlite'));
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => getDb()));
  expect(results.every(result => result.status === 'rejected')).toBe(true);
  const failures = results.filter(result => result.status === 'rejected');
  expect(new Set(failures.map(result => result.reason)).size).toBe(1);
  vi.stubEnv('DATABASE_URL', join(dir, 'working.sqlite'));
  expect((await getDb()).dialect).toBe('sqlite');
});

it.each([undefined, '', 'file:db.sqlite', '/tmp/db.sqlite', 'relative.sqlite'])('selects SQLite for %s', value => {
  expect(resolveDialect(value)).toBe('sqlite');
});
it.each(['postgres://localhost/db', 'postgresql://localhost/db', ' POSTGRES://localhost/db '])('selects Postgres for %s', value => {
  expect(resolveDialect(value)).toBe('pg');
});

it('shares one Postgres pool and releases it on reset without making a query', async () => {
  vi.stubEnv('DATABASE_URL', 'postgres://localhost/never_connect');
  const clients = await Promise.all(Array.from({ length: 20 }, () => getDb()));
  expect(new Set(clients).size).toBe(1);
  const first = clients[0];
  if (first.dialect !== 'pg') throw new Error('Expected Postgres');
  const end = vi.spyOn(first.db.$client, 'end');
  await resetDbForTests();
  expect(end).toHaveBeenCalledOnce();
  await resetDbForTests();
  expect(end).toHaveBeenCalledOnce();
});
