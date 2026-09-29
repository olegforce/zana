import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { accountInstances, readSharedTarget, validateSharedTarget, writeSharedTarget } from './shared-target.js';
it('persists only instance identity atomically and fails closed on damaged state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shared-target-')), file = join(dir, 'target.json');
  try {
    expect(readSharedTarget(file)).toEqual({ kind: 'local' });
    const target = { kind: 'connect' as const, serverId: randomUUID(), instanceId: randomUUID() };
    writeSharedTarget(file, target); expect(readSharedTarget(file)).toEqual(target); expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).not.toContain('url');
    for (const input of [null, {}, { kind: 'custom', url: 'https://evil.example' }, { ...target, instanceId: 'bad' }]) expect(() => validateSharedTarget(input)).toThrow();
    for (const input of ['{', 'x'.repeat(1025), '{"kind":"connect"}']) { writeFileSync(file, input); expect(() => readSharedTarget(file)).toThrow(); expect(readFileSync(file, 'utf8')).toBe(input); }
    writeSharedTarget(file, { kind: 'local' }); expect(readSharedTarget(file)).toEqual({ kind: 'local' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('selects only bound account instances at valid Connect destinations', () => {
  const row = { id: randomUUID(), instanceId: randomUUID(), name: 'Shared', browserUrl: 'https://alice.zana-ide.com', live: true };
  expect(accountInstances({ servers: [row, { ...row, revoked: true }, { ...row, instanceId: null }] })).toEqual([{ id: row.id, instanceId: row.instanceId, name: 'Shared', url: row.browserUrl, online: true }]);
  for (const url of ['https://zana-ide.com.evil.example', 'http://alice.zana-ide.com', 'https://alice.zana-ide.com/evil', 'https://user@alice.zana-ide.com', 'https://alice.zana-ide.com:9999']) expect(() => accountInstances({ servers: [{ ...row, browserUrl: url }] })).toThrow();
  for (const value of [null, {}, { servers: {} }, { servers: Array(201).fill(row) }]) expect(() => accountInstances(value)).toThrow();
});
