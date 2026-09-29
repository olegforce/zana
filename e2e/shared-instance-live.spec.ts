import { test, expect, launchApp } from './fixtures/app.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// Deliberately separate from deterministic suites: uses installed authenticated
// providers, with an isolated product data directory and project. The repository
// requires mode/reasoning then Memory whenever launch/host transport changes.
test('current built shared instance passes live providers, Memory and desktop browser', async ({ home }, testInfo) => {
  test.skip(process.env.ZCC_LIVE_SHARED !== '1', 'requires installed authenticated providers');
  test.setTimeout(20 * 60_000);
  const app = await launchApp(home, {
    allowLiveClaude: true,
    env: { ZCC_E2E_PRESERVE_HOME: '1', ZCC_SESSION_ID: '', ZCC_SESSION_TOKEN: '' },
    initialConfig: { harnessClaudeEnabled: true, harnessCodexEnabled: true, harnessCursorEnabled: true, harnessOpenCodeEnabled: true, defaultHarness: 'claude' }
  });
  try {
    const root = join(home, 'live-sandbox'); mkdirSync(root);
    const project = await app.window.evaluate(path => window.cc.projects.add(path), root);
    expect(project.ok).toBe(true);
    const origin = new URL(app.window.url()).origin;
    await expect.poll(async () => (await fetch(`${origin}/api/v1/hosts`).then(r => r.json())).some((row: any) => row.status === 'connected'), { timeout: 60_000 }).toBe(true);
    await expect.poll(async () => {
      const result = await fetch(`${origin}/api/v1/plugins`).then(r => r.json());
      return result.plugins?.find((row: any) => row.id === 'memory')?.status;
    }, { timeout: 60_000 }).toBe('running');
    for (const script of ['live:mode-reasoning', 'live:memory', 'live:browser']) {
      const env = { ...process.env, ZCC_SERVER_URL: origin, ZCC_DATA_DIR: join(home, '.zcc') };
      delete env.ZCC_SESSION_ID; delete env.ZCC_SESSION_TOKEN;
      const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn('pnpm', [script], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = ''; let timedOut = false;
        const append = (chunk: Buffer) => { output = (output + String(chunk)).slice(-1024 * 1024); };
        child.stdout!.on('data', append); child.stderr!.on('data', append);
        const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, 9 * 60_000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => { clearTimeout(timer); resolve({ code: timedOut ? -1 : code, output }); });
      });
      const log = testInfo.outputPath(`${script.replace(':', '-')}.log`);
      writeFileSync(log, result.output);
      await testInfo.attach(script, { path: log, contentType: 'text/plain' });
      expect.soft(result.code, result.output).toBe(0);
      expect.soft(result.output, 'Missing live prerequisites cannot be counted as a pass').not.toMatch(/\[live\] skip/);
    }
  } finally { await app.electron.close(); }
});
