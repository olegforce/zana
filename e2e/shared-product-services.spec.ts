import { test, expect, launchApp } from './fixtures/app.js';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

test('two clients share authoritative settings and schedules through product HTTP without local IPC', async ({ home }) => {
  test.setTimeout(180_000);
  const app = await launchApp(home);
  const folder = join(home, 'shared-project'); mkdirSync(folder, { recursive: true });
  try {
    const project = await app.window.evaluate(async path => {
      const result = await window.cc.projects.add(path);
      return result;
    }, folder);
    const projectId = (project as any).value?.id ?? (project as any).id;
    expect(projectId).toBeTruthy();
    const url = app.window.url();
    const opened = app.electron.waitForEvent('window');
    await app.electron.evaluate(({ BrowserWindow }, url) => {
      const client = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      void client.loadURL(url);
    }, url);
    const client = await opened;
    await client.waitForLoadState('domcontentloaded');
    await client.addInitScript(() => {
      const Native = window.WebSocket;
      (window as any).__productConnections = [];
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          if ((window as any).__pauseProductConnection) throw new Error('fixture offline');
          super(url, protocols);
          (window as any).__productConnections.push(this);
        }
      };
    });
    await client.reload();
    expect(await client.evaluate(() => typeof window.cc)).toBe('undefined');
    await client.evaluate(() => {
      const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws');
      (window as any).__sharedEvents = [];
      socket.onmessage = event => { try { (window as any).__sharedEvents.push(JSON.parse(event.data)); } catch {} };
      (window as any).__sharedSocket = socket;
    });
    await expect.poll(() => client.evaluate(() => (window as any).__sharedSocket.readyState)).toBe(1);
    const call = (method: string, args: unknown[]) => client.evaluate(async ({ method, args }) => {
      const response = await fetch('/api/v1/shared-product', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) });
      return { status: response.status, body: await response.json() };
    }, { method, args });
    const nativeAddedPath = join(home, 'desktop-added-after-browser'); mkdirSync(nativeAddedPath);
    const nativeAdded = await app.window.evaluate(path => window.cc.projects.add(path), nativeAddedPath);
    expect(nativeAdded.ok).toBe(true);
    if (!nativeAdded.ok) throw new Error(nativeAdded.message);
    const nativeId = nativeAdded.value.id;
    await expect.poll(() => client.evaluate(id => (window as any).__sharedEvents.some((event: any) => event.type === 'projects:changed' && event.payload.some((project: any) => project.id === id)), nativeId)).toBe(true);
    await expect(client.getByRole('button', { name: 'Open desktop-added-after-browser', exact: true })).toBeVisible();
    await app.window.evaluate(id => window.cc.projects.update(id, { name: 'Renamed on desktop' }), nativeId);
    await expect(client.getByRole('button', { name: 'Open Renamed on desktop', exact: true })).toBeVisible();
    await app.window.evaluate(id => window.cc.projects.reorder([id]), nativeId);
    await expect.poll(() => client.evaluate(id => (window as any).__sharedEvents.some((event: any) => event.type === 'projects:changed' && event.payload[0]?.id === id), nativeId)).toBe(true);
    const touched = await app.window.evaluate(id => window.cc.projects.touch(id), nativeId);
    await expect.poll(() => client.evaluate(({ id, at }) => (window as any).__sharedEvents.some((event: any) => event.type === 'projects:changed' && event.payload.some((project: any) => project.id === id && project.lastActiveAt === at)), { id: nativeId, at: touched!.lastActiveAt })).toBe(true);
    await app.window.evaluate(id => window.cc.projects.remove(id), nativeId);
    expect((await app.window.evaluate(() => window.cc.projects.list())).some(project => project.id === nativeId)).toBe(false);
    await expect(client.getByRole('button', { name: 'Open Renamed on desktop', exact: true })).toHaveCount(0);
    const caps = await client.evaluate(() => fetch('/api/v1/system/instance').then(r => r.json()));
    expect(caps.sharedProductServices).toBe(true);
    expect((await call('config.set', [{ theme: 'light' }])).body.ok).toBe(true);
    expect((await app.window.evaluate(() => window.cc.config.get())).theme).toBe('light');
    expect((await call('config.get', [])).body.value.theme).toBe('light');
    await expect(client.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect.poll(() => client.evaluate(() => (window as any).__sharedEvents.some((event: any) => event.type === 'shared:changed' && event.payload.channel === 'config:onChanged'))).toBe(true);
    // Miss a setting notification entirely, then prove the app's own reconnect
    // subscription reads authoritative state without reloading the page.
    await client.evaluate(() => {
      (window as any).__pauseProductConnection = true;
      for (const socket of (window as any).__productConnections) socket.close();
    });
    await app.window.evaluate(() => window.cc.config.set({ theme: 'dark' }));
    await expect(client.locator('html')).toHaveAttribute('data-theme', 'light');
    await client.evaluate(() => { (window as any).__pauseProductConnection = false; });
    await expect(client.locator('html')).toHaveAttribute('data-theme', 'dark');
    // Re-establish the extra test observer (the application reconnects itself).
    await client.evaluate(() => {
      const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws');
      socket.onmessage = event => { (window as any).__sharedEvents.push(JSON.parse(event.data)); };
      (window as any).__sharedSocket = socket;
    });
    await expect.poll(() => client.evaluate(() => (window as any).__sharedSocket.readyState)).toBe(1);
    const created = await call('scheduler.create', [{ projectId, name: 'One shared schedule', profile: 'shell', every: '1d', enabled: false, inboxLevel: 'silent' }]);
    expect(created.body).toMatchObject({ ok: true, value: { ok: true } });
    const id = created.body.value.value.id;
    expect((await app.window.evaluate(() => window.cc.scheduler.list())).filter(row => row.id === id)).toHaveLength(1);
    expect((await call('scheduler.list', [])).body.value.filter((row: any) => row.id === id)).toHaveLength(1);
    expect((await call('windows.open', ['https://evil.example'])).status).toBe(400);
    expect((await call('scheduler.create', [{ projectId: 'foreign-project', name: 'Rejected', every: '1d', profile: 'shell' }])).body.value).toMatchObject({ ok: false, code: 'UNKNOWN_PROJECT' });
    const terminal = await call('terminals.create', [{ projectId, profile: 'shell', cols: 80, rows: 24 }]);
    expect(terminal.body).toMatchObject({ ok: true, value: { ok: true } });
    const sessionId = terminal.body.value.value.id;
    expect((await app.window.evaluate(id => window.cc.terminals.list(id), projectId)).some(row => row.id === sessionId)).toBe(true);
    await call('terminals.write', [sessionId, "printf 'shared-client-run' > shared-terminal-proof.txt\r"]);
    const marker = join(folder, 'shared-terminal-proof.txt');
    await expect.poll(() => existsSync(marker)).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe('shared-client-run');
    await expect.poll(() => client.evaluate(id => (window as any).__sharedEvents.some((event: any) => event.type === 'shared:changed' && event.payload.channel === 'terminals:onData' && event.payload.args[0] === id), sessionId)).toBe(true);
    await call('terminals.close', [sessionId]);
    expect((await call('executionBoard.listProject', [projectId])).body.value).toEqual({ executions: [], hasMore: false });
    expect((await call('executionBoard.stop', ['foreign-project', 'foreign-execution', 0])).body.value).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect((await call('executionBoard.relaunchMonitor', [projectId, 'foreign-execution'])).status).toBe(400);
    await call('scheduler.delete', [id]);
    const removalSchedule = await call('scheduler.create', [{ projectId, scope: { projectId }, name: 'Remove with project', profile: 'shell', every: '1d', enabled: false }]);
    const removalGoal = await call('goals.create', [{ projectId, scope: { projectId }, title: 'Remove with project', statement: 'Never launch', successCriteria: ['unused'] }]);
    const removalFollowup = await call('followups.create', [{ projectId, scope: { projectId }, title: 'Remove with project' }]);
    for (const result of [removalSchedule, removalGoal, removalFollowup]) expect(result.body.value).toMatchObject({ ok: true });
    const removalTerminal = await call('terminals.create', [{ projectId, profile: 'shell', cols: 80, rows: 24 }]);
    expect(removalTerminal.body.value).toMatchObject({ ok: true });
    expect((await call('projects.remove', [projectId])).body.ok).toBe(true);
    expect((await app.window.evaluate(() => window.cc.projects.list())).some(project => project.id === projectId)).toBe(false);
    for (const family of ['scheduler', 'goals', 'followups']) expect((await call(`${family}.list`, [])).body.value.some((row: any) => row.projectId === projectId)).toBe(false);
    await expect.poll(() => app.window.evaluate(id => window.cc.terminals.list(id).then(rows => rows.filter(row => row.status !== 'exited').length), projectId)).toBe(0);
    // Removing a registry entry does not delete its retained metadata files.
    expect(existsSync(join(folder, '.zcc/schedules', `${removalSchedule.body.value.value.id}.json`))).toBe(true);
    await client.close();
  } finally { await app.electron.close(); }
});
