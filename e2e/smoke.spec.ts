/**
 * Boot smoke — the cheapest signal that the built app is launchable and the
 * renderer + preload bridge are alive. If this fails, every other E2E is noise.
 *
 * This is the ONE spec wired into `release.yml` as a REQUIRED gate (the `smoke`
 * job runs `npm run test:smoke:only` and `build` needs it): a build that can't
 * boot or whose main↔renderer IPC is dead must never reach signing/notarization.
 * Keep this minimal gate read-only. The shared fixture isolates both HOME and
 * Electron's app.getPath('home') before loading the app, and owns teardown.
 */
import { test, expect } from './fixtures/app.js';

test('app boots: renderer mounts and the IPC bridge is live', async ({ app }) => {
  if (process.env.ZCC_E2E_EXECUTABLE_PATH) {
    expect(await app.electron.evaluate(({ app }) => app.isPackaged)).toBe(true);
  }
  expect(app.window.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
  // React root mounted something.
  const rootChildren = await app.window.evaluate(
    () => document.querySelector('#root')?.childElementCount ?? 0
  );
  expect(rootChildren).toBeGreaterThan(0);

  // The preload context bridge exposed the extensions API the marketplace uses.
  const hasBridge = await app.window.evaluate(
    () =>
      typeof (window as unknown as { cc?: { extensions?: { marketplaceList?: unknown } } }).cc
        ?.extensions?.marketplaceList === 'function'
  );
  expect(hasBridge).toBe(true);

  // Main actually ANSWERS — a live round-trip, not just a present bridge. A
  // preload that wired `window.cc` while the main handlers never registered
  // (or the ipc bridge is one-way broken) would pass the check above but hang
  // or reject here. app.version() → app.getVersion() in main returns the
  // packaged semver; assert the shape so a build that boots but can't talk to
  // main still fails the gate.
  const version = await app.window.evaluate(() =>
    (window as unknown as { cc: { app: { version: () => Promise<string> } } }).cc.app.version()
  );
  expect(version, 'app.version() must round-trip a semver from main').toMatch(/^\d+\.\d+\.\d+/);

  // Projects are the first product read routed through the supervised server
  // utility process. This is read-only so the release smoke cannot touch the
  // developer's real ZCC state.
  const projects = await app.window.evaluate(() =>
    (window as unknown as { cc: { projects: { list: () => Promise<unknown[]> } } }).cc.projects.list()
  );
  expect(Array.isArray(projects), 'projects.list() must round-trip via the server runtime').toBe(true);
});

test.describe('Windows package native binaries', () => {
  test.skip(process.platform !== 'win32' || !process.env.ZCC_E2E_EXECUTABLE_PATH,
    'Runs against the Windows release package');
  test('packaged Windows app ships working OpenCode and ConPTY binaries', async ({ app }) => {
    const result = await app.electron.evaluate(async ({ app }) => {
      const { join } = require('node:path');
      const { createRequire } = require('node:module');
      const { execFileSync } = require('node:child_process');
      const packagedRequire = createRequire(join(app.getAppPath(), 'package.json'));
      const version = execFileSync(join(process.resourcesPath, 'opencode', process.arch, 'opencode.exe'),
        ['--version'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true }).trim();
      const pty = packagedRequire('node-pty');
      const output = await new Promise<string>((resolve, reject) => {
        const terminal = pty.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'echo ZCC_WINDOWS_PTY_READY'], {
          name: 'xterm-color', cols: 80, rows: 24, cwd: app.getPath('home'), env: process.env
        });
        let output = '';
        const cleanup = () => {
          clearTimeout(timer);
          data.dispose();
          exit.dispose();
          try { terminal.kill(); } catch { /* already exited */ }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`ConPTY did not return the marker: ${output}`));
        }, 10_000);
        const data = terminal.onData((chunk: string) => {
          output = (output + chunk).slice(-4096);
          if (output.includes('ZCC_WINDOWS_PTY_READY')) {
            cleanup();
            resolve(output);
          }
        });
        const exit = terminal.onExit(() => {
          if (!output.includes('ZCC_WINDOWS_PTY_READY')) {
            cleanup();
            reject(new Error(`ConPTY exited without the marker: ${output}`));
          }
        });
      });
      return { version, output };
    });
    expect(result.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.output).toContain('ZCC_WINDOWS_PTY_READY');
  });
});
