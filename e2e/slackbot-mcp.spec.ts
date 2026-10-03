import { test, expect, launchApp } from './fixtures/app.js';
import { createServer, request } from 'node:https';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, symlinkSync, chmodSync } from 'node:fs';
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
  const deletions: any[] = [];
  const postedTs = new WeakMap<object, string>();
  const presentations: any[] = [];
  const modalViews: any[] = [], canvases: any[] = [], nativeStatuses: any[] = [];
  let rejectCanvas = false;
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
    if (method === 'conversations.info') return { ok: true, channel: args.channel === 'D123456' ? { id: 'D123456', user: 'U123456', is_im: true, is_archived: false } : managed.get(args.channel) || channel };
    if (method === 'views.publish') return { ok: true, view: { id: 'V123456' } };
    if (method === 'views.update') return { ok: true, view: { id: args.view_id } };
    if (method === 'views.open') { modalViews.push(args.view); return { ok: true, view: { id: `VFORM${modalViews.length}` } }; }
    if (method === 'agents.sessions.setStatus') { nativeStatuses.push(args); return { ok: true }; }
    if (method === 'assistant.threads.setSuggestedPrompts') return { ok: true };
    if (method === 'canvases.create') { canvases.push(args); return rejectCanvas ? { ok: false, error: 'missing_scope' } : { ok: true, canvas_id: 'F123456' }; }
    if (method === 'canvases.access.set') return { ok: true };
    if (method === 'chat.getPermalink') return { ok: true, permalink: `https://app.slack.com/client/${identity.team}/${channel.id}?thread_ts=${args.message_ts}` };
    if (method === 'chat.postMessage') { const ts = `${Math.floor(Date.now() / 1000)}.${String(++sequence).padStart(6, '0')}`; posts.push(args); postedTs.set(args, ts); return { ok: true, channel: args.channel, ts }; }
    if (method === 'chat.delete') { deletions.push(args); return { ok: true, channel: args.channel, ts: args.ts }; }
    if (method === 'chat.update') { if (!args.text && !args.blocks) return { ok: false, error: 'no_text' }; posts.push(args); return { ok: true, channel: args.channel, ts: args.ts }; }
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
    // Instrument the real plugin in an isolated copy to invoke its registered
    // agent question tool. No testing RPC is added to production or to the user's install.
    const fixtureSource = join(home, 'slack-plugin');
    cpSync(source!, fixtureSource, { recursive: true, filter: p => !['node_modules', '.git', 'coverage'].includes(p.split('/').at(-1)!) });
    symlinkSync(join(source!, 'node_modules'), join(fixtureSource, 'node_modules'), 'dir');
    renameSync(join(fixtureSource, 'server.ts'), join(fixtureSource, 'real-server.ts'));
    writeFileSync(join(fixtureSource, 'server.ts'), `import original from './real-server.ts';\nexport default async zcc => {\n  let ask, publish; const register = zcc.agents.registerTool.bind(zcc.agents);\n  zcc.agents.registerTool = tool => { if (tool.name === 'slack_bridge_ask') ask = tool; if (tool.name === 'slack_bridge_publish') publish = tool; return register(tool); };\n  await original(zcc);\n  zcc.rpc.method('fixtureAsk', args => ask.execute({ questions: args.questions }, { threadId: args.threadId, projectId: args.projectId }));\n  zcc.rpc.method('fixturePublish', args => publish.execute({ text: args.text }, { threadId: args.threadId, projectId: args.projectId }));\n}\n`);
    const pluginStore = join(home, '.zcc/plugins'); mkdirSync(pluginStore, { recursive: true });
    writeFileSync(join(pluginStore, 'installed.json'), JSON.stringify({ version: 1, plugins: [{ id: 'slack-bridge-2ff2', version: '0.14.2', name: 'Zana for Slack', enabled: true, status: 'running', provenance: 'direct', sourceKind: 'path', source: `path:${fixtureSource}`, rootDir: fixtureSource, serverEntry: './server.ts', appEntry: './app.js', installedAt: Date.now(), updatedAt: Date.now() }] }));
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
    // Only this isolated agent emits phase signals; production code reads the
    // real normalized ACP events, without retaining thought or tool content.
    const activityBin = join(home, 'activity-bin'), activityAgent = join(home, 'slack-activity-agent.mjs');
    mkdirSync(activityBin);
    const fakeAgent = readFileSync(resolve('plugins/provider-acp/src/bridge/fake-acp-agent.mjs'), 'utf8');
    const hangBranch = '  } else if (text.includes("hang")) {';
    expect(fakeAgent).toContain(hangBranch);
    writeFileSync(activityAgent, fakeAgent.replace(hangBranch, `  } else if (text.includes("slack-emoji-phase")) {
      notifyUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "PRIVATE_REASONING_FIXTURE" } });
      setTimeout(() => notifyUpdate({ sessionUpdate: "tool_call", toolCallId: "emoji-tool", title: "Fixture work", kind: "execute", status: "in_progress", rawInput: { command: "PRIVATE_TOOL_FIXTURE" } }), 16000);
      return;
${hangBranch}`));
    const activityLauncher = join(activityBin, 'opencode');
    writeFileSync(activityLauncher, readFileSync(resolve('e2e/fixtures/bin/opencode'), 'utf8').replace("await import('../../../plugins/provider-acp/src/bridge/fake-acp-agent.mjs');", `await import(${JSON.stringify(activityAgent)});`));
    chmodSync(activityLauncher, 0o755);
    app = await launchApp(home, { caCertPath: cert, env: { ...await phonePortEnv(), PATH: `${activityBin}${delimiter}${resolve('e2e/fixtures/bin')}${delimiter}${process.env.PATH}`, FAKE_ACP_MODEL_CONFIG: '1', FAKE_ACP_MODE_CONFIG: '1' }, initialConfig: { tmuxScope: 'off', harnessOpenCodeEnabled: true } });
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
    await win.getByLabel('Default Project for mentions', {exact:true}).selectOption(projectId);
    await expect.poll(async () => (await rpc('snapshot')).config.mentionDefaultProjectId).toBe(projectId);
    await win.getByLabel('Default Project for mentions', {exact:true}).selectOption('');
    await expect.poll(async () => (await rpc('snapshot')).config.mentionDefaultProjectId).toBeUndefined();
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
    const options = (await tool('zana_launch_options', { project_id: projectId, harness: 'acp-opencode' })).body.result.structuredContent;
    expect(options).toMatchObject({ default_harness: 'acp-opencode', models: expect.arrayContaining([expect.objectContaining({ id: 'fake/default' })]) });
    const args = { project_id: projectId, channel_id: imported.channel_id, harness: 'acp-opencode', model: 'fake/default', task: 'Reply with Slackbot job ready.', request_id: 'slackbot_e2e_001' };
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
    expect(started.body.result.structuredContent).toMatchObject({ state: 'queued', harness: 'acp-opencode', model: 'fake/default' });
    const jobId = started.body.result.structuredContent.job_id;
    await tool('zana_launch_job', args);
    await expect.poll(async () => (await rpc('snapshot')).bindings.length, { timeout: 45_000 }).toBe(1);
    const binding = (await rpc('snapshot')).bindings[0];
    expect(posts.filter(p => p.text === `Task from Zana: ${args.task}`)).toHaveLength(1);
    await expect.poll(async () => (await tool('zana_job_status', { job_id: jobId })).body.result.structuredContent.state, { timeout: 30_000 }).toBe('idle');
    expect((await tool('zana_job_status', { job_id: jobId }, 'U234567')).body.result.structuredContent.error).toBe('not_connected');
    await test.step('Slash launch chooses harness/model and replies in the calling channel', async () => {
      const eventCall = (body: any) => {
        const time = String(Math.floor(Date.now() / 1000));
        return post('/api/slack/events/', body, { 'x-slack-request-timestamp': time, 'x-slack-signature': `v0=${createHmac('sha256', 'signing-secret').update(`v0:${time}:${JSON.stringify(body)}`).digest('hex')}` });
      };
      expect((await eventCall({command:'/zana',text:`run ${projectId} Reply with launch picker`,team_id:identity.team,api_app_id:identity.app,user_id:'U123456',channel_id:channel.id,trigger_id:'launch-anywhere-e2e'})).status).toBe(200);
      await expect.poll(() => modalViews.some(v => v.callback_id === 'zana_launch_v1')).toBe(true);
      const form = modalViews.find(v => v.callback_id === 'zana_launch_v1'), viewId = `VFORM${modalViews.indexOf(form)+1}`;
      const harness = form.blocks.find((b: any) => b.label?.text === 'Harness').element;
      expect(harness.options.some((o: any) => o.value === 'acp-opencode')).toBe(true);
      expect(form.blocks.find((b: any) => b.block_id === `destination_${projectId}`).element.initial_option.value).toBe(channel.id);
      const values = {project:{launch_project:{selected_option:{value:projectId}}}, [`destination_${projectId}`]:{channel:{selected_option:{value:channel.id}}}, [`harness_${projectId}`]:{launch_harness:{selected_option:{value:'acp-opencode'}}}, [`model_${projectId}_acp-opencode`]:{launch_model:{selected_option:{value:'fake/default'}}}, task:{prompt:{value:'Reply with launch picker'}}};
      const view = {...form,id:viewId,state:{values}};
      const suggestions = await eventCall({type:'block_suggestion',team:{id:identity.team},api_app_id:identity.app,user:{id:'U123456'},action_id:'launch_model',block_id:`model_${projectId}_acp-opencode`,value:'fake',view});
      expect(suggestions.body.options).toEqual(expect.arrayContaining([expect.objectContaining({value:'fake/default'})]));
      const submitted = await eventCall({type:'view_submission',team:{id:identity.team},api_app_id:identity.app,user:{id:'U123456'},view});
      expect(submitted.body.response_action).toBe('update');
      await expect.poll(async () => (await rpc('snapshot')).bindings.find((b: any) => b.title === 'Reply with launch picker')?.channel, {timeout:30_000}).toBe(channel.id);
      const second = (await rpc('snapshot')).bindings.find((b: any) => b.title === 'Reply with launch picker');
      const launched = await win.evaluate(async id => (await fetch(`/api/v1/threads/${id}`)).json(), second.threadId);
      expect(launched.thread).toMatchObject({providerId:'acp-opencode',model:'fake/default'});
      expect(posts.filter(p => p.text === 'Task from Zana: Reply with launch picker')).toHaveLength(1);
      await expect.poll(async () => (await rpc('snapshot')).bindings.find((b: any) => b.threadId === second.threadId)?.state).toBe('idle');
    });

    await test.step('A direct mention uses Default Project in an unmapped thread without forms or control buttons', async () => {
      const defaultProject = (await rpc('snapshot')).projects.find((p: any) => p.quickAgent === true);
      expect(defaultProject).toBeTruthy();
      const defaultImport = (await tool('zana_import_project', {project_id: defaultProject.id})).body.result.structuredContent;
      expect(defaultImport.state).toBe('imported');
      const modalCount = modalViews.length;
      const signedEvent = (body: any) => {
        const time = String(Math.floor(Date.now() / 1000));
        return post('/api/slack/events/', body, { 'x-slack-request-timestamp': time, 'x-slack-signature': `v0=${createHmac('sha256', 'signing-secret').update(`v0:${time}:${JSON.stringify(body)}`).digest('hex')}` });
      };
      const parent = '1790000000.123456';
      const mention = {type:'event_callback',event_id:'EvOrdinaryThreadLaunch',team_id:identity.team,api_app_id:identity.app,event:{type:'app_mention',user:'U123456',channel:channel.id,thread_ts:parent,ts:`${Math.floor(Date.now()/1000)}.111111`,text:'<@U999999> Reply with mention launch'}};
      expect((await signedEvent(mention)).status).toBe(200);
      await signedEvent(mention);
      await expect.poll(async()=> (await rpc('snapshot')).bindings.find((b:any)=>b.root===parent)?.state,{timeout:30_000}).toBe('idle');
      const launched = (await rpc('snapshot')).bindings.find((b:any)=>b.root===parent);
      expect(launched).toMatchObject({channel:channel.id,projectId:defaultProject.id,providerId:'acp-opencode',sourceChannel:defaultImport.channel_id});
      const actual = await win.evaluate(async id => (await fetch(`/api/v1/threads/${id}`)).json(), launched.threadId);
      expect(actual.thread).toMatchObject({projectId:defaultProject.id,providerId:'acp-opencode',model:'fake/default'});
      expect(modalViews).toHaveLength(modalCount);
      expect(posts.filter(p=>p.text==='Task from Zana: Reply with mention launch')).toHaveLength(0);
      await expect.poll(()=>posts.find(p=>p.thread_ts===parent && p.blocks?.some((b:any)=>b.type==='section'))).toBeTruthy();
      const statuses = posts.filter(p=>p.thread_ts===parent);
      expect(JSON.stringify(statuses)).not.toMatch(/launch_here|bridge_(mute|unmute|stop|open)|Runs on your configured/);
      const plainFollowup = {...mention,event_id:'EvOrdinaryThreadFollowup',event:{...mention.event,type:'message',ts:`${Math.floor(Date.now()/1000)}.222222`,text:'Reply with threaded follow-up'}};
      const beforeReply = (await rpc('snapshot')).requests.length;
      expect((await signedEvent({...plainFollowup,event_id:'EvOtherPersonsReply',event:{...plainFollowup.event,user:'U234567'}})).status).toBe(200);
      expect((await signedEvent({...plainFollowup,event_id:'EvUnboundReply',event:{...plainFollowup.event,thread_ts:'1790000000.987654'}})).status).toBe(200);
      expect((await signedEvent({...plainFollowup,event_id:'EvAmbientMessage',event:{...plainFollowup.event,thread_ts:undefined}})).status).toBe(200);
      expect((await rpc('snapshot')).requests).toHaveLength(beforeReply);
      expect((await signedEvent(plainFollowup)).status).toBe(200);
      await signedEvent(plainFollowup);
      await expect.poll(async()=> (await rpc('snapshot')).requests.find((r:any)=>r.id==='EvOrdinaryThreadFollowup')?.state,{timeout:30_000}).toBe('settled');
      expect((await rpc('snapshot')).bindings.filter((b:any)=>b.root===parent)).toHaveLength(1);
      expect((await rpc('snapshot')).bindings.find((b:any)=>b.root===parent).threadId).toBe(launched.threadId);
      expect((await rpc('snapshot')).requests.filter((r:any)=>r.id==='EvOrdinaryThreadFollowup')).toHaveLength(1);
      expect(await rpc('fixturePublish',{threadId:launched.threadId,projectId:defaultProject.id,text:'Plain follow-up received and answered.'})).toEqual({state:'queued'});
      await expect.poll(()=>posts.some(p=>p.thread_ts===parent && p.text==='Plain follow-up received and answered.')).toBe(true);
      await expect.poll(async () => (await rpc('snapshot')).deliveries.find((d: any) => d.id === 'status:EvOrdinaryThreadFollowup')?.state).toBe('removed');
      const phaseMention = {...mention, event_id: 'EvEmojiLifecycle', event: {...mention.event, ts: `${Math.floor(Date.now()/1000)}.333333`, text: '<@U999999> hang slack-emoji-phase'}};
      expect((await signedEvent(phaseMention)).status).toBe(200);
      await expect.poll(async () => (await rpc('snapshot')).deliveries.find((d: any) => d.id === 'status:EvEmojiLifecycle' && d.state === 'sent')?.ts, { timeout: 20_000 }).toBeTruthy();
      const phaseStatus = (await rpc('snapshot')).deliveries.find((d: any) => d.id === 'status:EvEmojiLifecycle');
      await expect.poll(() => posts.find(p => p.ts === phaseStatus.ts && p.text === '🧠 Thinking…'), { timeout: 25_000 }).toBeTruthy();
      const thinkingIndex = posts.findIndex(p => p.ts === phaseStatus.ts && p.text === '🧠 Thinking…');
      await expect.poll(() => posts.slice(thinkingIndex + 1).find(p => p.ts === phaseStatus.ts && p.text.startsWith('⚙️ ')), { timeout: 25_000 }).toBeTruthy();
      expect((await signedEvent({...mention, event_id: 'EvEmojiStop', event: {...mention.event, ts: `${Math.floor(Date.now()/1000)}.444444`, text: '<@U999999> stop'}})).status).toBe(200);
      await expect.poll(() => posts.find(p => p.ts === phaseStatus.ts && p.text.startsWith('⏹️ Agent stopped.')), { timeout: 20_000 }).toBeTruthy();
      await expect.poll(async () => (await rpc('snapshot')).bindings.find((b: any) => b.root === parent)?.active).toBeFalsy();
      expect(posts.filter(p => postedTs.get(p) === phaseStatus.ts)).toHaveLength(1);
      const cleanupEvent = {...mention, event_id: 'EvCleanAnswer', event: {...mention.event, ts: `${Math.floor(Date.now()/1000)}.555555`, text: '<@U999999> Reply with a clean answer'}};
      expect((await signedEvent(cleanupEvent)).status).toBe(200);
      await expect.poll(async () => (await rpc('snapshot')).deliveries.find((d: any) => d.id === 'status:EvCleanAnswer' && d.state === 'sent')?.ts, { timeout: 20_000 }).toBeTruthy();
      const cleanupStatus = (await rpc('snapshot')).deliveries.find((d: any) => d.id === 'status:EvCleanAnswer');
      expect(await rpc('fixturePublish', { threadId: launched.threadId, projectId: defaultProject.id, text: 'Clean answer without completion chatter.' })).toEqual({ state: 'queued' });
      await expect.poll(async () => (await rpc('snapshot')).deliveries.find((d: any) => d.id === 'status:EvCleanAnswer')?.state, { timeout: 20_000 }).toBe('removed');
      const cleanAnswer = (await rpc('snapshot')).deliveries.find((d: any) => d.id === 'answer:EvCleanAnswer');
      expect(cleanAnswer.state).toBe('sent');
      expect(deletions).toContainEqual({ channel: channel.id, ts: cleanupStatus.ts });
      expect(deletions.some(d => d.ts === cleanAnswer.ts)).toBe(false);
      expect(JSON.stringify(posts)).not.toContain('Turn ended');
      expect(await rpc('fixturePublish', { threadId: launched.threadId, projectId: defaultProject.id, text: 'Revised clean answer.' })).toEqual({ state: 'queued' });
      await expect.poll(() => posts.find(p => p.ts === cleanAnswer.ts && p.text === 'Revised clean answer.'), { timeout: 20_000 }).toBeTruthy();
      expect(deletions.filter(d => d.ts === cleanupStatus.ts)).toHaveLength(1);

      expect(JSON.stringify(posts)).not.toMatch(/PRIVATE_REASONING_FIXTURE|PRIVATE_TOOL_FIXTURE/);
      expect(JSON.stringify(posts.filter(p => p.ts === phaseStatus.ts || postedTs.get(p) === phaseStatus.ts))).not.toMatch(/bridge_(mute|unmute|stop|open)|"type":"actions"/);

    });

    await test.step('Slack-owned file and browser presentation is refused while hidden automation works', async () => {
      writeFileSync(join(projectDir, 'surface.ts'), 'export const visibleInChat = true;\n');
      const result = await win.evaluate(async ({ threadId }) => {
        const post = async (path: string, body: unknown) => {
          const r = await fetch('/api/v1/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          return { status: r.status, body: await r.json() };
        };
        const preview = await post(`threads/${threadId}/open`, { file: { source: 'workspace', path: 'surface.ts' } });
        const thread = await (await fetch(`/api/v1/threads/${threadId}`)).json();
        const hostId = thread.thread.hostId;
        const instances = await post('desktop-browsers/instances', { hostId });
        const instance = instances.body.instances[0];
        if (!instance) throw Error('The built desktop browser must be connected');
        const scope = { hostId, instanceId: instance.instanceId, generation: instance.generation, threadId };
        const visible = await post('desktop-browsers/create', { ...scope, url: 'about:blank', presentation: 'reveal' });
        const hidden = await post('desktop-browsers/create', { ...scope, url: 'about:blank', presentation: 'hidden' });
        const tabId = hidden.body.tab.tabId;
        const revealed = await post('desktop-browsers/reveal', { ...scope, tabId });
        const acquired = await post('desktop-browsers/acquire', { ...scope, tabIds: [tabId], controllerLabel: 'Remote regression', ttlMs: 30_000, allowPersonal: false });
        const tabs = await post('desktop-browsers/tabs', scope);
        if (acquired.status === 200) await post('desktop-browsers/release', { ...scope, leaseId: acquired.body.leaseId });
        await post('desktop-browsers/close', { ...scope, tabId });
        const stored = await (await fetch(`/api/v1/threads/${threadId}/tabs`)).json();
        return { preview, visible, revealed, hidden: hidden.status, acquired: acquired.status, tabs: tabs.body.tabs, stored };
      }, { threadId: binding.threadId });
      expect(result.preview).toMatchObject({ status: 409, body: { code: 'presentation_unavailable' } });
      expect(result.visible.status).toBe(409);
      expect(result.revealed.status).toBe(409);
      expect(result.hidden).toBe(200);
      expect(result.acquired).toBe(200);
      expect(result.tabs.every((tab: any) => tab.presentation === 'hidden')).toBe(true);
      expect(JSON.stringify(result.stored)).not.toContain('surface.ts');
      expect(JSON.stringify(result.stored)).not.toContain('browser:');
    });
    await test.step('Custom panel opens through signed Connect and revokes access', async () => {
      // Actual installed plugin -> signed Connect -> shared Slack entity -> private panel reads.
      const richResult = { title: 'Release review', sections: [
        { type: 'text', title: 'Finding', text: 'All checks passed. Synthetic fixture data.' },
        { type: 'table', title: 'Checks', columns: ['Check', 'Duration (ms)'], rows: [['Delivery', '210'], ['Launch', '120'], ['Permissions', '80']] },
        { type: 'chart', title: 'Check duration', unit: 'Milliseconds', points: [{ label: 'Delivery', value: 210 }, { label: 'Launch', value: 120 }] },
        { type: 'code', title: 'Source excerpt', language: 'typescript', text: 'const literal = "</script><img src=x onerror=alert(1)>";' },
        { type: 'diff', title: 'Suggested change', text: '- retries: 0\n+ retries: 2' },
        { type: 'tasks', title: 'Next steps', items: [{ text: 'Run checks', status: 'done' }, { text: 'Review change', status: 'running' }, { text: 'Publish after approval', status: 'pending' }] },
      ] };
      const richSharing = win.getByLabel('Share rich results');
      await expect(richSharing).not.toBeChecked();
      await richSharing.click();
      await expect.poll(async () => (await rpc('snapshot')).config.richResultsEnabled).toBe(true);
      expect(await rpc('publish', { threadId: binding.threadId, projectId, text: 'Synthetic release review is ready.', result: richResult })).toEqual({ state: 'queued' });
      await expect.poll(() => posts.some(p => p.blocks?.some((b: any) => b.type === 'data_visualization')), { timeout: 20_000 }).toBe(true);
      const reportPost = posts.find(p => p.blocks?.some((b: any) => b.type === 'data_visualization'));
      expect(reportPost).toMatchObject({ channel: imported.channel_id, thread_ts: binding.root, mrkdwn: false, parse: 'none' });
      expect(reportPost.blocks.some((b: any) => b.type === 'table')).toBe(true);
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
      expect(JSON.parse(panel.body).result).toEqual(richResult);
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
        await expect(browserPage.getByRole('button', { name: 'Report', exact: true })).toBeVisible();
        await browserPage.screenshot({ path: testInfo.outputPath('slack-task-summary.png'), fullPage: true });
        await browserPage.getByRole('button', { name: 'Report', exact: true }).click();
        await expect(browserPage.locator('#result h2')).toHaveText('Release review');
        await browserPage.getByRole('button', { name: 'Sort by Duration (ms)' }).click();
        await expect(browserPage.locator('tbody tr').first()).toHaveText('Permissions80');
        await expect(browserPage.getByRole('img', { name: /Check duration: Delivery 210/ })).toBeVisible();
        await expect(browserPage.locator('.diff-added')).toHaveText('+ retries: 2');
        await expect(browserPage.locator('.result-lane')).toHaveCount(3);
        await expect(browserPage.locator('#result img')).toHaveCount(0);
        await expect(browserPage.locator('#result code').first()).toContainText('</script><img');
        await browserPage.screenshot({ path: testInfo.outputPath('slack-rich-result-panel.png'), fullPage: true });
        // Slack's default side panel is just above the old 540px breakpoint.
        // Its task lanes must stack before text becomes a few words per line.
        await browserPage.setViewportSize({ width: 551, height: 800 });
        const laneRects = await browserPage.locator('.result-lane').evaluateAll(nodes => nodes.map(node => {
          const rect = node.getBoundingClientRect();
          return { left: rect.left, top: rect.top, bottom: rect.bottom };
        }));
        expect(laneRects[1].left).toBe(laneRects[0].left);
        expect(laneRects[1].top).toBeGreaterThan(laneRects[0].bottom);
        expect(laneRects[2].top).toBeGreaterThan(laneRects[1].bottom);
        await browserPage.screenshot({ path: testInfo.outputPath('slack-rich-result-default-panel.png'), fullPage: true });
        await browserPage.setViewportSize({ width: 360, height: 800 });
        expect(await browserPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await browserPage.screenshot({ path: testInfo.outputPath('slack-rich-result-narrow.png'), fullPage: true });
        expect(panelErrors).toEqual([]);
        const before = accountReads;
        maliciousPanel = true;
        await browserPage.goto("about:blank");
        await browserPage.goto(preview.href);
        await expect.poll(async () => {
          try { return JSON.parse(await browserPage.locator('body').innerText()); } catch { return { panelErrors }; }
        }).toMatchObject({ cookie: 'blocked', storage: 'blocked', account: 'blocked', taskStatus: 200, title: expect.stringContaining('Reply with Slackbot') });
        expect(accountReads).toBe(before);
        maliciousPanel = false;
        // A URL with the same capability fragment is a same-document navigation.
        // Leave the previous fixture before requesting the ordinary panel again.
        await browserPage.goto('about:blank');
        await browserPage.emulateMedia({ colorScheme: 'light' });
        await browserPage.goto(preview.href);
        await expect(browserPage.locator('#state')).toHaveText('Ready');
        await browserPage.evaluate(() => {
          const now = Date.now();
          Date.now = () => now + 600_001;
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await expect(browserPage.locator('#state')).toHaveText('Unavailable');
        await expect(browserPage.locator('.state')).toHaveClass('state unavailable');
        await expect(browserPage.locator('#result-nav')).toBeHidden();
        await expect(browserPage.locator('#connection')).toContainText('Access expired');
        await expect(browserPage.locator('.state')).toHaveCSS('color', 'rgb(81, 104, 120)');
        await browserPage.screenshot({ path: testInfo.outputPath('slack-task-expired.png'), fullPage: true });
      } finally {
        maliciousPanel = false;
        await app!.electron.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), previewWindowId);
      }
      await richSharing.click();
      await expect.poll(async () => (await rpc('snapshot')).config.richResultsEnabled).toBe(false);
      expect((await get(dataPath, { authorization: `Bearer ${panelKey}` })).status).toBe(403);
      await rpc('configureHostedEmbed', { enabled: false });
      expect((await get(dataPath, { authorization: `Bearer ${panelKey}` })).status).toBe(403);
      const deliveredReport = (await rpc('snapshot')).deliveries.find((d: any) => d.result && d.state === 'sent');
      expect(await rpc('removeTaskPreview', { id: deliveredReport.id })).toEqual({ state: 'removed' });
      expect(posts.at(-1)).toMatchObject({ ts: deliveredReport.ts, metadata: {}, attachments: [] });
      expect(posts.at(-1).text).toBe(deliveredReport.text);
      expect(posts.at(-1).blocks.some((b: any) => b.type === 'table')).toBe(true);
      expect(posts.at(-1).blocks.some((b: any) => b.type === 'data_visualization')).toBe(true);
      await rpc('setRichResults', { enabled: true });
      await rpc('publish', { threadId: binding.threadId, projectId, text: 'Inline report without a task card.', result: richResult });
      await expect.poll(() => posts.find(p => p.text === 'Inline report without a task card.'), { timeout: 20_000 }).toBeTruthy();
      const inlineReport = posts.find(p => p.text === 'Inline report without a task card.');
      expect(inlineReport.metadata).toBeUndefined();
      expect(inlineReport.blocks.some((b: any) => b.type === 'table')).toBe(true);
      expect(inlineReport.blocks.some((b: any) => b.type === 'data_visualization')).toBe(true);
      await rpc('setRichResults', { enabled: false });
    });

    await test.step('Private agent chat, question forms and Canvas snapshots use the real plugin and signed Connect', async () => {
      for (const label of ['Private agent chat', 'Question forms in Slack', 'Publish shared answers to Canvas']) {
        const box = win.getByLabel(label); await expect(box).not.toBeChecked(); await box.click(); await expect(box).toBeChecked();
      }
      const signedEvent = async (payload: any) => {
        const raw = JSON.stringify(payload), time = String(Math.floor(Date.now() / 1000));
        return post('/api/slack/events/', payload, { 'x-slack-request-timestamp': time, 'x-slack-signature': `v0=${createHmac('sha256', 'signing-secret').update(`v0:${time}:${raw}`).digest('hex')}` });
      };
      const root = `${Math.floor(Date.now() / 1000)}.654321`;
      const dm = { type: 'event_callback', team_id: identity.team, api_app_id: identity.app, event_id: 'EvPrivateChat', event: { type: 'message', user: 'U123456', channel: 'D123456', ts: root, text: 'hang until stopped' } };
      expect((await signedEvent(dm)).status).toBe(200);
      await expect.poll(() => posts.filter(p => p.channel === 'D123456' && p.blocks?.some((b: any) => b.elements?.some((e: any) => e.action_id === 'agent_project'))).length).toBe(1);
      const welcome = (await rpc('snapshot')).surfaceLog.find((s: any) => s.title === 'Private agent chat');
      expect(welcome.state).toBe('ready');
      expect((await rpc('snapshot')).bindings).toHaveLength(3);
      const welcomeDelivery = (await db.query("SELECT id FROM slack_objects WHERE kind='message' AND id LIKE $1", [`${identity.team}:message:D123456:%`]))[0];
      const welcomeTs = welcomeDelivery.id.split(':').at(-1);
      expect((await signedEvent({ type: 'block_actions', team: { id: identity.team }, api_app_id: identity.app, user: { id: 'U123456' }, container: { channel_id: 'D123456', message_ts: welcomeTs }, message: { ts: welcomeTs, thread_ts: root }, actions: [{ action_id: 'agent_project', action_ts: `${Math.floor(Date.now() / 1000)}.000001`, selected_option: { value: imported.channel_id } }] })).status).toBe(200);
      await expect.poll(async () => (await rpc('snapshot')).bindings.find((b: any) => b.channel === 'D123456')?.active, { timeout: 30_000 }).toBeTruthy();
      const privateBinding = (await rpc('snapshot')).bindings.find((b: any) => b.channel === 'D123456');
      expect(privateBinding).toMatchObject({ sourceChannel: imported.channel_id, projectId });
      await expect.poll(() => nativeStatuses.some(s => s.status === 'processing'), { timeout: 20_000 }).toBe(true);
      await rpc('setSlackAccess', { id: 'followups', enabled: false });
      await expect(rpc('fixtureAsk', { threadId: privateBinding.threadId, projectId, questions: [{ text: 'How much detail?', options: ['Brief', 'Detailed'] }] })).rejects.toThrow('disabled');
      await rpc('setSlackAccess', { id: 'followups', enabled: true });
      const question = await rpc('fixtureAsk', { threadId: privateBinding.threadId, projectId, questions: [{ text: 'How much detail?', options: ['Brief', 'Detailed'] }] });
      expect(question.state).toBe('queued');
      await expect.poll(async () => (await rpc('snapshot')).deliveries.find((d: any) => d.questionId === question.id)?.state).toBe('sent');
      const questionDelivery = (await rpc('snapshot')).deliveries.find((d: any) => d.questionId === question.id);
      const click = (action_id: string, d: any, trigger: string) => ({ type: 'block_actions', team: { id: identity.team }, api_app_id: identity.app, user: { id: 'U123456' }, container: { channel_id: d.channel, message_ts: d.ts }, message: { thread_ts: d.root }, trigger_id: trigger, actions: [{ action_id, value: d.id, action_ts: `${Math.floor(Date.now() / 1000)}.000001` }] });
      expect((await signedEvent(click('question_open', questionDelivery, 'question-trigger'))).status).toBe(200);
      await expect.poll(() => modalViews.some(v => v.callback_id === 'zana_question_v1')).toBe(true);
      const questionView = modalViews.find(v => v.callback_id === 'zana_question_v1'), questionViewId = `VFORM${modalViews.indexOf(questionView) + 1}`;
      expect(JSON.stringify(questionView)).toContain('cannot approve tool execution');
      const stopTs = `${Math.floor(Date.now() / 1000)}.000002`;
      expect((await signedEvent({ ...dm, event_id: 'EvNativeStop', event: { type: 'agent_session_stopped', channel: 'D123456', user: 'U123456', thread_ts: root, event_ts: stopTs } })).status).toBe(200);
      await expect.poll(async () => (await rpc('snapshot')).bindings.find((b: any) => b.key === privateBinding.key)?.active, { timeout: 20_000 }).toBeFalsy();
      expect((await signedEvent({ type: 'view_submission', team: { id: identity.team }, api_app_id: identity.app, user: { id: 'U123456' }, view: { id: questionViewId, callback_id: questionView.callback_id, private_metadata: questionView.private_metadata, state: { values: { q0: { choice: { selected_option: { value: '0' } } } } } } })).body).toEqual({ response_action: 'clear' });
      await expect.poll(async () => (await rpc('snapshot')).requests.some((r: any) => r.id.startsWith('form:') && r.state === 'settled'), { timeout: 30_000 }).toBe(true);
      expect((await rpc('snapshot')).bindings).toHaveLength(4);
      expect(await rpc('publish', { threadId: privateBinding.threadId, projectId, text: 'Synthetic private chat result is ready.' })).toEqual({ state: 'queued' });
      await expect.poll(async () => (await rpc('snapshot')).deliveries.find((d: any) => d.text === 'Synthetic private chat result is ready.')?.state).toBe('sent');
      const result = (await rpc('snapshot')).deliveries.find((d: any) => d.text === 'Synthetic private chat result is ready.');
      expect((await signedEvent(click('canvas_open', result, 'canvas-trigger'))).status).toBe(200);
      await expect.poll(() => modalViews.some(v => v.callback_id === 'zana_canvas_v1')).toBe(true);
      const canvasView = modalViews.find(v => v.callback_id === 'zana_canvas_v1');
      expect(JSON.stringify(canvasView)).toContain('linked Slack owner'); expect(canvases).toHaveLength(0);
      expect((await signedEvent({ type: 'view_submission', team: { id: identity.team }, api_app_id: identity.app, user: { id: 'U123456' }, view: { id: `VFORM${modalViews.indexOf(canvasView) + 1}`, callback_id: canvasView.callback_id, private_metadata: canvasView.private_metadata } })).body).toEqual({ response_action: 'clear' });
      await expect.poll(async () => (await rpc('snapshot')).surfaceLog.find((s: any) => s.id === canvasView.private_metadata)?.state, { timeout: 30_000 }).toBe('published');
      expect(canvases).toHaveLength(1); expect(canvases[0].channel_id).toBeUndefined();
      expect(canvases[0].document_content.markdown).toContain('Synthetic private chat result');
      await expect(win.getByRole('link', { name: 'Open Canvas', exact: true })).toBeVisible();
      rejectCanvas = true;
      await rpc('publish', { threadId: privateBinding.threadId, projectId, text: 'Synthetic export failure trial.' });
      await expect.poll(async () => (await rpc('snapshot')).deliveries.find((d: any) => d.text === 'Synthetic export failure trial.')?.state).toBe('sent');
      const rejectedResult = (await rpc('snapshot')).deliveries.find((d: any) => d.text === 'Synthetic export failure trial.');
      await signedEvent(click('canvas_open', rejectedResult, 'rejected-canvas-trigger'));
      await expect.poll(() => modalViews.filter(v => v.callback_id === 'zana_canvas_v1').length).toBe(2);
      const rejectedView = modalViews.filter(v => v.callback_id === 'zana_canvas_v1').at(-1);
      await signedEvent({ type: 'view_submission', team: { id: identity.team }, api_app_id: identity.app, user: { id: 'U123456' }, view: { id: `VFORM${modalViews.indexOf(rejectedView) + 1}`, callback_id: rejectedView.callback_id, private_metadata: rejectedView.private_metadata } });
      await expect.poll(async () => (await rpc('snapshot')).surfaceLog.find((s: any) => s.id === rejectedView.private_metadata)?.state).toBe('failed');
      await expect.poll(async () => (await rpc('snapshot')).deliveries.find((d: any) => d.id.startsWith('canvas-notice:'))?.state).toBe('sent');
      expect(posts.some(p => p.channel === 'D123456' && p.thread_ts === root && p.text.includes('Canvas export could not be completed'))).toBe(true);
      expect(canvases).toHaveLength(2);
      await win.screenshot({ path: testInfo.outputPath('slack-all-surfaces-settings.png') });
      await win.getByLabel('Private agent chat').click();
      const count = (await rpc('snapshot')).requests.length;
      expect((await signedEvent({ ...dm, event_id: 'EvDisabledChat', event: { ...dm.event, ts: `${Math.floor(Date.now() / 1000)}.000003`, thread_ts: root, text: 'Do more work' } })).status).toBe(200);
      await slack.drain(); expect((await rpc('snapshot')).requests).toHaveLength(count);
    });

    await accessSection.getByRole('switch', { name: 'Allow View job progress' }).click();
    await expect.poll(async () => (await tool('zana_job_status', { job_id: jobId })).body.result.structuredContent.error).toBe('functionality_disabled');
    await accessSection.getByRole('switch', { name: 'Allow View job progress' }).click();

    await slack.registry.revoke((await slack.registry.owner('U123456')).id, 'owner');
    expect((await tool('zana_job_status', { job_id: jobId })).body.result.structuredContent.error).toBe('not_connected');
    expect((await rpc('snapshot')).bindings).toHaveLength(4);
    await test.step('Open the Slack job in the desktop conversation', async () => {
      await win.getByRole('button', { name: 'Open in Zana', exact: true }).last().click();
      await expect(win.getByTestId('thread-timeline')).toContainText(args.task, { timeout: 15_000 });
      await win.screenshot({ path: testInfo.outputPath('slackbot-job-thread.png') });
    });
  } finally {
    await app?.electron.close(); await slack.close(); await gateway.close(); edge.closeAllConnections(); await new Promise<void>(resolve => edge.close(() => resolve())); await db.close();
  }
});
