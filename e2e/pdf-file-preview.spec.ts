import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './fixtures/app.js';

test.use({ launchEnv: { ZCC_FAKE_PROVIDER: '1' }, initialConfig: { sponsorPromptDismissed: true } });

test('PDF preview renders and downloads original bytes in Electron', async ({ app }) => {
  const { window, home, electron } = app;
  expect(await window.evaluate(() => window.cc.extensions.install({ kind: 'bundled', id: 'pdf-preview' }))).toMatchObject({ ok: true });
  await expect.poll(() => window.evaluate(async () => (await window.cc.pluginApps.list()).find(row => row.id === 'pdf-preview')?.status)).toBe('running');
  const root = join(realpathSync(home), 'pdf-preview-project');
  mkdirSync(root);
  // A real Chromium-generated PDF exercises the native viewer, including fonts.
  const bytes = Buffer.from(await electron.evaluate(async ({ BrowserWindow }) => {
    const offscreen = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false } });
    try {
      await offscreen.loadURL('data:text/html,<h1>PDF preview regression</h1><p>Complete original document.</p>');
      return Array.from(await offscreen.webContents.printToPDF({}));
    } finally { offscreen.destroy(); }
  }));
  const path = 'report #1.pdf';
  writeFileSync(join(root, path), bytes);
  const threadId = await window.evaluate(async (root) => {
    const project = await window.cc.projects.add(root);
    if (!project.ok) throw new Error('Project registration failed');
    const response = await fetch('/api/v1/threads', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.value.id, providerId: 'fake', input: 'PDF regression' })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(body));
    const id = (body.thread ?? body.value).id;
    history.pushState({}, '', `/threads/${id}`);
    dispatchEvent(new PopStateEvent('popstate'));
    return id as string;
  }, root);
  await expect(window.getByTestId('thread-detail')).toBeVisible();
  await window.evaluate(() => {
    (window as any).__pdfCspViolations = [];
    document.addEventListener('securitypolicyviolation', event => {
      (window as any).__pdfCspViolations.push({ uri: event.blockedURI, directive: event.effectiveDirective });
    });
  });
  const open = async (source: 'workspace' | 'thread-storage', filePath: string) => {
    const status = await window.evaluate(async ({ threadId, source, filePath }) => {
      const response = await fetch(`/api/v1/threads/${threadId}/open`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: { source, path: filePath } })
      });
      return response.status;
    }, { threadId, source, filePath });
    expect(status).toBe(200);
  };
  await open('workspace', path);
  const preview = window.getByTestId('pdf-preview');
  const download = preview.getByRole('link', { name: 'Download PDF', exact: true });
  const expectNativePdf = async (url: string) => {
    // A frame load alone also fires when CSP blocks a PDF. Prove the real
    // Chromium viewer parsed it and completed loading its page instead.
    await expect.poll(async () => {
      const frame = window.frames().find(frame => frame.url().startsWith('chrome-extension://') && frame.parentFrame()?.url() === url);
      if (!frame) return null;
      return frame.evaluate(() => {
        const viewer = document.querySelector('pdf-viewer') as HTMLElement & { docLength_: number; loadProgress_: number } | null;
        return viewer ? { pages: viewer.docLength_, progress: viewer.loadProgress_ } : null;
      });
    }).toMatchObject({ pages: 1, progress: 100 });
  };
  await expect(download).toBeVisible();
  await expect(preview.getByRole('status')).toHaveCount(0);
  await expectNativePdf((await preview.locator('iframe').getAttribute('src'))!);
  expect(await window.evaluate(() => (window as any).__pdfCspViolations)).toEqual([]);
  const target = join(home, 'downloaded-report.pdf');
  const nativeWindow = await electron.browserWindow(window);
  await nativeWindow.evaluate((win, target) => {
    win.webContents.session.once('will-download', (_event, item) => item.setSavePath(target));
  }, target);
  await download.click();
  await expect.poll(() => existsSync(target)).toBe(true);
  await expect.poll(() => readFileSync(target).equals(bytes)).toBe(true);

  const storageRoot = join(home, '.zcc', 'thread-storage', threadId);
  mkdirSync(storageRoot, { recursive: true });
  writeFileSync(join(storageRoot, 'stored.pdf'), bytes);
  await open('thread-storage', 'stored.pdf');
  await expect(download).toHaveAttribute('download', 'stored.pdf');
  await expect(preview.getByRole('status')).toHaveCount(0);
  await expectNativePdf((await preview.locator('iframe').getAttribute('src'))!);
  expect(await window.evaluate(() => (window as any).__pdfCspViolations)).toEqual([]);

  writeFileSync(join(root, 'invalid.pdf'), 'Not a PDF');
  await open('workspace', 'invalid.pdf');
  await expect(window.getByRole('alert')).toContainText('not a PDF');
  writeFileSync(join(root, 'invalid.pdf'), bytes);
  await window.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(download).toHaveAttribute('download', 'invalid.pdf');

  // Library PDFs use data URLs, which share the same frame policy.
  await window.evaluate(async base64 => {
    await window.cc.library.importFile({ scope: 'global', relPath: 'library.pdf', base64 });
    history.pushState({}, '', '/plugins/docs/panel/global/library.pdf');
    dispatchEvent(new PopStateEvent('popstate'));
  }, bytes.toString('base64'));
  const libraryFrame = window.locator('iframe.library-pdf-preview');
  await expect(libraryFrame).toBeVisible();
  await expectNativePdf((await libraryFrame.getAttribute('src'))!);
  expect(await window.evaluate(() => (window as any).__pdfCspViolations)).toEqual([]);
});
