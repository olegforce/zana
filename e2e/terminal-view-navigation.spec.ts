import { test, expect } from './fixtures/app.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

test.use({ e2e: true, initialConfig: { tmuxScope: 'off' } });

test('project navigation keeps hidden terminal renderers idle and preserves the live terminal', async ({ app }) => {
  const { window: page } = app;
  const projectDir = mkdtempSync(join(tmpdir(), 'zcc-terminal-navigation-'));
  const projectId = await page.evaluate(async (path) => {
    const result = await window.cc.projects.add(path);
    if (!result.ok) throw new Error(result.message);
    return result.value.id;
  }, projectDir);
  let sessionId: string | undefined;
  try {
    const heading = page.getByTestId('sidebar-projects-heading');
    if (await heading.getAttribute('aria-expanded') === 'false') await heading.click();
    const row = page.getByRole('button', { name: `Open ${basename(projectDir)}`, exact: true });
    await row.click();
    sessionId = await page.evaluate(async (projectId) => {
      const result = await window.cc.terminals.create({ projectId, profile: 'shell', cols: 80, rows: 24 });
      if (!result.ok) throw new Error(result.message);
      return result.value.id;
    }, projectId);
    await page.getByTestId('project-nav-terminals').click();
    const terminal = page.locator('.term .xterm').first();
    await expect(terminal).toBeVisible();
    // Exercise a real scrollback buffer through the PTY and production renderer.
    await page.evaluate((id) => window.cc.terminals.write(id, "printf 'SCROLLBACK-%s\\n' {1..20000}; echo NAVIGATION_OUTPUT_READY\r"), sessionId);
    await expect.poll(() => page.evaluate((id) => window.cc.terminals.backlog(id), sessionId!)).toContain('NAVIGATION_OUTPUT_READY\r\n');
    await terminal.evaluate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await expect(terminal.locator('canvas').first()).toBeAttached();
    await terminal.evaluate((element) => {
      const state = window as unknown as { navigationTerminal: Element; hiddenTerminalResizes: number };
      state.navigationTerminal = element;
      state.hiddenTerminalResizes = 0;
      // WebGL reconfiguration sets canvas dimensions even when xterm is paused.
      for (const key of ['width', 'height'] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, key)!;
        Object.defineProperty(HTMLCanvasElement.prototype, key, {
          ...descriptor,
          set(value: number) {
            const host = this.closest('.term') as HTMLElement | null;
            if (host && (host.offsetParent === null || host.clientWidth === 0 || host.clientHeight === 0)) {
              state.hiddenTerminalResizes++;
            }
            descriptor.set!.call(this, value);
          }
        });
      }
    });
    // Going via Home makes project selection mark the parked terminal active.
    await page.getByRole('button', { name: 'Back to all projects', exact: true }).click();
    await page.getByRole('link', { name: 'New Chat', exact: true }).click();
    await expect(terminal).toBeHidden();
    await row.click();
    await expect(page.locator('.agents-board')).toBeVisible();
    await page.getByTestId('project-nav-scheduler').click();
    await expect(page.locator('.scheduler-panel--embedded')).toBeVisible();
    // Include xterm's deferred idle queue and the 100ms resize-settle timer.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
    expect(await page.evaluate(() => (window as unknown as { hiddenTerminalResizes: number }).hiddenTerminalResizes)).toBe(0);
    await page.getByTestId('project-nav-terminals').click();
    await expect(terminal).toBeVisible();
    expect(await terminal.evaluate((element) => element === (window as unknown as { navigationTerminal: Element }).navigationTerminal)).toBe(true);
    await terminal.locator('.xterm-helper-textarea').fill('echo TERMINAL_STILL_LIVE');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate((id) => window.cc.terminals.backlog(id), sessionId!)).toContain('TERMINAL_STILL_LIVE\r\n');
  } finally {
    if (sessionId) await page.evaluate((id) => window.cc.terminals.close(id), sessionId).catch(() => {});
    await page.evaluate((id) => window.cc.projects.remove(id), projectId).catch(() => {});
    rmSync(projectDir, { recursive: true, force: true });
  }
});
