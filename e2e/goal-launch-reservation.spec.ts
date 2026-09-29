import { test, expect } from './fixtures/app.js';
import { makeFakeAgentBinary } from './sdk/harness.js';
import { mkdirSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

test('a packaged goal preserves its reserved worker identity through spawning and never duplicates a live iteration', async ({ app }) => {
  const root = join(app.home, 'goal-reservation-project'); mkdirSync(root);
  const agent = makeFakeAgentBinary({ script: `
if [ "$1" = "--version" ]; then echo '2.1.220 (Claude Code)'; exit 0; fi
node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const dir = '.zcc/goals';
const goal = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find(name => name.endsWith('.json'))), 'utf8'));
const iteration = goal.history.iterations[0];
fs.appendFileSync('goal-starts.jsonl', JSON.stringify({ cwd: process.cwd(), state: iteration.launchState, reserved: iteration.sessionId, actual: process.env.ZCC_SESSION_ID }) + '\\n');
NODE
cat
` });
  let goalId: string | undefined, sessionId: string | undefined;
  try {
    await app.window.evaluate(binary => window.cc.config.set({ claudeBinary: binary, defaultHarness: 'claude' }), agent.path);
    const project = await app.window.evaluate(path => window.cc.projects.add(path), root);
    expect(project.ok).toBe(true); if (!project.ok) throw new Error('Project registration failed');
    const created = await app.window.evaluate(projectId => window.cc.goals.create({ projectId, scope: { projectId }, title: 'Reserved worker', statement: 'Hold for the boundary test', activate: true }), project.value.id);
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true }); if (!created.ok) throw new Error(created.message);
    goalId = created.value.id;
    const path = join(root, '.zcc/goals', `${goalId}.json`);
    await expect.poll(() => JSON.parse(readFileSync(path, 'utf8')).history.iterations[0]?.launchState).toBe('running');
    const goal = JSON.parse(readFileSync(path, 'utf8')); sessionId = goal.history.iterations[0].sessionId;
    const marker = join(root, 'goal-starts.jsonl'); await expect.poll(() => existsSync(marker)).toBe(true);
    const starts = () => readFileSync(marker, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(starts()).toEqual([{ cwd: realpathSync(root), state: expect.stringMatching(/^(pending|running)$/), reserved: sessionId, actual: sessionId }]);
    await app.window.evaluate(id => window.cc.goals.setStatus(id, 'paused'), goalId);
    expect(await app.window.evaluate(id => window.cc.goals.runNow(id), goalId)).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(path, 'utf8')).iteration).toBe(1); expect(starts()).toHaveLength(1);
  } finally {
    if (goalId) await app.window.evaluate(id => window.cc.goals.setStatus(id, 'paused'), goalId).catch(() => {});
    if (sessionId) await app.window.evaluate(id => window.cc.terminals.close(id), sessionId).catch(() => {});
    agent.cleanup();
  }
});
