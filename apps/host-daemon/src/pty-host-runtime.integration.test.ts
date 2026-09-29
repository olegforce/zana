import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { packedPtyFiles } from '../scripts/packed-pty-files.mjs';

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  const kill = (signal: NodeJS.Signals) => { try { process.kill(-child.pid!, signal); } catch {} };
  kill('SIGTERM'); const timer = setTimeout(() => kill('SIGKILL'), 2000);
  try { await exited; } finally { clearTimeout(timer); }
}

it('runs the existing CLI engine in a standalone Node host with a real PTY and only a per-session callback grant', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zcc-cli-engine-')));
  const home = join(root, 'home'), project = join(home, 'project'), dataDir = join(home, '.zcc');
  mkdirSync(project, { recursive: true }); mkdirSync(dataDir);
  const sessionId = '11111111-1111-4111-8111-111111111111', credential = 'b'.repeat(64);
  const requests: Array<{ path?: string; body: string }> = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, body }); response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  let child: ChildProcess | undefined;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const binary = join(home, 'claude');
    writeFileSync(binary, `#!${process.execPath}
(async () => {
  const report = { home: process.env.HOME, cwd: process.cwd(), tty: process.stdin.isTTY, cols: process.stdout.columns, rows: process.stdout.rows, token: process.env.ZCC_SESSION_TOKEN, auth: process.env.ANTHROPIC_AUTH_TOKEN };
  await fetch(process.env.ZCC_MCP_URL, { method: 'POST', body: JSON.stringify(report) });
  process.stdout.write('LARGE-BEGIN' + 'x'.repeat(25000) + 'LARGE-END\\n');
  process.stdout.write('READY\\n');
  process.stdin.on('data', async data => {
    if (!data.toString().includes('finish')) return;
    await fetch(process.env.ZCC_HOOK_URL, { method: 'POST', body: 'stopped' });
    console.log('FINISHED'); process.exit(0);
  });
})().catch(error => { console.error(error); process.exit(2); });
`, { mode: 0o700 });
    const entry = join(root, 'entry.ts'), outfile = join(root, 'engine.mjs');
    writeFileSync(entry, `import { PtyManager } from ${JSON.stringify(resolve('apps/host-daemon/src/pty.ts'))};
import { startCliCallbackProxy } from ${JSON.stringify(resolve('apps/host-daemon/src/cli-callback-proxy.ts'))};
const callback = await startCliCallbackProxy({ grant: { projectId: 'project', sessionId: ${JSON.stringify(sessionId)}, credential: ${JSON.stringify(credential)} }, forward: async request => {
  const response = await fetch(${JSON.stringify(url)} + request.path, { method: 'POST', headers: request.headers, body: request.body, signal: request.signal, redirect: 'error' });
  return { status: response.status, body: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') ?? undefined };
} });
const manager = new PtyManager({ sessionCredential: id => { if (id !== ${JSON.stringify(sessionId)}) throw Error('wrong grant'); return ${JSON.stringify(credential)}; }, resolveHarnessAuth: () => ({ token: 'host-owned-test-token' }), prepareNativePty() {} });
manager.setProjectRoots(() => [${JSON.stringify(project)}]);
manager.setMcpBaseUrl(callback.baseUrl);
let output = '', replied = false;
manager.on('data', (id, data) => { output += data; if (output.length > 100000) process.exit(3); if (!replied && output.includes('READY')) { replied = true; manager.write(id, 'finish\\r'); } });
manager.on('exit', async (id, code) => { await callback.close(); console.log('RESULT:' + JSON.stringify({ id, code, complete: output.includes('LARGE-BEGIN' + 'x'.repeat(25000) + 'LARGE-END'), finished: output.includes('FINISHED') })); process.exit(code); });
process.on('SIGTERM', () => { manager.killAll(); setTimeout(() => process.exit(143), 1000).unref(); });
setTimeout(() => { manager.killAll(); process.exit(4); }, 20000).unref();
manager.create({ projectId: 'project', preallocatedSessionId: ${JSON.stringify(sessionId)}, profile: 'claude', cwd: ${JSON.stringify(project)}, cols: 93, rows: 31, autoCloseOnFinish: true, config: { version: 1, theme: 'dark', shell: '/bin/sh', claudeBinary: ${JSON.stringify(binary)}, tmuxScope: 'off', autoModeEnabled: false } });
`);
    // Use the join artifact's portable addon, never the installed Electron ABI.
    const result = await build({ entryPoints: [entry], outfile, tsconfig: resolve('tsconfig.json'), bundle: true, platform: 'node', format: 'esm', target: 'node22', conditions: ['source'], metafile: true,
      alias: { 'node-pty': resolve('apps/host-daemon/src/packed-native-pty.ts'), '@zcc/harness-sdk': resolve('packages/harness-sdk/src/index.ts') },
      define: { __ZCC_PACKED_PTY_FILES__: JSON.stringify(packedPtyFiles()) },
      banner: { js: `import { createRequire as __zccCliFixtureCreateRequire } from 'node:module'; const require = __zccCliFixtureCreateRequire(import.meta.url);` }
    });
    expect(Object.values(result.metafile!.inputs).flatMap(input => input.imports).some(input => input.path === 'electron')).toBe(false);
    child = spawn(process.execPath, [outfile], { cwd: project, detached: true, env: { ...process.env, HOME: home, ZCC_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout!.on('data', data => { output = (output + data).slice(-100_000); });
    child.stderr!.on('data', data => { error = (error + data).slice(-100_000); });
    const code = await new Promise<number | null>((resolve, reject) => { child!.once('error', reject); child!.once('close', resolve); });
    expect(code, `${output}\n${error}`).toBe(0);
    const report = JSON.parse(output.split('\n').find(line => line.startsWith('RESULT:'))!.slice(7));
    expect(report).toEqual({ id: sessionId, code: 0, complete: true, finished: true });
    expect(requests).toEqual([
      { path: `/mcp/project/${sessionId}/${credential}`, body: JSON.stringify({ home, cwd: project, tty: true, cols: 93, rows: 31, token: credential, auth: 'host-owned-test-token' }) },
      { path: `/hook/stop/project/${sessionId}`, body: 'stopped' }
    ]);
    expect(existsSync(join(dataDir, 'control-signing.key'))).toBe(false);
  } finally {
    if (child) await stop(child);
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
