import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { restartInstalledHost } from './restart-installed-host.js';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), lock: vi.fn(), release: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('./lock.js', () => ({ acquireDaemonLock: mocks.lock }));
let dir: string, entry: string;
const hostId = '11111111-1111-4111-8111-111111111111';
const auth = { hostId, hostKey: 'private-existing-key', serverUrl: 'https://example.test/t/route' };
const saveAuth = (value: unknown) => writeFileSync(join(dir, 'auth.json'), JSON.stringify(value));
beforeEach(() => {
  vi.resetAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'zcc-restart-')); mkdirSync(join(dir, 'runtime'));
  entry = join(dir, 'runtime/join.mjs'); writeFileSync(entry, '// fixture');
  saveAuth(auth); writeFileSync(join(dir, 'host-daemon.port'), '38888');
  mocks.lock.mockReturnValue(mocks.release);
  mocks.spawn.mockImplementation(() => { const child = Object.assign(new EventEmitter(), { unref: vi.fn() }); queueMicrotask(() => child.emit('spawn')); return child; });
});
afterEach(() => { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });

describe('restart saved machine enrollment', () => {
  it('verifies the owner before starting the installed entry and leaves credentials intact', async () => {
    const before = readFileSync(join(dir, 'auth.json'), 'utf8');
    await restartInstalledHost(dir, entry);
    expect(mocks.lock).toHaveBeenCalledWith(dir, { steal: true });
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.release.mock.invocationCallOrder[0]).toBeLessThan(mocks.spawn.mock.invocationCallOrder[0]);
    const [executable, argv, options] = mocks.spawn.mock.calls[0];
    expect(executable).toBe(process.execPath);
    expect(argv).toEqual([entry, 'join', '--host-id', hostId, '--server-url', auth.serverUrl, '--host-daemon-port', '38888', '--auto-update']);
    expect(options.env.PATH.split(':')[0]).toBe(dirname(process.execPath));
    expect(argv).not.toContain('--join-code'); expect(argv).not.toContain(auth.hostKey);
    expect(options).toMatchObject({ detached: true, stdio: 'ignore', cwd: dir, env: { ZCC_DATA_DIR: dir, ZCC_HOST_SERVICE_MANAGED: '0' } });
    expect(readFileSync(join(dir, 'auth.json'), 'utf8')).toBe(before);
  });
  it('recovers a legacy address only from a matching local daemon status', async () => {
    saveAuth({ ...auth, serverUrl: undefined });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ hostId, serverUrl: auth.serverUrl })));
    await restartInstalledHost(dir, entry);
    expect(mocks.spawn.mock.calls[0][1]).toContain(auth.serverUrl);
  });
  it.each([
    ['wrong identity', () => Response.json({ hostId: 'another-host', serverUrl: auth.serverUrl })],
    ['oversize status', () => new Response('x'.repeat(4097))],
    ['failed status', () => new Response('', { status: 503 })],
    ['missing body', () => new Response(null, { status: 204 })]
  ] as const)('rejects %s without signalling a process', async (_label, response) => {
    saveAuth({ ...auth, serverUrl: undefined }); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));
    await expect(restartInstalledHost(dir, entry)).rejects.toThrow();
    expect(mocks.lock).not.toHaveBeenCalled(); expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it.each(['0', '65536', 'not-a-port'])('refuses invalid port %s', async port => {
    writeFileSync(join(dir, 'host-daemon.port'), port);
    await expect(restartInstalledHost(dir, entry)).rejects.toThrow('port'); expect(mocks.lock).not.toHaveBeenCalled();
  });
  it.each(['file:///tmp/host', 'https://user:secret@example.test/', 'https://example.test/?secret=key'])('refuses unsafe saved URL %s', async serverUrl => {
    saveAuth({ ...auth, serverUrl });
    await expect(restartInstalledHost(dir, entry)).rejects.toThrow('address'); expect(mocks.lock).not.toHaveBeenCalled();
  });
  it('refuses an escaped executable and missing enrollment', async () => {
    const outside = join(dir, 'outside.mjs'); writeFileSync(outside, '');
    const link = join(dir, 'runtime/escape.mjs'); symlinkSync(outside, link);
    await expect(restartInstalledHost(dir, link)).rejects.toThrow('outside');
    rmSync(join(dir, 'auth.json')); await expect(restartInstalledHost(dir, entry)).rejects.toThrow('enrollment');
    expect(mocks.lock).not.toHaveBeenCalled();
  });
  it('fails closed for unverified PID ownership and propagates spawn failure', async () => {
    mocks.lock.mockImplementationOnce(() => { throw new Error('Process ownership cannot be verified'); });
    await expect(restartInstalledHost(dir, entry)).rejects.toThrow('ownership'); expect(mocks.spawn).not.toHaveBeenCalled();
    mocks.spawn.mockImplementationOnce(() => { const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('spawn failed'))); return child; });
    await expect(restartInstalledHost(dir, entry)).rejects.toThrow('spawn failed');
  });
});
