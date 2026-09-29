/**
 * Built-Electron production boundary for the desktop-browser broker:
 * create a tab, acquire a control lease, open loopback CDP, and reveal only
 * when that thread is focused. Cookie values never leave main — this spec
 * only lists import sources against the sandboxed HOME (not the developer's
 * real Chrome). Fixture-DB decrypt/write coverage lives in
 * `apps/desktop/src/browser-import/browser-import.test.ts`.
 */
import { WebSocket } from 'ws';
import { createServer } from 'node:http';
import { test, expect } from './fixtures/app.js';

test.use({ e2e: true });

const THREAD_ID = 'thr_abcdefghij';

test('desktop browser broker leases loopback CDP and reveals a focused thread', async ({ app }) => {
  const { window, electron } = app;
  await expect(window.getByRole('navigation', { name: 'Main navigation' })).toBeVisible({ timeout: 20_000 });

  const created = await electron.evaluate(async (_electron, threadId) => {
    const broker = (globalThis as { __zccDesktopBrowserBroker?: {
      listInstances: () => Array<{ instanceId: string; generation: string }>;
      execute: (command: Record<string, unknown>) => Promise<Record<string, unknown>>;
    } }).__zccDesktopBrowserBroker;
    if (!broker) throw new Error('desktop browser broker tap missing (ZCC_E2E)');
    const [instance] = broker.listInstances();
    if (!instance) throw new Error('no desktop window registered with the broker');
    const tabId = `browser:e2e-${Date.now()}`;
    await broker.execute({
      type: 'desktop.browser.create_tab',
      instanceId: instance.instanceId,
      generation: instance.generation,
      threadId,
      tabId,
      url: 'about:blank',
      profile: { kind: 'automation', id: tabId },
      presentation: 'hidden'
    });
    const leaseId = `lease-e2e-${Date.now()}`;
    const expiresAt = Date.now() + 60_000;
    await broker.execute({
      type: 'desktop.browser.acquire_control',
      instanceId: instance.instanceId,
      generation: instance.generation,
      threadId,
      leaseId,
      tabIds: [tabId],
      controllerLabel: 'E2E',
      expiresAt
    });
    const connection = await broker.execute({
      type: 'desktop.browser.open_connection',
      instanceId: instance.instanceId,
      generation: instance.generation,
      threadId,
      leaseId,
      tabIds: [tabId]
    });
    return {
      instanceId: instance.instanceId,
      generation: instance.generation,
      tabId,
      leaseId,
      wsEndpoint: String(connection.wsEndpoint ?? '')
    };
  }, THREAD_ID);

  expect(created.wsEndpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/cdp\/[a-f0-9]{64}$/);

  const version = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const ws = new WebSocket(created.wsEndpoint);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('CDP Browser.getVersion timed out'));
    }, 10_000);
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    ws.once('message', (data) => {
      clearTimeout(timer);
      ws.close();
      resolve(JSON.parse(String(data)) as Record<string, unknown>);
    });
    ws.once('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
    });
  });
  expect(version).toMatchObject({
    id: 1,
    result: expect.objectContaining({
      product: expect.stringMatching(/Chrome/i)
    })
  });

  await window.evaluate((threadId) => {
    window.history.pushState({}, '', `/threads/${threadId}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, THREAD_ID);
  await expect(window.getByTestId('thread-detail')).toBeVisible({ timeout: 15_000 });

  await electron.evaluate(async (_electron, args) => {
    const broker = (globalThis as { __zccDesktopBrowserBroker?: {
      execute: (command: Record<string, unknown>) => Promise<unknown>;
    } }).__zccDesktopBrowserBroker;
    if (!broker) throw new Error('desktop browser broker tap missing (ZCC_E2E)');
    await broker.execute({
      type: 'desktop.browser.reveal_tab',
      instanceId: args.instanceId,
      generation: args.generation,
      threadId: args.threadId,
      tabId: args.tabId
    });
  }, { ...created, threadId: THREAD_ID });

  await expect(window.getByTestId('thread-browser-tab')).toBeVisible({ timeout: 10_000 });

  const sources = await electron.evaluate(async () => {
    const broker = (globalThis as { __zccDesktopBrowserBroker?: {
      listInstances: () => Array<{ instanceId: string; generation: string }>;
      execute: (command: Record<string, unknown>) => Promise<Record<string, unknown>>;
    } }).__zccDesktopBrowserBroker;
    if (!broker) throw new Error('desktop browser broker tap missing (ZCC_E2E)');
    const [instance] = broker.listInstances();
    if (!instance) throw new Error('no desktop window registered with the broker');
    return broker.execute({
      type: 'desktop.browser.list_import_sources',
      instanceId: instance.instanceId,
      generation: instance.generation
    });
  });
  const listed = Array.isArray((sources as { sources?: unknown }).sources)
    ? (sources as { sources: Array<Record<string, unknown>> }).sources
    : [];
  for (const source of listed) {
    expect(source).not.toHaveProperty('cookies');
    expect(JSON.stringify(source)).not.toMatch(/encrypted_value|cookieValue|"value":"[^"]{8,}"/);
    expect(typeof source.name).toBe('string');
    expect(typeof source.id).toBe('string');
  }
});

test('equivalent previews reuse their page without crossing browser profiles', async ({ app }) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html><body>Persistent preview</body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server port');
  const url = `http://127.0.0.1:${address.port}/`;
  const execute = (command: Record<string, unknown>) => app.electron.evaluate(async (_electron, command) => {
    const broker = (globalThis as { __zccDesktopBrowserBroker?: {
      listInstances: () => Array<{ instanceId: string; generation: string }>;
      execute: (command: Record<string, unknown>) => Promise<Record<string, unknown>>;
    } }).__zccDesktopBrowserBroker;
    if (!broker) throw new Error('Missing desktop broker');
    const [instance] = broker.listInstances();
    return broker.execute({ ...instance, ...command });
  }, { threadId: THREAD_ID, ...command });
  const create = (tabId: string, profile: { kind: 'personal' } | { kind: 'automation'; id: string }, nextUrl = url) => execute({
    type: 'desktop.browser.create_tab', tabId, profile, url: nextUrl, presentation: 'hidden'
  });
  try {
    await create('personal', { kind: 'personal' });
    await expect.poll(async () => (await execute({ type: 'desktop.browser.list_tabs' })).tabs).toEqual([
      expect.objectContaining({ tabId: 'personal', url })
    ]);
    // The same local server with a different host spelling and route keeps its
    // existing page. In particular, this must not reload and lose hot-reload state.
    const duplicateUrl = `http://localhost:${address.port}/client-route`;
    await expect(create('duplicate', { kind: 'personal' }, duplicateUrl)).resolves.toMatchObject({ tab: { tabId: 'personal', url } });
    await expect(create('automation-a', { kind: 'automation', id: 'run-a' })).resolves.toMatchObject({ tab: { tabId: 'automation-a' } });
    await expect(create('automation-b', { kind: 'automation', id: 'run-b' })).resolves.toMatchObject({ tab: { tabId: 'automation-b' } });
    const pages = () => app.electron.evaluate(({ webContents }, url) => webContents.getAllWebContents()
      .filter(contents => contents.getURL() === url)
      .map(contents => ({ id: contents.id, loading: contents.isLoading() })), url);
    await expect.poll(pages).toEqual([
      expect.objectContaining({ loading: false }), expect.objectContaining({ loading: false }), expect.objectContaining({ loading: false })
    ]);
    const before = await pages();
    const requestsBefore = requests;
    await execute({ type: 'desktop.browser.acquire_control', leaseId: 'preview-lease', tabIds: ['automation-a'], controllerLabel: 'Preview regression', expiresAt: Date.now() + 60_000 });
    const connection = await execute({ type: 'desktop.browser.open_connection', leaseId: 'preview-lease', tabIds: ['automation-a'] });
    const createTarget = (endpoint: unknown) => new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(String(endpoint));
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('CDP create target timed out')); }, 10_000);
      ws.once('error', error => { clearTimeout(timer); reject(error); });
      ws.once('open', () => ws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: duplicateUrl } })));
      ws.once('message', data => {
        clearTimeout(timer);
        ws.close();
        const body = JSON.parse(String(data));
        if (body.error) reject(new Error(JSON.stringify(body.error)));
        else resolve();
      });
    });
    await createTarget(connection.wsEndpoint);
    const listed = await execute({ type: 'desktop.browser.list_tabs' });
    expect(listed.tabs).toHaveLength(3);
    expect(await pages()).toEqual(before);
    expect(requests).toBe(requestsBefore);

    // A second controller of the SAME automation profile must also get its
    // own page; URL reuse cannot silently steal a tab from an existing lease.
    await create('second-controller', { kind: 'automation', id: 'run-a' }, 'about:blank');
    await execute({ type: 'desktop.browser.acquire_control', leaseId: 'other-lease', tabIds: ['second-controller'], controllerLabel: 'Other controller', expiresAt: Date.now() + 60_000 });
    const other = await execute({ type: 'desktop.browser.open_connection', leaseId: 'other-lease', tabIds: ['second-controller'] });
    await createTarget(other.wsEndpoint);
    const controlled = (await execute({ type: 'desktop.browser.list_tabs' })).tabs as Array<{ tabId: string; control: { leaseId: string } | null }>;
    expect(controlled).toHaveLength(5);
    expect(controlled.find(tab => tab.tabId === 'automation-a')?.control?.leaseId).toBe('preview-lease');
    expect(controlled.filter(tab => tab.control?.leaseId === 'other-lease')).toHaveLength(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
