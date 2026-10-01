import { createReadStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductHttpContext } from './product-context.js';
import { handleInstallHttp } from './install-http.js';
import { createHostArtifactReadStream, resolveHostArtifact } from '../services/hosts/host-artifact.js';

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, readFileSync: vi.fn(original.readFileSync) };
});
vi.mock('../services/hosts/host-artifact.js', () => ({
  resolveHostArtifact: vi.fn(), createHostArtifactReadStream: vi.fn()
}));

let server: Server;
let origin: string;
let directory: string;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'zcc-install-http-'));
  const tarballPath = join(directory, 'runtime.tgz');
  writeFileSync(tarballPath, Buffer.from([1, 2, 3, 4]));
  vi.mocked(resolveHostArtifact).mockResolvedValue({ tarballPath, version: 'test', protocolVersion: 40 });
  vi.mocked(createHostArtifactReadStream).mockImplementation(() => createReadStream(tarballPath));
  const ctx = { config: { getConfig: () => ({}) } } as ProductHttpContext;
  server = createServer(async (request, response) => {
    if (!await handleInstallHttp(request, response, ctx)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.mocked(readFileSync).mockReset();
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(readFileSync).mockImplementation(fs.readFileSync);
  vi.clearAllMocks();
});

describe('machine installer HTTP', () => {
  it('serves the baked script with exact bytes and no filesystem dependency', async () => {
    const script = '#!/bin/sh\nprintf "machine ready ✓\\n"\n';
    vi.stubGlobal('__ZCC_BUNDLED_INSTALL_SCRIPT__', script);
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('source asset absent'); });
    const response = await fetch(`${origin}/install.sh/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/x-shellscript');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(script)));
    expect(await response.text()).toBe(script);
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it('keeps standalone source serving available without a build-time value', async () => {
    vi.stubGlobal('__ZCC_BUNDLED_INSTALL_SCRIPT__', undefined);
    const response = await fetch(`${origin}/install.sh`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('--host-daemon-port');
  });

  it('returns an actionable bounded failure when the source asset is missing', async () => {
    vi.stubGlobal('__ZCC_BUNDLED_INSTALL_SCRIPT__', undefined);
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('ENOENT private filesystem path'); });
    const response = await fetch(`${origin}/install.sh`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'machine installer unavailable' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('serves HEAD headers without a script body', async () => {
    vi.stubGlobal('__ZCC_BUNDLED_INSTALL_SCRIPT__', '#!/bin/sh\n');
    const response = await fetch(`${origin}/install.sh`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('10');
    expect(await response.text()).toBe('');
  });

  it('rejects untrusted Host headers and unsupported methods', async () => {
    const denied = await fetch(`${origin}/install.sh`, { headers: { 'x-forwarded-host': 'attacker.invalid' } });
    expect(denied.status).toBe(403);
    const unsupported = await fetch(`${origin}/install.sh`, { method: 'POST' });
    expect(unsupported.status).toBe(405);
    expect(resolveHostArtifact).not.toHaveBeenCalled();
  });

  it('leaves unrelated paths to the owning HTTP router', async () => {
    expect((await fetch(`${origin}/unrelated`)).status).toBe(404);
  });

  it('serves version and artifact GET/HEAD responses', async () => {
    const version = await fetch(`${origin}/install/version`);
    expect(await version.json()).toEqual({ version: 'test', protocolVersion: 40 });
    const versionHead = await fetch(`${origin}/install/version`, { method: 'HEAD' });
    expect(versionHead.status).toBe(200);
    expect(await versionHead.text()).toBe('');
    const artifact = await fetch(`${origin}/install/zcc-host.tgz`);
    expect(artifact.headers.get('content-type')).toBe('application/gzip');
    expect(Buffer.from(await artifact.arrayBuffer())).toEqual(Buffer.from([1, 2, 3, 4]));
    const artifactHead = await fetch(`${origin}/install/zcc-host.tgz`, { method: 'HEAD' });
    expect(artifactHead.headers.get('content-length')).toBe('4');
    expect(await artifactHead.text()).toBe('');
    expect(createHostArtifactReadStream).toHaveBeenCalledTimes(1);
  });
});
