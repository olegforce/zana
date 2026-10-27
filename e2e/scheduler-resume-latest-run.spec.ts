/**
 * Resume latest run: a finished scheduled run's agent is reopened in a new tab
 * from the schedule row, with its own conversation (`--resume <id>`), nothing
 * sent, and no new run recorded. A second click switches to the same tab.
 *
 * The fake `claude` appends `{ session, argv }` to a file for every real launch
 * (it answers `--version` first and records nothing for it). The scheduled run
 * carries `--dangerously-skip-permissions`, so it exits after about a second;
 * the reopened tab does not, so it stays alive like a normal tab.
 */
import { test, expect } from './fixtures/app.js';
import { captureElectronScreenshot } from './fixtures/native-screenshot.js';
import { makeFakeAgentBinary } from './sdk/harness.js';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

interface Launch { session: string; argv: string[] }

test('Resume latest run reopens the finished run\'s conversation in a new tab, sends nothing and records no run', async ({ app }) => {
  test.setTimeout(240_000);
  const { window, electron } = app;
  const root = join(app.home, 'resume-latest-project'); mkdirSync(root);
  const log = join(app.home, 'resume-launches.jsonl');
  const prompt = 'E2E-RESUME-PROMPT summarise the open pull requests';
  const agent = makeFakeAgentBinary({ script: `
if [ "$1" = "--version" ]; then echo '2.1.220 (Claude Code)'; exit 0; fi
if [ -n "$ZCC_SESSION_ID" ]; then
  node - --arg-start "$@" <<'NODE'
const fs = require('node:fs');
const argv = process.argv.slice(process.argv.indexOf('--arg-start') + 1);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ session: process.env.ZCC_SESSION_ID, argv }) + '\\n');
NODE
fi
case " $* " in
  *E2E-FAIL*) sleep 1; exit 1 ;;
  *" --dangerously-skip-permissions "*) sleep 1; exit 0 ;;
esac
exec cat
` });
  const launches = (): Launch[] => existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
  const screenshots = process.env.ZCC_E2E_SCREENSHOTS === '1' ? process.env.ZCC_E2E_SCREENSHOT_DIR : undefined;
  const shot = async (name: string) => {
    if (!screenshots) return;
    // Let earlier toasts fade so each picture shows only the screen it is about.
    await expect.poll(() => window.locator('.toast').count(), { timeout: 15_000 }).toBe(0).catch(() => undefined);
    await captureElectronScreenshot(electron, window, join(screenshots, name));
  };
  let projectId: string | undefined;
  const taskIds: string[] = [];
  try {
    await window.evaluate(binary => window.cc.config.set({ claudeBinary: binary, defaultHarness: 'claude', tmuxScope: 'off' }), agent.path);
    const project = await window.evaluate(path => window.cc.projects.add(path), root);
    if (!project.ok) throw new Error(`Project registration failed: ${project.message}`);
    projectId = project.value.id;
    const created = await window.evaluate(({ projectId, prompt }) => window.cc.scheduler.create({
      projectId, scope: { projectId }, name: 'Daily PR digest', every: '6h', profile: 'claude', enabled: false, inboxLevel: 'silent', prompt
    }), { projectId, prompt });
    if (!created.ok) throw new Error(`Schedule creation failed: ${created.message}`);
    const taskId = created.value.id;
    taskIds.push(taskId);
    const read = async () => {
      const result = await window.evaluate(id => window.cc.scheduler.get(id), taskId);
      if (!result.ok) throw new Error(result.message);
      return result.value;
    };

    expect(await window.evaluate(id => window.cc.scheduler.runNow(id), taskId), 'run now is accepted').toMatchObject({ ok: true });
    await expect.poll(async () => {
      const run = (await read()).status.runs[0];
      const live = await window.evaluate(id => window.cc.terminals.list(id), projectId!);
      return !!run?.conversation?.id && typeof run.durationMs === 'number' && !live.some(session => session.id === run.sessionId);
    }, { message: 'the finished run records its conversation and its tab has gone', timeout: 60_000 }).toBe(true);
    const runsBefore = (await read()).status.runs;
    expect(runsBefore, 'exactly one run so far').toHaveLength(1);
    const conversationId = runsBefore[0]!.conversation!.id!;
    expect(launches(), 'only the scheduled run has launched').toHaveLength(1);
    expect(launches()[0]!.argv, 'the scheduled run carries the prompt and its unattended flag').toEqual(
      expect.arrayContaining([prompt, '--dangerously-skip-permissions'])
    );

    // Open the Schedules list and click the row's Resume latest run.
    await window.locator('.nav-item').filter({ hasText: 'Scheduler' }).first().click();
    await window.getByRole('button', { name: /^Schedules$/ }).click();
    const row = window.locator('li.scheduler-card').filter({ hasText: 'Daily PR digest' });
    await expect(row, 'the schedule row is listed').toBeVisible({ timeout: 15_000 });
    // Checked in every run, not only when taking pictures: the same state either way.
    if (screenshots) await window.setViewportSize({ width: 1440, height: 900 });
    await window.evaluate(id => window.cc.scheduler.setEnabled(id, true), taskId);
    await row.locator('.scheduler-card-main').click({ button: 'right' });
    await expect(window.getByRole('menuitem', { name: /Resume latest run/ }), 'the row menu offers Resume latest run').toBeVisible();
    await shot('01-row-and-menu.png');
    await window.keyboard.press('Escape');
    await expect(window.getByRole('menuitem', { name: /Resume latest run/ })).toHaveCount(0);
    await row.getByRole('button', { name: 'Resume latest run', exact: true }).click();

    await expect.poll(() => launches().length, { message: 'the resume launches the agent once more', timeout: 30_000 }).toBe(2);
    const reopened = launches()[1]!;
    const resumeAt = reopened.argv.indexOf('--resume');
    expect(resumeAt, `the reopened launch passes --resume (argv: ${reopened.argv.join(' ')})`).toBeGreaterThanOrEqual(0);
    expect(reopened.argv[resumeAt + 1], 'it resumes the run\'s own conversation').toBe(conversationId);
    expect(reopened.argv.join(' '), 'it sends no prompt').not.toContain('E2E-RESUME-PROMPT');
    expect(reopened.argv, 'it is not an unattended run').not.toContain('--dangerously-skip-permissions');
    expect(reopened.session, 'it is a fresh terminal, not the old run\'s').not.toBe(runsBefore[0]!.sessionId);

    await expect.poll(async () => {
      const sessions = await window.evaluate(id => window.cc.terminals.list(id), projectId!);
      return sessions.filter(session => session.id === reopened.session).map(session => ({ title: session.title, headless: !!session.headless }));
    }, { message: 'the new tab is listed, titled ↺ and visible (not headless)' }).toEqual([{ title: '↺ Daily PR digest', headless: false }]);
    await expect(window.getByTestId('agent-session-view'), 'the agent page is open').toBeVisible({ timeout: 15_000 });
    expect(window.url(), 'it shows the reopened session').toContain(encodeURIComponent(reopened.session));
    expect((await read()).status.runs, 'no run is recorded for the reopened tab').toEqual(runsBefore);
    await shot('03-reopened-tab.png');

    // Again: the conversation is already open, so it switches to that tab instead of opening a second copy.
    await window.locator('.nav-item').filter({ hasText: 'Scheduler' }).first().click();
    await window.getByRole('button', { name: /^Schedules$/ }).click();
    await window.locator('li.scheduler-card').filter({ hasText: 'Daily PR digest' }).getByRole('button', { name: 'Resume latest run', exact: true }).click();
    await expect(window.getByTestId('agent-session-view'), 'it switches back to the agent page').toBeVisible({ timeout: 15_000 });
    await expect.poll(() => window.url(), { message: 'the same session is shown' }).toContain(encodeURIComponent(reopened.session));
    expect(launches(), 'no second copy is launched').toHaveLength(2);
    const tabs = await window.evaluate(id => window.cc.terminals.list(id), projectId);
    expect(tabs.filter(session => session.title === '↺ Daily PR digest'), 'one reopened tab only').toHaveLength(1);
    expect((await read()).status.runs, 'still no new run').toEqual(runsBefore);

    // Overview, Problems, the toolbar and the detail footer: checked in every run.
    // A second enabled schedule (the toolbar needs something to disable) and a failed run
    // that kept its conversation (Problems needs a closed resumable row).
    const second = await window.evaluate(({ projectId }) => window.cc.scheduler.create({
      projectId, scope: { projectId }, name: 'Weekly dependency check', every: '1d', profile: 'claude', enabled: true, inboxLevel: 'silent', prompt: 'E2E-FAIL dependency check'
    }), { projectId });
    if (!second.ok) throw new Error(second.message);
    taskIds.push(second.value.id);
    await window.evaluate(id => window.cc.scheduler.runNow(id), second.value.id);
    await expect.poll(async () => {
      const result = await window.evaluate(id => window.cc.scheduler.get(id), second.value.id);
      const run = result.ok ? result.value.status.runs[0] : undefined;
      return run?.result === 'error' && !!run.conversation?.id;
    }, { message: 'the failing run keeps its conversation', timeout: 60_000 }).toBe(true);

    await window.locator('.nav-item').filter({ hasText: 'Scheduler' }).first().click();
    await expect(window.getByRole('button', { name: 'Resume this run' }).first(), 'Overview offers Resume this run').toBeVisible({ timeout: 15_000 });
    await shot('04-overview.png');
    await window.getByRole('button', { name: /Problems/ }).click();
    await expect(window.getByRole('button', { name: /^Resume Weekly dependency check run/ }), 'Problems offers Resume on the closed failed run').toBeVisible({ timeout: 15_000 });
    await shot('05-problems.png');
    await window.getByRole('button', { name: /^Schedules$/ }).click();
    await expect(window.getByRole('button', { name: 'Disable all' }), 'the toolbar offers Disable all').toBeEnabled();
    await shot('06-disable-all.png');
    await window.locator('li.scheduler-card').filter({ hasText: 'Daily PR digest' }).locator('.scheduler-card-main').click();
    const panel = window.getByTestId('schedule-info-panel');
    await expect(panel.getByRole('button', { name: 'Resume latest run', exact: true }), 'the detail footer offers Resume latest run').toBeVisible({ timeout: 15_000 });
    await expect(panel.getByRole('button', { name: 'Disable', exact: true })).toBeVisible();
    await shot('02-detail.png');
  } finally {
    // Close the reopened session before the app quits: Electron asks to confirm with a live CLI agent.
    if (projectId) {
      await window.evaluate(async id => {
        const sessions = await window.cc.terminals.list(id);
        await Promise.all(sessions.map(session => window.cc.terminals.close(session.id)));
      }, projectId).catch(() => undefined);
    }
    for (const id of taskIds) await window.evaluate(id => window.cc.scheduler.setEnabled(id, false), id).catch(() => undefined);
    agent.cleanup();
  }
});
