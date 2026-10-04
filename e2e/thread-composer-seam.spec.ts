import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app.js';

test.use({
  launchEnv: { ZCC_FAKE_PROVIDER: '1' },
  isolateBundledCatalog: true,
  initialConfig: { sponsorPromptDismissed: true }
});

async function openComposer({ window, home }: { window: Page; home: string }, worktree = false): Promise<string> {
  const projectPath = join(home, 'composer-seam-project');
  mkdirSync(projectPath);
  execFileSync('git', ['init', '--quiet'], { cwd: projectPath });
  writeFileSync(join(projectPath, 'README.md'), 'Composer seam fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: projectPath });
  execFileSync('git', ['-c', 'user.name=Composer E2E', '-c', 'user.email=composer@example.test', 'commit', '--quiet', '-m', 'Initial project'], { cwd: projectPath });
  writeFileSync(join(projectPath, 'README.md'), 'Composer seam fixture changed\n');

  const threadId = await window.evaluate(async ({ path, worktree }) => {
    const project = await window.cc.projects.add(path);
    if (!project.ok) throw new Error('Project registration failed');
    const threadResponse = await fetch('/api/v1/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.value.id,
        providerId: 'fake',
        input: 'Check composer layout',
        ...(worktree ? { environment: { kind: 'worktree' } } : {})
      })
    });
    const thread = await threadResponse.json();
    if (!threadResponse.ok) throw new Error(JSON.stringify(thread));
    return (thread.thread ?? thread.value).id as string;
  }, { path: projectPath, worktree });

  await window.evaluate((id) => {
    window.history.pushState({}, '', `/threads/${id}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, threadId);
  await expect(window.getByTestId('thread-command-input')).toBeVisible();
  return threadId;
}

test('composer terminal command executes in the thread checkout and reveals its terminal', async ({ app }) => {
  const { window } = app;
  const threadId = await openComposer(app, true);
  const thread = await window.evaluate(async (id) => {
    const response = await fetch(`/api/v1/threads/${id}`);
    const body = await response.json();
    return body.thread;
  }, threadId);
  expect(thread.cwd).toBeTruthy();
  expect(thread.cwd).not.toBe(join(app.home, 'composer-seam-project'));
  let agentSends = 0;
  window.on('request', request => { if (request.url().endsWith(`/threads/${threadId}/send`)) agentSends++; });
  const input = window.getByTestId('thread-command-input');
  await input.fill('/ter');
  await expect(window.getByRole('option', { name: /terminal/ })).toBeVisible();
  // Exercise the existing PTY through production Electron, including a payload
  // larger than the 8192-byte truncation boundary and shell quoting/operators.
  const command = 'pwd; printf "COMPOSER_BEGIN\\n"; printf "%12000s" x; printf "\\nCOMPOSER_END\\n"';
  await input.fill(`/terminal ${command}`);
  await window.getByTestId('thread-command-send').click();
  await expect(window.getByTestId('thread-secondary-panel')).toBeVisible();
  await expect(window.getByTestId('thread-terminal-tab')).toBeVisible();
  await expect(input).toHaveText('');
  await expect(window.locator('.thread-terminal-tab .xterm')).toBeVisible();
  const terminal = await window.evaluate(async () => {
    const response = await fetch('/api/v1/terminals');
    const body = await response.json();
    return body.sessions.find((session: { launchCommand?: string }) => session.launchCommand?.includes('COMPOSER_BEGIN'));
  });
  expect(terminal.cwd).toBe(thread.cwd);
  await expect.poll(async () => window.evaluate(async (id) => {
    const response = await fetch(`/api/v1/terminals/${id}/output`);
    return (await response.json()).text as string;
  }, terminal.id)).toContain('COMPOSER_END');
  const output = await window.evaluate(async (id) => (await (await fetch(`/api/v1/terminals/${id}/output`)).json()).text as string, terminal.id);
  expect(output).toContain(thread.cwd);
  expect(output).toContain('COMPOSER_BEGIN');
  expect(output.length).toBeGreaterThan(12_000);
  expect(agentSends).toBe(0);
});

test('composer terminal command opens an interactive shell without an agent message', async ({ app }) => {
  const { window } = app;
  const threadId = await openComposer(app);
  let agentSends = 0;
  window.on('request', request => { if (request.url().endsWith(`/threads/${threadId}/send`)) agentSends++; });
  const input = window.getByTestId('thread-command-input');
  await input.fill('/ter');
  await window.getByRole('option', { name: /terminal/ }).click();
  await window.getByTestId('thread-command-send').click();
  await expect(window.getByTestId('thread-terminal-tab')).toBeVisible();
  await expect(input).toHaveText('');
  await expect(window.locator('.thread-terminal-tab .xterm')).toBeVisible();
  const terminalInput = window.locator('.thread-terminal-tab .xterm-helper-textarea');
  await terminalInput.pressSequentially('printf "INTERACTIVE_TERMINAL_OK\\n"');
  await terminalInput.press('Enter');
  await expect.poll(async () => window.evaluate(async () => {
    const body = await (await fetch('/api/v1/terminals')).json();
    const session = body.sessions.find((session: { status: string; title: string }) => session.status === 'running' && session.title === 'Terminal');
    if (!session) return '';
    return (await (await fetch(`/api/v1/terminals/${session.id}/output`)).json()).text as string;
  })).toContain('\r\nINTERACTIVE_TERMINAL_OK\r\n');
  expect(agentSends).toBe(0);
});

test('composer terminal launch failures preserve the command for retry', async ({ app }) => {
  const { window } = app;
  await openComposer(app);
  await window.route('**/api/v1/terminals', route => route.fulfill({ status: 502, json: { ok: false, code: 'host_disconnected', message: 'Terminal host disconnected' } }));
  const input = window.getByTestId('thread-command-input');
  await input.fill('/terminal pwd');
  await input.press('Enter');
  await expect(window.getByTestId('thread-command-error')).toHaveText('Terminal host disconnected');
  await expect(input).toHaveText('/terminal pwd');
  await expect(window.getByTestId('thread-command-send')).toBeEnabled();
  await expect(window.getByTestId('thread-terminal-tab')).toHaveCount(0);
});

test('the files bar joins the plugin-wrapped composer without a gap or shadow', async ({ app }) => {
  const { window } = app;
  await openComposer(app);
  const dock = window.locator('.thread-composer-dock');
  const banner = dock.getByTestId('thread-workspace-banner');
  const composer = dock.locator('.plugin-composer-chrome .ui-command-composer');
  await expect(banner).toBeVisible();
  await expect(composer).toBeVisible();

  const filesToggle = banner.getByRole('button', { name: /^\d+ Files?$/ });
  for (const expanded of [false, true]) {
    if (expanded) await filesToggle.click();
    await expect(filesToggle).toHaveAttribute('aria-expanded', String(expanded));
    await composer.getByTestId('thread-command-input').focus();
    await expect(composer).toHaveCSS('border-top-left-radius', '0px');
    await expect(composer).toHaveCSS('border-top-right-radius', '0px');
    await expect(composer).toHaveCSS('box-shadow', 'none');
    const bannerBox = await banner.boundingBox();
    const composerBox = await composer.boundingBox();
    expect(bannerBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect(Math.abs(composerBox!.y - (bannerBox!.y + bannerBox!.height))).toBeLessThanOrEqual(1);
    expect(composerBox!.x).toBe(bannerBox!.x);
    expect(composerBox!.width).toBe(bannerBox!.width);
  }
  const input = composer.getByTestId('thread-command-input');
  await input.fill('Follow up without an attachment');
  await input.press('Enter');
  await expect(input).toHaveText('');
  await expect(window.getByTestId('thread-command-upload-progress')).toHaveCount(0);
});

for (const outcome of ['success', 'failure'] as const) {
  test(`upload status stays inside the composer and clears on ${outcome}`, async ({ app }, testInfo) => {
    const { window } = app;
    const threadId = await openComposer(app);
    const input = window.getByTestId('thread-command-input');
    await input.evaluate((element) => {
      const png = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=');
      const bytes = Uint8Array.from(png, (char) => char.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], 'upload.png', { type: 'image/png' }));
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    });
    await input.fill('Inspect this image');
    await expect(window.locator('.composer-image-thumbs img')).toBeVisible();

    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve; });
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    let sendStarted = false;
    await window.route('**/api/v1/projects/*/attachments', async (route) => {
      const response = outcome === 'success' ? await route.fetch() : null;
      await uploadGate;
      if (response) await route.fulfill({ response });
      else await route.fulfill({ status: 500, json: { message: 'Upload unavailable' } });
    });
    await window.route(`**/api/v1/threads/${threadId}/send`, async (route) => {
      sendStarted = true;
      await sendGate;
      await route.continue();
    });

    try {
      await input.press('Enter');
      const status = window.getByTestId('thread-command-upload-progress');
      const composer = window.locator('.thread-command-card');
      const banner = window.getByTestId('thread-workspace-banner');
      await expect(composer.getByRole('status')).toHaveText(/Uploading \d+%/);
      await expect(banner).toBeVisible();
      await expect(status).toHaveCSS('display', 'flex');
      await expect(status).toHaveCSS('padding-left', '12px');
      const bannerBox = (await banner.boundingBox())!;
      const composerBox = (await composer.boundingBox())!;
      const statusBox = (await status.boundingBox())!;
      expect(Math.abs(composerBox.y - (bannerBox.y + bannerBox.height))).toBeLessThanOrEqual(1);
      expect(statusBox.y).toBeGreaterThan(composerBox.y);
      expect(statusBox.y + statusBox.height).toBeLessThan(composerBox.y + composerBox.height);
      expect(statusBox.x).toBeGreaterThan(composerBox.x);
      expect(statusBox.x + statusBox.width).toBeLessThan(composerBox.x + composerBox.width);
      expect(sendStarted).toBe(false);
      await window.screenshot({ path: testInfo.outputPath('upload-composer.png') });

      releaseUpload();
      await expect(status).toHaveCount(0);
      if (outcome === 'success') {
        await expect.poll(() => sendStarted).toBe(true);
        // Delivery is still pending: the completed upload must not linger at 100%.
        await expect(window.getByTestId('thread-command-send')).toHaveAttribute('aria-busy', 'true');
        releaseSend();
        await expect(window.locator('.composer-image-thumbs')).toHaveCount(0);
      } else {
        await expect(window.getByTestId('thread-command-error')).toHaveText('Upload unavailable');
        await expect(window.getByTestId('thread-command-send')).toBeEnabled();
        await expect(input).toHaveText('Inspect this image');
        await expect(window.locator('.composer-image-thumbs img')).toBeVisible();
        expect(sendStarted).toBe(false);
      }
    } finally {
      releaseUpload();
      releaseSend();
      await window.unrouteAll({ behavior: 'wait' });
    }
  });
}
