import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { protectPreviewServer, protectPreviewPort, isProtectedPreviewPort } from './protected-ports.mjs';
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
it('protects dynamic service ports across listener lifetime and fixed control/debug ports', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ports-')); dirs.push(dir);
  const server = createServer(); protectPreviewServer(server, dir);
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = (server.address() as any).port;
  expect(isProtectedPreviewPort(port, dir)).toBe(true);
  const closed = once(server, 'close'); server.close(); await closed;
  expect(isProtectedPreviewPort(port, dir)).toBe(false);
  for (const control of [8780, 8781, 8785, 9222, 9229]) expect(isProtectedPreviewPort(control, dir)).toBe(true);
});
it('prunes dead markers and fails closed when the registry is unreadable or exceeds its cap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ports-')); dirs.push(dir); const registry = join(dir, 'preview-protected-ports');
  expect(isProtectedPreviewPort(3000, dir)).toBe(false);
  mkdirSync(registry); writeFileSync(join(registry, '3000-2147483647'), ''); writeFileSync(join(registry, 'ignored'), '');
  expect(isProtectedPreviewPort(3000, dir)).toBe(false);
  for (let i = 0; i < 257; i++) writeFileSync(join(registry, `extra-${i}`), '');
  expect(isProtectedPreviewPort(3000, dir)).toBe(true);
  rmSync(registry, { recursive: true }); writeFileSync(registry, ''); expect(isProtectedPreviewPort(3000, dir)).toBe(true);
});

it('reference-counts explicitly protected dev ports and validates input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ports-')); dirs.push(dir);
  expect(() => protectPreviewPort(0, dir)).toThrow();
  const a = protectPreviewPort(5173, dir), b = protectPreviewPort(5173, dir);
  a(); a(); expect(isProtectedPreviewPort(5173, dir)).toBe(true);
  b(); expect(isProtectedPreviewPort(5173, dir)).toBe(false);
});

it('makes bounded progress pruning a large stale registry after crashes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ports-')); dirs.push(dir); const registry = join(dir, 'preview-protected-ports'); mkdirSync(registry);
  for (let port = 20000; port < 20300; port++) writeFileSync(join(registry, `${port}-2147483647`), '');
  expect(isProtectedPreviewPort(3000, dir)).toBe(true);
  expect(isProtectedPreviewPort(3000, dir)).toBe(false);
});
