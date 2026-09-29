/**
 * The join artifact carries the pinned node-pty runtime and its upstream
 * prebuilds. Materialize only this machine's binary in a private process-owned
 * directory; never rebuild or replace the desktop's installed native addon.
 * Keeping the payload inside join.mjs preserves the updater's five-file format.
 *
 * Spawn-helper discovery is adapted from BB's terminal-manager.ts (MIT).
 * See docs/third-party/BB-LICENSE and bb-shared-machines.md.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type * as NodePty from 'node-pty';

export interface PackedPtyFile { path: string; base64: string }
declare const __ZCC_PACKED_PTY_FILES__: readonly PackedPtyFile[];
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 128;

/** BB's candidate order matches node-pty's own native-module resolver. */
export function spawnHelperPaths(packageDirectory: string, target: string): string[] {
  return ['build/Release', 'build/Debug', `prebuilds/${target}`].flatMap(nativeDir =>
    ['..', '.'].map(relativeRoot => resolve(packageDirectory, 'lib', relativeRoot, nativeDir, 'spawn-helper'))
  ).filter(path => existsSync(path));
}

export function loadPackedPty(files: readonly PackedPtyFile[], options: {
  target?: string;
  temporaryRoot?: string;
  load?: (entry: string) => Pick<typeof NodePty, 'spawn'>;
} = {}): { native: Pick<typeof NodePty, 'spawn'>; directory: string; dispose(): void } {
  const target = options.target ?? `${process.platform}-${process.arch}`;
  if (!/^(darwin|linux|win32)-(arm64|x64)$/.test(target)) throw new Error(`Native terminals are unavailable on ${target}`);
  if (files.length > MAX_FILES) throw new Error('Native terminal package has too many files');
  const selected: Array<{ path: string; bytes: Buffer }> = [];
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    // The payload is build-owned. Still reject traversal, duplicates, and
    // unbounded expansion before creating any executable files.
    if (!/^(package\.json|LICENSE|lib\/(?:[\w-]+\/)*[\w-]+\.js|prebuilds\/(?:darwin|linux|win32)-(?:arm64|x64)\/(?:pty\.node|spawn-helper|conpty(?:_console_list)?\.node|conpty\/(?:OpenConsole\.exe|conpty\.dll)))$/.test(file.path)
      || seen.has(file.path)) throw new Error('Invalid native terminal package path');
    seen.add(file.path);
    if (file.base64.length > MAX_BYTES * 4 / 3 + 4) throw new Error('Native terminal package exceeds size limit');
    const bytes = Buffer.from(file.base64, 'base64');
    total += bytes.length;
    if (total > MAX_BYTES) throw new Error('Native terminal package exceeds size limit');
    if (!file.path.startsWith('prebuilds/') || file.path.startsWith(`prebuilds/${target}/`)) selected.push({ path: file.path, bytes });
  }
  const required = ['package.json', 'LICENSE', 'lib/index.js', `prebuilds/${target}/${target.startsWith('win32-') ? 'conpty.node' : 'pty.node'}`];
  if (target.startsWith('darwin-')) required.push(`prebuilds/${target}/spawn-helper`);
  if (required.some(path => !seen.has(path))) throw new Error(`Native terminal package is incomplete for ${target}`);
  const directory = mkdtempSync(join(options.temporaryRoot ?? tmpdir(), 'zcc-native-pty-'));
  const dispose = () => { rmSync(directory, { recursive: true, force: true }); };
  try {
    chmodSync(directory, 0o700);
    for (const file of selected) {
      const destination = join(directory, file.path);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, file.bytes, { mode: 0o600, flag: 'wx' });
    }
    if (target.startsWith('darwin-')) {
      for (const helper of spawnHelperPaths(directory, target)) chmodSync(helper, 0o755);
    }
    const native = (options.load ?? (entry => createRequire(entry)(entry)))(join(directory, 'lib/index.js'));
    return { native, directory, dispose };
  } catch (error) { dispose(); throw error; }
}

let loaded: ReturnType<typeof loadPackedPty> | undefined;
export const spawn: typeof NodePty.spawn = (file, args, options) => {
  if (!loaded) {
    loaded = loadPackedPty(typeof __ZCC_PACKED_PTY_FILES__ === 'undefined' ? [] : __ZCC_PACKED_PTY_FILES__);
    process.once('exit', loaded.dispose);
  }
  return loaded.native.spawn(file, args, options);
};
