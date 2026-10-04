import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('packages only compiled plugin runtimes and prepares them on every packaging path', () => {
  const yml = readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8');
  expect(yml).toContain('beforePack: scripts/before-pack-plugins.mjs');
  expect(yml).toContain('from: out/packaged-plugins');
  expect(yml).not.toMatch(/from: plugins\s/);
});
