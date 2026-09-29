import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type ZccDatabase } from '@zana-ai/zcc-db';
import { PersistentTerminalSessions } from './persistent-terminal-sessions.js';
import { registerProductTerminal, MAX_RETAINED_PRODUCT_TERMINALS } from './terminal-retention.js';
import type { ProductTerminalRecord } from './product-context.js';

const roots: string[] = [];
const databases: ZccDatabase[] = [];
function database() { const root = mkdtempSync(join(tmpdir(), 'zcc-terminal-persist-')); roots.push(root); const db = openDatabase(join(root, 'zcc.sqlite')); databases.push(db); return db; }
const row = (id = 'terminal'): ProductTerminalRecord => ({ id, hostId: 'host', daemonInstanceId: 'lifetime', projectId: 'project', cwd: '/repo', profile: 'shell', title: 'Shell', status: 'running', createdAt: 1 });
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('durable product terminal ownership', () => {
  it('restores identity, output and lifecycle after reopening the database', () => {
    const db = database(); const sessions = new PersistentTerminalSessions(db);
    sessions.set('terminal', { ...row(), outputText: 'before restart\n', outputTruncated: true, outputEndOffset: 150 });
    const second = openDatabase(db.file); databases.push(second);
    const restored = new PersistentTerminalSessions(second);
    expect(restored.get('terminal')).toEqual(sessions.get('terminal'));
    restored.set('terminal', { ...restored.get('terminal')!, status: 'exited', finishedAt: 5, exitCode: 0 });
    expect(new PersistentTerminalSessions(db).get('terminal')).toMatchObject({ status: 'exited', daemonInstanceId: 'lifetime', outputText: 'before restart\n', outputEndOffset: 150 });
    expect(restored.delete('terminal')).toBe(true);
    expect(new PersistentTerminalSessions(db).size).toBe(0);
    restored.set('second', row('second')); restored.clear();
    expect(new PersistentTerminalSessions(db).size).toBe(0);
  });
  it('bounds both records and retained bytes and persists eviction', () => {
    const db = database(); const sessions = new PersistentTerminalSessions(db);
    for (let n = 0; n < MAX_RETAINED_PRODUCT_TERMINALS; n++) sessions.set(String(n), { ...row(String(n)), status: 'exited', createdAt: n });
    expect(() => sessions.set('overflow', row('overflow'))).toThrow('retention');
    registerProductTerminal(sessions, row('next'));
    expect(new PersistentTerminalSessions(db).has('0')).toBe(false);
    expect(() => sessions.set('next', { ...row('next'), outputText: 'abc', outputEndOffset: 2 })).toThrow('cursor');
    expect(() => sessions.set('next', { ...row('next'), outputText: 'a'.repeat(256 * 1024 + 1) })).toThrow('output');
    sessions.set('next', { ...row('next'), outputText: '\u0000'.repeat(256 * 1024) });
    expect(new PersistentTerminalSessions(db).get('next')?.outputText).toHaveLength(256 * 1024);
    expect(() => sessions.set('next', { ...row('next'), title: 'a'.repeat(2 * 1024 * 1024) })).toThrow('record');
    expect(() => sessions.set('next', row('wrong-id'))).toThrow('identity');
    expect(() => sessions.set('next', { ...row('next'), status: 'bogus' } as any)).toThrow();
  });
  it('refuses corrupt and oversized persisted registries instead of forgetting ownership', () => {
    const db = database(); const insert = db.sqlite.prepare('INSERT INTO product_terminal_sessions VALUES (?, ?)');
    insert.run('bad', '{'); expect(() => new PersistentTerminalSessions(db)).toThrow();
    db.sqlite.prepare('DELETE FROM product_terminal_sessions').run();
    for (let n = 0; n <= MAX_RETAINED_PRODUCT_TERMINALS; n++) insert.run(String(n), JSON.stringify(row(String(n))));
    expect(() => new PersistentTerminalSessions(db)).toThrow('retention');
  });
});
