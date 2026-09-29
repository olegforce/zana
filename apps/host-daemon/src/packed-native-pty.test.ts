import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadPackedPty, spawnHelperPaths, type PackedPtyFile } from './packed-native-pty.js';
import { packedPtyFiles } from '../scripts/packed-pty-files.mjs';

const roots: string[] = [];
function root() { const directory = mkdtempSync(join(tmpdir(), 'zcc-packed-pty-test-')); roots.push(directory); return directory; }
afterEach(() => { for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true }); vi.unstubAllGlobals(); });
const file = (path: string, content = 'fixture'): PackedPtyFile => ({ path, base64: Buffer.from(content).toString('base64') });
const fixture = () => [file('package.json', '{}'), file('LICENSE'), file('lib/index.js'), file('prebuilds/darwin-arm64/pty.node'), file('prebuilds/darwin-arm64/spawn-helper'), file('prebuilds/linux-x64/pty.node')];

describe('packed native terminals', () => {
  it('materializes only the selected platform privately and uses BB helper discovery', () => {
    const spawn = vi.fn(); const load = vi.fn(() => ({ spawn }));
    const loaded = loadPackedPty(fixture(), { target: 'darwin-arm64', temporaryRoot: root(), load });
    expect(statSync(loaded.directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(loaded.directory, 'lib/index.js')).mode & 0o777).toBe(0o600);
    expect(statSync(join(loaded.directory, 'prebuilds/darwin-arm64/spawn-helper')).mode & 0o777).toBe(0o755);
    expect(existsSync(join(loaded.directory, 'prebuilds/linux-x64'))).toBe(false);
    expect(load).toHaveBeenCalledWith(join(loaded.directory, 'lib/index.js'));
    expect(loaded.native.spawn).toBe(spawn);
    loaded.dispose(); loaded.dispose(); expect(existsSync(loaded.directory)).toBe(false);
  });
  it('discovers both ordinary and bundled BB helper locations', () => {
    const directory = root();
    for (const path of ['build/Release/spawn-helper', 'lib/build/Debug/spawn-helper']) {
      mkdirSync(dirname(join(directory, path)), { recursive: true }); writeFileSync(join(directory, path), 'helper');
    }
    expect(spawnHelperPaths(directory, 'darwin-arm64')).toEqual([join(directory, 'build/Release/spawn-helper'), join(directory, 'lib/build/Debug/spawn-helper')]);
  });
  it.each([
    ['unsupported platform', () => fixture(), 'linux-riscv64', /unavailable/],
    ['missing platform', () => fixture(), 'linux-arm64', /incomplete/],
    ['missing helper', () => fixture().filter(row => !row.path.endsWith('spawn-helper')), 'darwin-arm64', /incomplete/],
    ['path traversal', () => [...fixture(), file('../outside')], 'darwin-arm64', /path/],
    ['duplicate', () => [...fixture(), file('LICENSE')], 'darwin-arm64', /path/],
    ['unknown executable', () => [...fixture(), file('prebuilds/linux-x64/shell')], 'darwin-arm64', /path/],
    ['file count', () => Array.from({ length: 129 }, () => file('LICENSE')), 'darwin-arm64', /too many/],
    ['encoded size', () => [...fixture(), { path: 'lib/large.js', base64: 'A'.repeat(45_000_000) }], 'darwin-arm64', /size/],
    ['total size', () => [...fixture(), { path: 'lib/a.js', base64: 'A'.repeat(24_000_000) }, { path: 'lib/b.js', base64: 'A'.repeat(24_000_000) }], 'darwin-arm64', /size/]
  ] as const)('rejects %s before any disk effects', (_name, files, target, message) => {
    const temporaryRoot = root();
    expect(() => loadPackedPty(files(), { target, temporaryRoot })).toThrow(message);
    expect(readdirSync(temporaryRoot)).toEqual([]);
  });
  it('cleans up a native load failure and can retry without stale cache', () => {
    const temporaryRoot = root();
    expect(() => loadPackedPty(fixture(), { target: 'linux-x64', temporaryRoot, load: () => { throw new Error('wrong libc'); } })).toThrow('wrong libc');
    expect(readdirSync(temporaryRoot)).toEqual([]);
    const loaded = loadPackedPty(fixture(), { target: 'linux-x64', temporaryRoot, load: () => ({ spawn: vi.fn() }) });
    loaded.dispose();
  });
  it('accepts the pinned Windows prebuild layout without installing another platform', () => {
    const files = fixture().concat(file('prebuilds/win32-x64/conpty.node'), file('prebuilds/win32-x64/conpty_console_list.node'), file('prebuilds/win32-x64/conpty/OpenConsole.exe'), file('prebuilds/win32-x64/conpty/conpty.dll'));
    const loaded = loadPackedPty(files, { target: 'win32-x64', temporaryRoot: root(), load: () => ({ spawn: vi.fn() }) });
    expect(readdirSync(join(loaded.directory, 'prebuilds'))).toEqual(['win32-x64']); loaded.dispose();
  });
  it('packs licenses and portable prebuilds, never the local rebuilt addon or debug symbols', () => {
    const files: PackedPtyFile[] = packedPtyFiles();
    expect(files.some(row => row.path === 'LICENSE')).toBe(true);
    expect(files.some(row => /build\/Release|\.pdb$|\.test\.js$/.test(row.path))).toBe(false);
    for (const target of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']) {
      expect(files.some(row => row.path === `prebuilds/${target}/pty.node`)).toBe(true);
    }
  });
  it('loads the actual portable addon, supports a TTY, resize, input and signal exit', async () => {
    const loaded = loadPackedPty(packedPtyFiles(), { temporaryRoot: root() });
    const probe = join(root(), 'probe.cjs');
    writeFileSync(probe, `console.log('TTY:' + process.stdin.isTTY + ':' + process.stdout.columns + ':' + process.stdout.rows); process.stdout.on('resize', () => console.log('RESIZE:' + process.stdout.columns + ':' + process.stdout.rows)); process.stdin.on('data', data => console.log('INPUT:' + data.toString().trim())); process.on('SIGINT', () => { console.log('INTERRUPTED'); process.exit(130); });`);
    const handle = loaded.native.spawn(process.execPath, [probe], { cwd: dirname(probe), cols: 83, rows: 27, env: { ...process.env }, name: 'xterm-256color' });
    let output = ''; handle.onData(data => { output += data; });
    const exited = new Promise<number>(resolve => handle.onExit(({ exitCode }) => resolve(exitCode)));
    try {
      await vi.waitFor(() => expect(output).toContain('TTY:true:83:27'));
      handle.resize(109, 41); await vi.waitFor(() => expect(output).toContain('RESIZE:109:41'));
      handle.write('hello-native\r'); await vi.waitFor(() => expect(output).toContain('INPUT:hello-native'));
      handle.write('\x03'); expect(await exited).toBe(130); expect(output).toContain('INTERRUPTED');
    } finally { try { handle.kill(); } catch {} loaded.dispose(); }
  });
  it('fails closed if an unbundled shim is accidentally called', async () => {
    vi.resetModules();
    const module = await import('./packed-native-pty.js');
    expect(() => module.spawn('ignored', [], {})).toThrow('incomplete');
  });
});
