import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures/app.js';

const INPUT = `framing-start ${'é🙂'.repeat(48_000)} framing-end`;
const REPLY_PREFIX = 'The large framed turn reached the built provider.';
const REPLY = `${REPLY_PREFIX} ${'é🙂'.repeat(4_000)} framed-output-end`;

test.use({
  initialConfig: { sponsorPromptDismissed: true },
  launchEnv: async ({ home }, use) => {
    const bin = join(home, 'fixture-bin');
    mkdirSync(bin);
    const shellInit = `export PATH='${bin.replaceAll("'", "'\\''")}':"$PATH"\n`;
    for (const name of ['.zshrc', '.bashrc', '.bash_profile']) writeFileSync(join(home, name), shellInit);
    const fixture = fileURLToPath(new URL('../plugins/provider-codex/src/bridge/fake-codex-app-server.mjs', import.meta.url));
    const script = join(home, 'codex-framing-script.json');
    writeFileSync(script, JSON.stringify({
      requestLogPath: join(home, 'codex-framing-requests.log'), messageText: REPLY,
    }));
    writeFileSync(join(bin, 'codex'), `#!${process.execPath}\n
if (process.argv.includes('--version')) { console.log('codex-cli 0.153.4'); process.exit(0); }
if (!process.argv.includes('app-server')) process.exit(64);
process.argv = [process.execPath, ${JSON.stringify(fixture)}, ${JSON.stringify(script)}];
import(${JSON.stringify(new URL('../plugins/provider-codex/src/bridge/fake-codex-app-server.mjs', import.meta.url).href)});
`, { mode: 0o700 });
    writeFileSync(join(bin, 'opencode'), `#!${process.execPath}\n
if (process.argv.includes('--version')) { console.log('opencode 1.18.10'); process.exit(0); }
if (!process.argv.includes('acp')) process.exit(64);
process.env.FAKE_ACP_LAUNCH_LOG = ${JSON.stringify(join(home, 'acp-framing-launch.log'))};
process.env.FAKE_ACP_MODEL_CONFIG = '1';
await import(${JSON.stringify(new URL('../plugins/provider-acp/src/bridge/fake-acp-agent.mjs', import.meta.url).href)});
const { writeFileSync } = await import('node:fs');
process.removeAllListeners('SIGTERM');
process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(join(home, 'acp-framing-signal.log'))}, 'SIGTERM'); });
`, { mode: 0o700 });
    await use({ PATH: `${bin}:${process.env.PATH ?? ''}`, ZDOTDIR: home });
  },
});

test('large UTF-8 input crosses the built provider bridge and resumed turns remain usable', async ({ app }) => {
  test.setTimeout(120_000);
  const root = join(app.home, 'framing-project');
  mkdirSync(root);
  const threadId = await app.window.evaluate(async ({ path, input }) => {
    const project = await window.cc.projects.add(path);
    if (!project.ok) throw new Error('Project registration failed');
    const response = await fetch('/api/v1/threads', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.value.id, providerId: 'codex', input, permissionMode: 'full' }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(body));
    return (body.thread ?? body.value).id as string;
  }, { path: root, input: INPUT });
  await app.window.evaluate(id => {
    history.pushState({}, '', `/threads/${id}`);
    dispatchEvent(new PopStateEvent('popstate'));
  }, threadId);
  const timeline = app.window.getByTestId('thread-timeline');
  await expect(timeline).toContainText(REPLY_PREFIX, { timeout: 30_000 });
  if (await timeline.getByText(REPLY, { exact: true }).count() === 0) await timeline.getByRole('button', { name: 'Show more', exact: true }).last().click();
  await expect(timeline).toContainText(REPLY);
  const requests = () => {
    const log = join(app.home, 'codex-framing-requests.log');
    return existsSync(log)
      ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      : [];
  };
  await expect.poll(() => requests().filter(row => row.method === 'turn/start').length).toBe(1);
  const nativeInput = requests().find(row => row.method === 'turn/start').params.input;
  expect(nativeInput.some((item: { type: string; text?: string }) => item.type === 'text' && item.text?.includes(INPUT))).toBe(true);

  // The fake app-server emits completion before its turn/start response. Stop
  // through the product UI before resuming, as the writer-handoff fixture does.
  await app.window.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(app.window.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  const composer = app.window.getByTestId('thread-command-input');
  await composer.fill('Following framed turn');
  await composer.press('Enter');
  await expect(timeline.getByText(REPLY_PREFIX, { exact: false })).toHaveCount(2, { timeout: 30_000 });
  if (await timeline.getByText(REPLY, { exact: true }).count() < 2) await timeline.getByRole('button', { name: 'Show more', exact: true }).last().click();
  await expect(timeline.getByText(REPLY, { exact: true })).toHaveCount(2);
  expect(requests().filter(row => row.method === 'turn/start')).toHaveLength(2);
  await expect(app.window.locator('.thread-status-badge.is-error')).toHaveCount(0);
});

test('Stop reaps a SIGTERM-resistant ACP child through the built provider', async ({ app }) => {
  test.setTimeout(120_000);
  const root = join(app.home, 'acp-stop-project');
  mkdirSync(root);
  const threadId = await app.window.evaluate(async path => {
    const project = await window.cc.projects.add(path);
    if (!project.ok) throw new Error('Project registration failed');
    const response = await fetch('/api/v1/threads', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.value.id, providerId: 'acp-opencode', model: 'fake/default', input: 'announce-mcp-tool', permissionMode: 'full' }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(body));
    return (body.thread ?? body.value).id as string;
  }, root);
  await app.window.evaluate(id => {
    history.pushState({}, '', `/threads/${id}`);
    dispatchEvent(new PopStateEvent('popstate'));
  }, threadId);
  const processLog = join(app.home, 'acp-framing-launch.log');
  const pids = () => existsSync(processLog)
    ? readFileSync(processLog, 'utf8').trim().split('\n').map(line => Number(line.split(' ')[1])).filter(pid => Number.isSafeInteger(pid) && pid > 0)
    : [];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    await expect(app.window.getByTestId('thread-timeline')).toContainText('MCP: tool', { timeout: 30_000 });
    expect(pids().some(alive)).toBe(true);
    await app.window.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(() => existsSync(join(app.home, 'acp-framing-signal.log')), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => pids().filter(alive), { timeout: 10_000 }).toEqual([]);
  } finally {
    for (const pid of pids().filter(alive)) process.kill(pid, 'SIGKILL');
  }
});
