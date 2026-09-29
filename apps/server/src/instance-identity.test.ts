import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readProductInstanceId } from './instance-identity.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const path = mkdtempSync(join(tmpdir(), 'zcc-instance-')); roots.push(path); return path; };
it('persists one private identity independent of other instances', () => {
  const dir = root(), id = readProductInstanceId(dir);
  expect(readProductInstanceId(dir)).toBe(id);
  expect(readProductInstanceId(root())).not.toBe(id);
  expect(statSync(join(dir, 'product-instance.json')).mode & 0o777).toBe(0o600);
  expect(readdirSync(dir)).toEqual(['product-instance.json']);
});
it('refuses to silently replace damaged identities', () => {
  for (const contents of ['{}', 'invalid', '{"id":"other"}', 'x'.repeat(1025)]) {
    const dir = root(), path = join(dir, 'product-instance.json'); writeFileSync(path, contents);
    expect(() => readProductInstanceId(dir)).toThrow();
    expect(readFileSync(path, 'utf8')).toBe(contents);
  }
});
