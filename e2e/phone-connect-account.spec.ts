import { test, expect, launchApp } from './fixtures/app.js';
import { createServer, request } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';
import { openConnectDatabase } from '../website/connect/database.mjs';
import { createRegistry } from '../website/connect/registry.mjs';
import { createConnectGateway } from '../website/connect/gateway.mjs';
import { phonePortEnv } from './fixtures/phone-port.js';

test('Connect enrolls through desktop IPC and serves authenticated phone traffic at the Electron boundary', async ({ home }, testInfo) => {
  test.setTimeout(180_000);
  const cert = join(home, 'connect-cert.pem'), key = join(home, 'connect-key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:*.connect.zana.test,DNS:*.zana.test,IP:127.0.0.1'], { stdio: 'ignore' });
  let gateway: ReturnType<typeof createConnectGateway>;
  const edge = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => { req.headers['x-forwarded-proto'] = 'https'; void gateway.handleHttp(req, res); });
  edge.on('upgrade', (req, socket, head) => { req.headers['x-forwarded-proto'] = 'https'; void gateway.handleUpgrade(req, socket, head); });
  edge.listen(0, '127.0.0.1'); await once(edge, 'listening');
  const port = (edge.address() as { port: number }).port;
  const origin = `https://127.0.0.1:${port}`;
  const db = await openConnectDatabase(':memory:', { production: false }); await db.migrate();
  await db.query('CREATE TABLE users(id TEXT PRIMARY KEY,github_login TEXT)');
  await db.query('CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id TEXT,expires_at BIGINT)');
  await db.query('INSERT INTO users VALUES($1,$1)', ['fixture-owner']);
  await db.query('INSERT INTO sessions VALUES($1,$2,$3)', ['browser-fixture', 'fixture-owner', Date.now() + 180_000]);
  const accountCookie = `zcc_session=browser-fixture.${createHmac('sha256', 'test-account-secret').update('browser-fixture').digest('base64url')}`;
  const registry = createRegistry(db, { domain: `connect.zana.test:${port}`, browserDomain: `zana.test:${port}`, accountUrl: origin });
  gateway = createConnectGateway({ db, registry, sessionSecret: 'test-account-secret' });
  const lookup = (_hostname: string, options: any, callback: any) => callback(null, options?.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4);
  function remote(url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request(url, { lookup, ca: readFileSync(cert), method, headers: { 'content-type': 'application/json', ...headers } }, res => {
        let text = ''; res.on('data', data => text += data); res.on('end', () => resolve({ status: res.statusCode!, body: text }));
      }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  let app: Awaited<ReturnType<typeof launchApp>> | undefined;
  let ws: WebSocket | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let browserContext: Awaited<ReturnType<NonNullable<typeof browser>['newContext']>> | undefined;
  try {
    const pluginDir = join(home, 'connect-probe-plugin'); mkdirSync(pluginDir);
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: 'zcc-plugin-connect-probe', type: 'module', version: '1.0.0', engines: { zcc: '>=1.0.0', zccPluginSdk: '>=0.1.0' }, zcc: { name: 'Connect probe', server: './server.ts' } }));
    writeFileSync(join(pluginDir, 'server.ts'), `export default function(zcc) { zcc.http.route('POST', '/connect', request => ({ json: { accepted: true, echo: request.body } })); }`);
    const pluginStore = join(home, '.zcc/plugins'); mkdirSync(pluginStore, { recursive: true });
    writeFileSync(join(pluginStore, 'installed.json'), JSON.stringify({ version: 1, plugins: [{ id: 'connect-probe', version: '1.0.0', name: 'Connect probe', enabled: true, status: 'running', provenance: 'direct', sourceKind: 'path', source: `path:${pluginDir}`, rootDir: pluginDir, serverEntry: './server.ts', appEntry: null, installedAt: Date.now(), updatedAt: Date.now() }] }));
    // A previously enabled retired connection must not silently become LAN access.
    const retiredPath = join(home, '.zcc/mobile/connection.json');
    mkdirSync(join(home, '.zcc/mobile'), { recursive: true });
    const retiredConfig = JSON.stringify({ mode: 'local', publicUrl: 'https://old-private.example' });
    writeFileSync(retiredPath, retiredConfig);
    app = await launchApp(home, { caCertPath: cert, env: await phonePortEnv(), initialConfig: { mobileGatewayEnabled: true } });
    await expect.poll(() => app!.window.evaluate(() => window.cc.mobile.status())).toMatchObject({ running: false, publicUrl: null, error: expect.stringContaining('no longer supported') });
    expect(readFileSync(retiredPath, 'utf8')).toBe(retiredConfig);
    // Private-process DNS fixture: no public DNS or /etc/hosts mutation, TLS
    // still verifies the generated certificate for the selected laptop host.
    await app.electron.evaluate(({ shell }) => {
      const dns = process.getBuiltinModule('dns'); const original = dns.lookup;
      dns.lookup = ((hostname: string, options: any, callback: any) => hostname.endsWith('.zana.test') ? callback(null, options?.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4) : original(hostname, options, callback)) as typeof dns.lookup;
      shell.openExternal = async url => { (globalThis as any).__connectApprovalUrl = url; };
    });
    const win = app.window;
    const bug = win.getByRole('button', { name: 'Report a bug', exact: true });
    await expect(bug).toBeVisible();
    expect(await bug.evaluate(element => element.nextElementSibling?.getAttribute('aria-label'))).toBe('Remote access');
    await win.screenshot({ path: testInfo.outputPath('remote-access-shortcut.png') });
    await win.getByRole('link', { name: 'Remote access', exact: true }).click();
    await expect(win.getByRole('heading', { name: 'Remote access', exact: true })).toBeVisible();
    await expect(win.getByRole('alert').filter({ hasText: 'Local-network connections are no longer supported' })).toBeVisible();
    await expect(win.getByRole('link', { name: 'Get a connect code' })).toBeVisible();
    await expect(win.getByRole('switch', { name: 'Remote access', exact: true })).toBeDisabled();
    await win.screenshot({ path: testInfo.outputPath('remote-access-pairing.png') });
    await win.getByText('Advanced connection settings', { exact: true }).click();
    await win.getByLabel('Connect service').fill(origin);
    const issued = await remote(`${origin}/api/connect/computer/reserve`, 'POST', { label: 'my-computer' }, { cookie: accountCookie, origin });
    expect(issued.status).toBe(200);
    await win.getByRole('textbox', { name: 'Connect code', exact: true }).fill(JSON.parse(issued.body).code);
    // Pasting alone crosses renderer → IPC → account API and enables the tunnel.
    await expect.poll(() => win.evaluate(() => window.cc.mobile.status()), { timeout: 20_000 }).toMatchObject({ running: true, relayState: 'connected' });
    const state = await win.evaluate(() => window.cc.mobile.status());
    const publicUrl = state.publicUrl!;
    const secretPath = join(home, '.zcc/mobile/connection.json');
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);
    const privateConfig = JSON.parse(readFileSync(secretPath, 'utf8'));
    expect(JSON.stringify(state)).not.toContain(privateConfig.relayToken);
    const reservation = JSON.parse(issued.body);
    expect(privateConfig.serverId).toBe(reservation.serverId);
    const browserUrl = reservation.browserUrl;
    expect(await win.evaluate(() => window.cc.mobile.browserAddress())).toBe(browserUrl);
    await win.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(win.getByRole('link', { name: 'Open Zana', exact: true })).toHaveAttribute('href', browserUrl);
    await win.getByRole('switch', { name: 'Remote access', exact: true }).click();
    await expect.poll(() => win.evaluate(() => window.cc.mobile.status())).toMatchObject({ running: false });
    await expect(win.getByRole('link', { name: 'Open Zana', exact: true })).toHaveCount(0);
    await win.getByRole('switch', { name: 'Remote access', exact: true }).click();
    await expect.poll(() => win.evaluate(() => window.cc.mobile.status())).toMatchObject({ running: true, relayState: 'connected' });
    await expect(win.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
    await win.screenshot({ path: testInfo.outputPath('remote-access-desktop.png') });
    expect(browserUrl).toBe(`https://my-computer.zana.test:${port}`);
    expect(new URL(publicUrl).hostname).toMatch(/^s-[a-f0-9]{24}\.connect\.zana\.test$/);
    browser = await chromium.launch({ args: ['--host-resolver-rules=MAP *.zana.test 127.0.0.1'] });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
    browserContext = context;
    const browserPage = await context.newPage();
    // Real browser navigation obtains the host-only state cookie and follows
    // the account handoff. Approval uses the real account API with a fixture
    // website session, avoiding a live GitHub login in this isolated test.
    await browserPage.goto(browserUrl);
    await expect(browserPage).toHaveURL(new RegExp('/connect/\\?browser='));
    const browserCode = new URL(browserPage.url()).searchParams.get('browser');
    const approval = await remote(`${origin}/api/connect/browser/approve`, 'POST', { code: browserCode }, { cookie: accountCookie, origin });
    expect(approval.status).toBe(200);
    await browserPage.goto(JSON.parse(approval.body).location);
    await expect(browserPage.getByRole('link', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 });
    expect(new URL(browserPage.url()).origin).toBe(browserUrl);
    // A real cold browser can request more than 64 modules at once. Exercise
    // that fan-out through the authenticated TLS relay and installed desktop.
    const assetBurst = await browserPage.evaluate(async () => {
      const asset = document.querySelector<HTMLLinkElement>('link[rel="stylesheet"]')!.href;
      return Promise.all(Array.from({ length: 160 }, async (_, index) => {
        const response = await fetch(`${asset}?burst=${index}`, { cache: 'no-store' });
        const body = await response.arrayBuffer();
        return { status: response.status, size: body.byteLength };
      }));
    });
    expect(assetBurst).toEqual(Array(160).fill({ status: 200, size: assetBurst[0].size }));
    expect(assetBurst[0].size).toBeGreaterThan(8192);

    expect(await browserPage.evaluate(async () => (await fetch('/api/v1/projects')).status)).toBe(200);
    expect(await browserPage.evaluate(async () => (await fetch('/internal/hosts')).status)).toBe(404);
    const browserCookies = await context.cookies(browserUrl);
    expect(browserCookies.find(item => item.name === 'zcc_connect_session')).toMatchObject({ domain: 'my-computer.zana.test', httpOnly: true, secure: true });
    expect(browserCookies.some(item => item.name === 'zcc_connect_state')).toBe(false);
    await browserPage.screenshot({ path: testInfo.outputPath('connect-browser-address.png') });
    await db.query('DELETE FROM sessions WHERE id=$1', ['browser-fixture']);
    expect(await browserPage.evaluate(async () => (await fetch('/api/v1/projects')).status)).toBe(401);
    // The integration dispatch must cross the real tunnel, loopback gateway and
    // product plugin HTTP handler without minting a phone cookie.
    const envelope = { signature: 'test-signature', body: 'large-envelope:'.repeat(2000) };
    const installed = JSON.parse(readFileSync(join(pluginStore, 'installed.json'), 'utf8')).plugins.find((p: any) => p.id === 'connect-probe');
    expect(installed?.status, JSON.stringify(installed)).toBe('running');
    const result = await gateway.dispatchPlugin({ accountId: 'fixture-owner', serverId: privateConfig.serverId, pluginId: 'connect-probe', payload: envelope, timeoutMs: 5000 });
    expect(result).toEqual({ status: 200, body: { accepted: true, echo: envelope } });
    await expect(gateway.dispatchPlugin({ accountId: 'another-owner', serverId: privateConfig.serverId, pluginId: 'connect-probe', payload: envelope })).rejects.toThrow('computer_offline');
    await win.getByRole('link', { name: 'Add a phone', exact: true }).click();
    await expect(win.getByRole('region', { name: 'Zana mobile app' }).getByText('Coming soon', { exact: true })).toBeVisible();
    await expect(win.getByRole('region', { name: 'Use Zana in your mobile browser' })).toBeVisible();
    await expect(win.getByRole('button', { name: 'Show pairing QR', exact: true })).not.toBeVisible();
    await win.screenshot({ path: testInfo.outputPath('connect-phone-sign-in-desktop.png') });
    // Native GitHub flow: the browser's existing authenticated account approves
    // the phone; no QR or LAN gateway is used to acquire its credential.
    await db.query('INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,$3)', ['browser-fixture', 'fixture-owner', Date.now() + 60_000]);
    const started = await remote(`${origin}/api/connect/phone/start`, 'POST', { name: 'Connect phone' });
    expect(started.status).toBe(200); const pendingPhone = JSON.parse(started.body);
    expect(JSON.parse((await remote(`${origin}/api/connect/phone/poll`, 'POST', { deviceCode: pendingPhone.deviceCode })).body)).toEqual({ pending: true });
    const approvedPhone = await remote(`${origin}/api/connect/phone/approve`, 'POST', { code: pendingPhone.userCode, approved: true }, { cookie: accountCookie, origin });
    expect(approvedPhone.status).toBe(200);
    const grantedPhone = await remote(`${origin}/api/connect/phone/poll`, 'POST', { deviceCode: pendingPhone.deviceCode });
    expect(grantedPhone.status).toBe(200); const phone = JSON.parse(grantedPhone.body);
    const computers = await remote(`${origin}/api/connect/servers`, 'GET', undefined, { authorization: `Bearer ${phone.credential}` });
    expect(JSON.parse(computers.body).servers).toEqual(expect.arrayContaining([expect.objectContaining({ serverUrl: publicUrl, browserUrl, live: true })]));
    const session = await remote(`${publicUrl}/_mobile/session`, 'POST', {}, { authorization: `Bearer ${phone.credential}` });
    const cookie = `zcc_mobile_session=${JSON.parse(session.body).cookie.value}`;
    const page = await remote(publicUrl, 'GET', undefined, { cookie }); expect(page.status).toBe(200);
    const asset = page.body.match(/href="(\.?\/assets\/[^\"]+\.css)"/)?.[1]; expect(asset).toBeTruthy();
    const css = await remote(new URL(asset!, publicUrl).href, 'GET', undefined, { cookie });
    expect(css.status).toBe(200); expect(Buffer.byteLength(css.body)).toBeGreaterThan(8192);
    expect((await remote(`${publicUrl}/internal/hosts/tool-call`, 'POST', {}, { cookie })).status).toBe(404);
    expect((await remote(publicUrl, 'GET', undefined, { 'x-zcc-connect-gateway': 'x'.repeat(43) })).status).toBe(401);
    // Readiness traverses the account-authenticated tunnel, never the public health route.
    expect((await remote(`${publicUrl}/_zcc/mobile-ready`, 'POST', { instanceId: 'b'.repeat(32), platform: 'ios', appVersion: '2.3.0' })).status).toBe(401);
    expect((await remote(`${publicUrl}/_zcc/mobile-ready`, 'POST', { instanceId: 'b'.repeat(32), platform: 'ios', appVersion: '2.3.0' }, { cookie })).status).toBe(200);
    await expect.poll(() => win.evaluate(() => window.cc.mobile.status())).toMatchObject({ readySessions: [expect.objectContaining({ label: 'Phone via Connect', appVersion: '2.3.0' })] });
    ws = new WebSocket(publicUrl.replace('https:', 'wss:') + '/ws', { ca: readFileSync(cert), lookup, headers: { cookie, origin: publicUrl } });
    ws.on('error', () => {}); await once(ws, 'open');
    let changed = false; ws.on('message', data => { if (JSON.parse(data.toString()).type === 'config:changed') changed = true; });
    await expect.poll(async () => { if (!changed) await remote(`${publicUrl}/api/v1/config`, 'PATCH', {}, { cookie }); return changed; }).toBe(true);
    const closed = once(ws, 'close');
    expect(await win.evaluate(id => window.cc.mobile.revoke(id), phone.deviceId)).toBe(true);
    expect((await closed)[0]).toBe(1008);
    expect((await remote(publicUrl, 'GET', undefined, { cookie })).status).toBe(401);
    // Revoking from the account page must not trap desktop in a dead connection.
    await registry.revoke('fixture-owner', 'server', privateConfig.serverId);
    await win.getByRole('link', { name: 'Remote access', exact: true }).click();
    await win.getByRole('button', { name: 'Disconnect…', exact: true }).click();
    await win.getByRole('button', { name: 'Disconnect this computer', exact: true }).click();
    await expect.poll(() => win.evaluate(() => window.cc.mobile.status())).toMatchObject({ running: false, connection: { mode: 'unconfigured' } });
  } catch (error) {
    const page = browserContext?.pages()[0];
    if (page && !page.isClosed()) {
      await page.screenshot({ path: testInfo.outputPath('connect-browser-failed.png') });
      await testInfo.attach('connect-browser-page', { body: `${page.url()}\n${await page.content()}`, contentType: 'text/plain' });
    }
    throw error;
  } finally {
    await browserContext?.tracing.stop({ path: testInfo.outputPath('connect-browser-trace.zip') });
    ws?.terminate(); await browser?.close(); await app?.electron.close(); await gateway.close(); edge.closeAllConnections(); await new Promise<void>(resolve => edge.close(() => resolve())); await db.close();
  }
});
