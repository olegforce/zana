import { test, expect, launchApp } from './fixtures/app.js';
import { createServer, request } from 'node:https';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { openConnectDatabase } from '../website/connect/database.mjs';
import { createRegistry } from '../website/connect/registry.mjs';
import { createConnectGateway } from '../website/connect/gateway.mjs';
import { createSlackService } from '../website/slack/service.mjs';
import { phonePortEnv } from './fixtures/phone-port.js';

// Zana for Slack is an independently installed local plugin, outside core's checkout.
const source = process.env.ZCC_SLACK_BRIDGE_DIR;
test.skip(!source || !existsSync(join(source, 'src/slackbot.ts')), 'Set ZCC_SLACK_BRIDGE_DIR to the Zana for Slack 0.14.2 source project.');
test('Slackbot selective imports and plugin capabilities work through the real Connect tunnel and built desktop', async ({ home }, testInfo) => {
  test.setTimeout(180_000);
  const cert = join(home, 'slack-cert.pem'), key = join(home, 'slack-key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:*.connect.zana.test,IP:127.0.0.1'], { stdio: 'ignore' });
  const db = await openConnectDatabase(':memory:', { production: false }); await db.migrate();
  await db.query('CREATE TABLE users(id TEXT PRIMARY KEY,github_login TEXT)');
  await db.query('CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id TEXT,expires_at BIGINT)');
  await db.query('INSERT INTO users VALUES($1,$1)', ['owner']);
  await db.query('INSERT INTO sessions VALUES($1,$2,$3)', ['fixture', 'owner', Date.now() + 180_000]);
  const cookie = `zcc_session=fixture.${createHmac('sha256', 'account-secret').update('fixture').digest('base64url')}`;
  let gateway: any, slack: any, origin: string;
  let maliciousPanel = false, accountReads = 0;
  const edge = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
    req.headers['x-forwarded-proto'] = 'https';
    if (req.url === '/fixture/account') { accountReads++; res.writeHead(200, { 'content-type': 'text/html' }); res.end('<script>localStorage.setItem("accountSecret", "private-account")</script>'); return; }
    if (!req.url?.startsWith('/api/slack/') && !req.url?.startsWith('/api/connect/slack/')) { void gateway.handleHttp(req, res); return; }
    void (async () => {
      const response = await slack.dispatch(new Request(`${origin}${req.url}`, { method: req.method, headers: req.headers as any, ...(!['GET', 'HEAD'].includes(req.method!) ? { body: Readable.toWeb(req) as any, duplex: 'half' } : {}) } as any));
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    })().catch(() => { res.writeHead(500); res.end(); });
  });
  edge.on('upgrade', (req, socket, head) => { req.headers['x-forwarded-proto'] = 'https'; void gateway.handleUpgrade(req, socket, head); });
  edge.listen(0, '127.0.0.1'); await once(edge, 'listening');
  const port = (edge.address() as { port: number }).port;
  origin = `https://127.0.0.1:${port}`;
  const registry = createRegistry(db, { domain: `connect.zana.test:${port}`, accountUrl: origin });
  gateway = createConnectGateway({ db, registry, sessionSecret: 'account-secret' });
  const identity = { team: 'T123456', app: 'A123456', bot: 'U999999' };
  let sequence = 0;
  const posts: any[] = [];
  const presentations: any[] = [];
  const managed = new Map<string, any>();
  let channelCreates = 0;
  const channel = { id: 'C123456', name: 'slackbot-jobs', is_member: true, is_archived: false, is_shared: false, is_ext_shared: false, is_org_shared: false };
  slack = await createSlackService({ db, connect: registry, dispatchPlugin: async (args: any) => {
    const request = JSON.parse(args.payload.body);
    if (maliciousPanel && request.kind === 'embed' && request.action === 'page') {
      const dataPath = `/api/slack/tasks/${args.payload.linkId}/data/${request.entityId}`;
      return { status: 200, body: { accepted: true, response: { status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src * 'unsafe-inline'; sandbox allow-scripts allow-same-origin; frame-ancestors *" },
        body: `<body><script>(async () => {
          const result = {};
          for (const [key, read] of Object.entries({ cookie: () => document.cookie, storage: () => localStorage.getItem('accountSecret') })) {
            try { result[key] = read(); } catch { result[key] = 'blocked'; }
          }
          try { await fetch('/fixture/account', { credentials: 'include' }); result.account = 'allowed'; } catch { result.account = 'blocked'; }
          const key = new URLSearchParams(location.hash.slice(1)).get('key');
          const data = await fetch(${JSON.stringify(dataPath)}, { headers: { authorization: 'Bearer ' + key }, credentials: 'omit' });
          result.taskStatus = data.status; result.title = (await data.json()).title;
          document.body.textContent = JSON.stringify(result);
        })();</script></body>` } } };
    }
    return gateway.dispatchPlugin(args);
  }, pluginId: 'slack-bridge-2ff2', sessionSecret: 'account-secret', signingSecret: 'signing-secret', identity, call: async (method: string, args: any) => {
    if (method === 'entity.presentDetails') { presentations.push(args); return { ok: true }; }
    if (method === 'users.info') return { ok: true, user: { id: args.user, team_id: identity.team, is_bot: false, deleted: false, is_restricted: false, is_ultra_restricted: false } };
    if (method === 'users.conversations') return { ok: true, channels: [channel, ...managed.values()] };
    if (method === 'conversations.create') { const created = { ...channel, id: `G12345${++channelCreates}`, name: args.name, is_private: true }; managed.set(created.id, created); return { ok: true, channel: created }; }
    if (method === 'conversations.invite') return { ok: true };
    if (method === 'conversations.rename') { const renamed = { ...managed.get(args.channel), name: args.name }; managed.set(args.channel, renamed); return { ok: true, channel: renamed }; }
    if (method === 'conversations.info') return { ok: true, channel: managed.get(args.channel) || channel };
    if (method === 'views.publish') return { ok: true, view: { id: 'V123456' } };
    if (method === 'chat.getPermalink') return { ok: true, permalink: `https://app.slack.com/client/${identity.team}/${channel.id}?thread_ts=${args.message_ts}` };
    if (method === 'chat.postMessage') { posts.push(args); return { ok: true, channel: args.channel, ts: `${Math.floor(Date.now() / 1000)}.${String(++sequence).padStart(6, '0')}` }; }
    if (method === 'chat.update') { posts.push(args); return { ok: true, channel: args.channel, ts: args.ts }; }
    throw new Error(`Unexpected fixture Slack API ${method}`);
  } });
  function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = request(`${origin}${path}`, { ca: readFileSync(cert), method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, res => { let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) })); });
      req.on('error', reject); req.end(JSON.stringify(body));
    });
  }
  async function tool(name: string, args: unknown = {}, user = 'U123456', valid = true) {
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: { slack: { user_id: user, team_id: identity.team, enterprise_id: null } } } };
    const time = String(Math.floor(Date.now() / 1000));
    return post('/api/slack/mcp/', body, { 'x-slack-request-timestamp': time, 'x-slack-signature': valid ? `v0=${createHmac('sha256', 'signing-secret').update(`v0:${time}:${JSON.stringify(body)}`).digest('hex')}` : 'forged' });
  }
  let app: Awaited<ReturnType<typeof launchApp>> | undefined;
  try {
    const pluginStore = join(home, '.zcc/plugins'); mkdirSync(pluginStore, { recursive: true });
    writeFileSync(join(pluginStore, 'installed.json'), JSON.stringify({ version: 1, plugins: [{ id: 'slack-bridge-2ff2', version: '0.14.2', name: 'Zana for Slack', enabled: true, status: 'running', provenance: 'direct', sourceKind: 'path', source: `path:${source}`, rootDir: source, serverEntry: './server.ts', appEntry: './app.js', installedAt: Date.now(), updatedAt: Date.now() }] }));
    const consumer = join(home, 'slack-capability-fixture'); mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'slack-capability-fixture', version: '1.0.0', zcc: { name: 'Slack capability fixture', server: './server.mjs', requires: ['slack-bridge-2ff2'] } }));
    writeFileSync(join(consumer, 'server.mjs'), `export default function(zcc) {
      const slack = zcc.services.use('slack-bridge-2ff2');
      const dispose = slack.register(zcc.pluginId, { id: 'inspect', title: 'Inspect fixture', description: 'Read a fixture Project summary', version: 1, readOnly: true, fields: {},
        execute: async (_args, ctx) => { await new Promise(resolve => setTimeout(resolve, 2_100)); return { project_id: ctx.projectId, user: ctx.slackUserId, answer: 'Fixture capability works' }; } });
      zcc.onDispose(dispose);
    }`);
    const installedPath = join(pluginStore, 'installed.json'), installed = JSON.parse(readFileSync(installedPath, 'utf8'));
    installed.plugins.push({ id: 'slack-capability-fixture', version: '1.0.0', name: 'Slack capability fixture', enabled: true, status: 'running', provenance: 'direct', sourceKind: 'path', source: `path:${consumer}`, rootDir: consumer, serverEntry: './server.mjs', appEntry: null, installedAt: Date.now(), updatedAt: Date.now() });
    writeFileSync(installedPath, JSON.stringify(installed));
    app = await launchApp(home, { caCertPath: cert, env: { ...await phonePortEnv(), PATH: `${resolve('e2e/fixtures/bin')}${delimiter}${process.env.PATH}`, FAKE_ACP_MODEL_CONFIG: '1', FAKE_ACP_MODE_CONFIG: '1' }, initialConfig: { tmuxScope: 'off', harnessOpenCodeEnabled: true } });
    await app.electron.evaluate(() => {
      const dns = process.getBuiltinModule('dns'), original = dns.lookup;
      dns.lookup = ((hostname: string, options: any, callback: any) => hostname.endsWith('.zana.test') ? callback(null, options?.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4) : original(hostname, options, callback)) as typeof dns.lookup;
    });
    const win = app.window;
    await win.getByRole('link', { name: 'Remote access', exact: true }).click();
    await win.getByText('Advanced connection settings', { exact: true }).click();
    await win.getByLabel('Connect service').fill(origin);
    const reservation = await post('/api/connect/computer/reserve', { label: 'slackbot-test' }, { cookie, origin });
    expect(reservation.status).toBe(200);
    await win.getByRole('textbox', { name: 'Connect code', exact: true }).fill(reservation.body.code);
    await expect.poll(() => win.evaluate(() => window.cc.mobile.status()), { timeout: 20_000 }).toMatchObject({ running: true, relayState: 'connected' });
    const rpc = (method: string, args: unknown = {}) => win.evaluate(({ method, args }) => window.cc.pluginApps.callRpc('slack-bridge-2ff2', method, args), { method, args }) as Promise<any>;
    await expect.poll(() => win.evaluate(async () => (await window.cc.pluginApps.list()).find(p => p.id === 'slack-bridge-2ff2')?.status)).toBe('running');
    const connection = (await tool('zana_connect', { domain: 'slackbot-test' })).body.result.structuredContent;
    expect(connection).toMatchObject({ status: 'approval_required', domain: `slackbot-test.connect.zana.test:${port}` });
    expect(await slack.registry.owner('U123456')).toBeUndefined();
    const code = new URL(connection.connect_url).searchParams.get('slack');
    const approved = await post('/api/connect/slack/approve/', { code, serverId: reservation.body.serverId, approved: true }, { cookie, origin });
    expect(approved.status).toBe(200);
    expect(await rpc('linkConnect', { origin, code: approved.body.activationCode })).toBeNull();
    expect(await win.evaluate(() => window.cc.pluginApps.getSettings('slack-bridge-2ff2'))).toMatchObject({ descriptors: {}, values: {} });
    const projectDir = join(home, 'slackbot-project'); mkdirSync(projectDir);
    const projectId = await win.evaluate(async path => { const p = await window.cc.projects.add(path); if (!p.ok) throw new Error(p.message); return p.value.id; }, projectDir);
    const snapshot = await rpc('snapshot');
    const hostId = snapshot.hosts[0].id;
    const untouchedDir = join(home, 'stay-local'); mkdirSync(untouchedDir);
    const untouchedId = await win.evaluate(async path => { const p = await window.cc.projects.add(path); if (!p.ok) throw new Error(p.message); return p.value.id; }, untouchedDir);
    expect(await rpc('configureProjectSync', { enabled: true, hostId, providerId: 'acp-opencode', model: 'fake/default', summaries: true, allowSlackImport: true })).toMatchObject({ created: 0 });
    expect(channelCreates).toBe(0);
    expect((await tool('zana_list_projects', {}, 'U123456', false)).status).toBe(401);
    expect((await tool('zana_list_projects')).body.result.structuredContent.projects).toEqual(expect.arrayContaining([expect.objectContaining({ project_id: projectId, imported: false }), expect.objectContaining({ project_id: untouchedId, imported: false })]));
    expect((await tool('zana_import_project', { project_id: projectId }, 'U234567')).body.result.structuredContent.error).toBe('not_connected');
    expect((await tool('zana_import_project', { project_id: 'unregistered' })).body.result.structuredContent.error).toBe('import_unavailable');
    const imported = (await tool('zana_import_project', { project_id: projectId })).body.result.structuredContent;
    expect(imported).toMatchObject({ state: 'imported', channel_name: 'zana-slackbot-project' });
    await tool('zana_import_project', { project_id: projectId });
    await rpc('syncProjects');
    expect(channelCreates).toBe(1);
    expect((await rpc('snapshot')).config.routes).toEqual([expect.objectContaining({ projectId })]);
    // The renderer exposes the actual import controls and plugin enablement gate.
    await win.evaluate(() => { history.pushState({}, '', '/extensions/plugins/slack-bridge-2ff2?view=installed'); dispatchEvent(new PopStateEvent('popstate')); });
    await expect(win.getByRole('heading', { name: /^Zana for Slack$/i, level: 3 })).toBeVisible();
    await expect(win.getByRole('heading', { name: 'Connected Projects', exact: true })).toBeVisible();
    await expect(win.getByLabel('Slack app ID', { exact: true })).toHaveCount(0);
    await expect(win.getByLabel('App-level token', { exact: true })).toHaveCount(0);
    await expect(win.getByLabel('Bot token', { exact: true })).toHaveCount(0);
    await win.getByLabel('Search Projects', { exact: true }).fill('stay-local');
    await expect(win.getByRole('checkbox', { name: 'Import stay-local', exact: true })).toBeEnabled();
    expect((await tool('zana_list_capabilities')).body.result.structuredContent.capabilities).toEqual([]);
    const capabilityId = 'slack-capability-fixture.inspect';
    expect((await tool('zana_run_capability', { capability_id: capabilityId, arguments_json: JSON.stringify({ project_id: projectId }) })).body.result.structuredContent.error).toBe('capability_unavailable');
    await win.getByRole('switch', { name: 'Enable Inspect fixture' }).click();
    await expect.poll(async () => (await tool('zana_list_capabilities')).body.result.structuredContent.capabilities.length).toBe(1);
    expect((await tool('zana_run_capability', { capability_id: capabilityId, arguments_json: JSON.stringify({ project_id: projectId }) })).body.result.structuredContent).toMatchObject({ result: { project_id: projectId, user: 'U123456', answer: 'Fixture capability works' } });
    expect((await tool('zana_run_capability', { capability_id: capabilityId, arguments_json: JSON.stringify({ project_id: untouchedId }) })).body.result.structuredContent.error).toBe('invalid_arguments');
    await win.getByRole('switch', { name: 'Allow Use plugin tools' }).click();
    await expect.poll(async () => (await tool('zana_run_capability', { capability_id: capabilityId, arguments_json: JSON.stringify({ project_id: projectId }) })).body.result.structuredContent.error).toBe('functionality_disabled');
    await expect(win.getByRole('switch', { name: 'Enable Inspect fixture' })).toBeDisabled();
    await win.getByRole('switch', { name: 'Allow Use plugin tools' }).click();
    await expect.poll(async () => (await tool('zana_list_capabilities')).body.result.structuredContent.capabilities.length).toBe(1);
    await win.getByRole('switch', { name: 'Enable Inspect fixture' }).click();
    await expect.poll(async () => (await tool('zana_list_capabilities')).body.result.structuredContent.capabilities.length).toBe(0);
    await win.screenshot({ path: testInfo.outputPath('slack-project-import-settings.png') });
    expect(await rpc('configureHostedEmbed', { enabled: true })).toBeNull();
    const args = { project_id: projectId, channel_id: imported.channel_id, task: 'Reply with Slackbot job ready.', request_id: 'slackbot_e2e_001' };
    const accessSection = win.getByRole('region', { name: 'What Slack can do' });
    await accessSection.getByRole('switch', { name: 'Allow Start new jobs' }).click();
    await expect.poll(async () => (await rpc('snapshot')).config.slackAccess.launch).toBe(false);
    expect((await tool('zana_launch_job', { ...args, request_id: 'disabled_launch_001' })).body.result.structuredContent.error).toBe('functionality_disabled');
    expect((await rpc('snapshot')).bindings).toHaveLength(0);
    await accessSection.getByLabel('Search Slack functionalities').fill('start new');
    await accessSection.getByRole('button', { name: 'Disabled', exact: true }).click();
    await expect(accessSection.getByRole('switch')).toHaveCount(1);
    await accessSection.getByRole('switch', { name: 'Allow Start new jobs' }).click();
    await accessSection.getByLabel('Search Slack functionalities').fill('');
    await accessSection.getByRole('button', { name: 'All', exact: true }).click();
    await accessSection.getByRole('switch', { name: 'Allow Browse Projects' }).click();
    await expect.poll(async () => (await tool('zana_list_projects')).body.result.structuredContent.error).toBe('functionality_disabled');
    await expect(accessSection.getByRole('switch', { name: 'Allow Start new jobs' })).toBeDisabled();
    await accessSection.getByRole('switch', { name: 'Allow Browse Projects' }).click();
    await expect.poll(async () => (await tool('zana_list_projects')).body.result.structuredContent.projects.length).toBeGreaterThan(0);
    await accessSection.scrollIntoViewIfNeeded();
    await win.screenshot({ path: testInfo.outputPath('slack-functionality-settings.png') });
    const started = await tool('zana_launch_job', args);
    expect(started.body.result.structuredContent).toMatchObject({ state: 'queued' });
    const jobId = started.body.result.structuredContent.job_id;
    await tool('zana_launch_job', args);
    await expect.poll(async () => (await rpc('snapshot')).bindings.length, { timeout: 45_000 }).toBe(1);
    const binding = (await rpc('snapshot')).bindings[0];
    expect(posts.filter(p => p.text === `Task from Zana: ${args.task}`)).toHaveLength(1);
    await expect.poll(async () => (await tool('zana_job_status', { job_id: jobId })).body.result.structuredContent.state, { timeout: 30_000 }).toBe('idle');
    expect((await tool('zana_job_status', { job_id: jobId }, 'U234567')).body.result.structuredContent.error).toBe('not_connected');
    await test.step('Custom panel opens through signed Connect and revokes access', async () => {
      // Actual installed plugin -> signed Connect -> shared Slack entity -> private panel reads.
      await expect.poll(async () => (await rpc('snapshot')).capabilities.features.find((f: any) => f.id === 'status').enabled).toBe(true);
      await expect.poll(() => posts.some(p => p.metadata?.entities?.length), { timeout: 20_000 }).toBe(true);
      const entity = posts.filter(p => p.metadata?.entities?.length).at(-1).metadata.entities[0];
      const details = { type: 'event_callback', event_id: 'EvEmbedE2E', team_id: identity.team, api_app_id: identity.app, event: { type: 'entity_details_requested', user: 'U123456', external_ref: entity.external_ref, entity_url: entity.url, trigger_id: 'embed-e2e-trigger' } };
      const time = String(Math.floor(Date.now() / 1000));
      expect((await post('/api/slack/events/', details, { 'x-slack-request-timestamp': time, 'x-slack-signature': `v0=${createHmac('sha256', 'signing-secret').update(`v0:${time}:${JSON.stringify(details)}`).digest('hex')}` })).status).toBe(200);
      await expect.poll(() => presentations.length, { timeout: 20_000 }).toBe(1);
      const preview = new URL(presentations[0].metadata.entity_payload.attributes.full_size_preview.preview_url);
      expect(preview.search).toBe('');
      const panelKey = new URLSearchParams(preview.hash.slice(1)).get('key');
      const get = (path: string, headers: Record<string, string> = {}): Promise<any> => new Promise((resolve, reject) => {
        const req = request(`${origin}${path}`, { method: 'GET', rejectUnauthorized: false, headers }, res => { let body = ''; res.setEncoding('utf8'); res.on('data', data => { body += data; }); res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers })); }); req.on('error', reject); req.end();
      });
      const shell = await get(preview.pathname); expect(shell.status).toBe(200); expect(shell.body).toContain('Opening your task'); expect(shell.body).not.toContain(args.task);
      const dataPath = preview.pathname.replace('/view/', '/data/');
      expect((await get(dataPath)).status).toBe(403);
      const panel = await get(dataPath, { authorization: `Bearer ${panelKey}` });
      expect(panel.status).toBe(200); expect(JSON.parse(panel.body).title).toContain('Reply with Slackbot');
      expect(panel.headers['cache-control']).toContain('no-store');
      // Chromium must enforce the hosted policy, even if a modified plugin supplies
      // arbitrary HTML and explicitly requests same-origin privileges.
      const windowEvent = app!.electron.waitForEvent('window');
      const previewWindowId = await app!.electron.evaluate(async ({ BrowserWindow, session }, { origin }) => {
        const isolated = session.fromPartition('slack-panel-security');
        isolated.setCertificateVerifyProc((request, callback) => callback(request.hostname === '127.0.0.1' ? 0 : -3));
        await isolated.cookies.set({ url: origin, name: 'account-session', value: 'private-account' });
        const view = new BrowserWindow({ show: false, webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true } });
        await view.loadURL(`${origin}/fixture/account`);
        return view.id;
      }, { origin });
      const browserPage = await windowEvent;
      const panelErrors: string[] = [];
      browserPage.on('pageerror', error => panelErrors.push(error.message));
      browserPage.on('console', message => { if (message.type() === 'error') panelErrors.push(message.text()); });
      try {
        await browserPage.goto(preview.href);
        await expect(browserPage.locator('body')).toContainText('Reply with Slackbot');
        const before = accountReads;
        maliciousPanel = true;
        await browserPage.goto("about:blank");
        await browserPage.goto(preview.href);
        await expect.poll(async () => {
          try { return JSON.parse(await browserPage.locator('body').innerText()); } catch { return { panelErrors }; }
        }).toMatchObject({ cookie: 'blocked', storage: 'blocked', account: 'blocked', taskStatus: 200, title: expect.stringContaining('Reply with Slackbot') });
        expect(accountReads).toBe(before);
      } finally {
        maliciousPanel = false;
        await app!.electron.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), previewWindowId);
      }
      await rpc('configureHostedEmbed', { enabled: false });
      expect((await get(dataPath, { authorization: `Bearer ${panelKey}` })).status).toBe(403);
    });

    await accessSection.getByRole('switch', { name: 'Allow View job progress' }).click();
    await expect.poll(async () => (await tool('zana_job_status', { job_id: jobId })).body.result.structuredContent.error).toBe('functionality_disabled');
    await accessSection.getByRole('switch', { name: 'Allow View job progress' }).click();

    await slack.registry.revoke((await slack.registry.owner('U123456')).id, 'owner');
    expect((await tool('zana_job_status', { job_id: jobId })).body.result.structuredContent.error).toBe('not_connected');
    expect((await rpc('snapshot')).bindings).toHaveLength(1);
    await test.step('Open the Slack job in the desktop conversation', async () => {
      await win.getByRole('button', { name: 'Open in Zana', exact: true }).click();
      await expect(win.getByTestId('thread-timeline')).toContainText(args.task, { timeout: 15_000 });
      await win.screenshot({ path: testInfo.outputPath('slackbot-job-thread.png') });
    });
  } finally {
    await app?.electron.close(); await slack.close(); await gateway.close(); edge.closeAllConnections(); await new Promise<void>(resolve => edge.close(() => resolve())); await db.close();
  }
});
