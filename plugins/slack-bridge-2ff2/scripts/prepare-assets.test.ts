import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => ({ mkdir: vi.fn(), copyFile: vi.fn() }));
vi.mock('node:fs/promises', () => files);

beforeEach(() => {
  vi.resetModules();
  files.mkdir.mockReset().mockResolvedValue(undefined);
  files.copyFile.mockReset().mockResolvedValue(undefined);
});

describe('Slack runtime assets', () => {
  it('copies the installed Mermaid browser bundle into the packaged asset directory', async () => {
    await import('./prepare-assets.mjs');
    const assets = new URL('../assets/', import.meta.url);
    expect(files.mkdir).toHaveBeenCalledWith(assets, { recursive: true });
    const [source, destination] = files.copyFile.mock.calls[0];
    expect(source).toMatch(/mermaid[/\\]dist[/\\]mermaid\.min\.js$/);
    expect(readFileSync(source, 'utf8').length).toBeGreaterThan(100_000);
    expect(fileURLToPath(destination)).toBe(fileURLToPath(new URL('mermaid.min.js', assets)));
  });

  it('fails packaging when the asset directory cannot be created', async () => {
    files.mkdir.mockRejectedValueOnce(new Error('asset directory unavailable'));
    await expect(import('./prepare-assets.mjs')).rejects.toThrow('asset directory unavailable');
    expect(files.copyFile).not.toHaveBeenCalled();
  });

  it('fails packaging when the browser bundle cannot be copied', async () => {
    files.copyFile.mockRejectedValueOnce(new Error('bundle copy failed'));
    await expect(import('./prepare-assets.mjs')).rejects.toThrow('bundle copy failed');
  });
});
