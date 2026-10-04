import { browserAccount, bearer, json, readJson } from '../connect/http.mjs';
import { createSlackRegistry } from './registry.mjs';
import { createScopedSlack } from './api.mjs';
import { envelope, hash, rateLimiter, readBody, SlackError, verifiedSlack } from './security.mjs';
import { createSlackbotMcp } from './mcp.mjs';
import { createTaskEndpoint, taskBase, taskId, taskTrigger } from './embeds.mjs';
import { createSlackOnboarding } from './onboarding.mjs';
import { addHomeMachines, createHomeMachines } from './home-machines.mjs';

const notice = text => ({ response_type: 'ephemeral', text });
const offline = 'Your computer or Slack plugin is unavailable. No new request has been queued. Open Zana on your chosen computer, then try again.';
const uncertain = 'Delivery is unconfirmed. Check Zana for Slack → Diagnostics on your computer before sending the task again.';

export async function createSlackService({ db, connect, dispatchPlugin, pluginId, sessionSecret, signingSecret, identity, call, now = Date.now, intervalMs = 1000 }) {
  const registry = createSlackRegistry({ db, sessionSecret, identity, now });
  const machineBlocks = createHomeMachines({ connect, now });
  const scoped = createScopedSlack({ call, registry, identity, origin: connect.accountUrl, decorateHome: (view, link) => addHomeMachines(view, link, machineBlocks) });
  const rate = rateLimiter(now); let closed = false; let processing;
  const jobs = new Set();
  const run = job => { const promise = job.catch(() => {}).finally(() => jobs.delete(promise)); jobs.add(promise); return promise; };
  // An interrupted send is never re-executed after a dyno restart.
  await db.query("UPDATE slack_requests SET state='needs-review',payload='' WHERE state='dispatching'");
  await db.query("UPDATE slack_mcp_requests SET state='needs-review' WHERE state='dispatching'");
  const send = (link, body) => dispatchPlugin({ accountId: link.user_id, serverId: link.server_id, pluginId, payload: envelope(link, registry.key(link), body, now()), timeoutMs: body.kind === 'tool' ? 10_000 : 1800 });
  const taskEndpoint = createTaskEndpoint({ registry, send, rate });
  const startConnection = createSlackOnboarding({ registry, connect });
  const mcp = createSlackbotMcp({ db, registry, identity, signingSecret, send, rate, now, startConnection });
  const refreshLink = link => registry.authenticate(`${link.id}.${registry.key(link)}`);
  async function publishHome(user, text, connectButton = false, link) {
    if (link) {
      try { await refreshLink(link); }
      catch { link = undefined; }
    }
    const blocks = [{ type: 'header', text: { type: 'plain_text', text: link ? 'Zana · Your agents' : 'Zana · Your computer' } }, { type: 'section', text: { type: 'plain_text', text } }];
    if (link) blocks.push({ type: 'actions', elements: [{ type: 'button', action_id: 'connect_home_refresh', text: { type: 'plain_text', text: 'Refresh' } }] }, ...await machineBlocks(link));
    if (connectButton) { const code = await registry.start(user); blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Connect my computer' }, url: `${connect.accountUrl}/connect/?slack=${code}`, action_id: 'connect_account' }] }); }
    await call('views.publish', { user_id: user, view: { type: 'home', blocks } });
  }
  async function explain(payload, user, text, link) {
    if (payload.event?.type === 'app_home_opened' || (payload.type === 'block_actions' && payload.view?.type === 'home' && payload.actions?.[0]?.action_id === 'home_refresh')) return publishHome(user, text, false, link);
    const channel = payload.event?.channel ?? payload.channel?.id ?? payload.channel_id;
    if (/^[CG][A-Z0-9]{5,30}$/.test(channel ?? '')) await call('chat.postEphemeral', { channel, user, text, ...(payload.event?.thread_ts ? { thread_ts: payload.event.thread_ts } : {}) });
  }
  async function execute(id, link, payload) {
    await db.query("UPDATE slack_requests SET state='dispatching' WHERE id=$1", [id]);
    let response;
    try {
      await refreshLink(link);
      const result = await send(link, { kind: 'event', requestId: id, payload });
      if (result.status !== 200 || !result.body?.accepted) throw new SlackError(result.body?.notStarted === true ? 'plugin_unavailable' : 'unconfirmed', 503);
      response = result.body.response ?? {};
      await db.query("UPDATE slack_requests SET state='delivered',response=$1,payload='' WHERE id=$2", [JSON.stringify(response), id]);
      return response;
    } catch (error) {
      const notSent = ['computer_offline', 'plugin_unavailable', 'link_revoked'].includes(error?.message);
      const text = notSent ? offline : uncertain;
      response = payload.type === 'view_submission' ? { response_action: 'update', view: { type: 'modal', title: { type: 'plain_text', text: 'Check Zana' }, close: { type: 'plain_text', text: 'Close' }, blocks: [{ type: 'section', text: { type: 'plain_text', text } }] } } : notice(text);
      await db.query('UPDATE slack_requests SET state=$1,response=$2,payload=\'\' WHERE id=$3', [notSent ? 'not-started' : 'needs-review', JSON.stringify(response), id]);
      if (payload.type === 'event_callback' || payload.type === 'block_actions') await explain(payload, link.slack_user, text, link).catch(() => {});
      return response;
    }
  }
  async function drain() {
    if (closed) return;
    if (processing) return processing;
    processing = (async () => {
      const pending = await db.query("SELECT * FROM slack_requests WHERE state='received' ORDER BY created_at LIMIT 10");
      for (const request of pending) {
        if (closed) break;
        if (now() - Number(request.created_at) > 10_000) { await db.query("UPDATE slack_requests SET state='not-started',payload='' WHERE id=$1", [request.id]); continue; }
        const link = (await db.query('SELECT * FROM slack_links WHERE id=$1', [request.link_id]))[0];
        if (link) await execute(request.id, link, JSON.parse(request.payload));
      }
      await registry.prune();
    })().catch(() => {}).finally(() => { processing = undefined; });
    await processing;
  }
  const timer = setInterval(() => void drain(), intervalMs); timer.unref();
  async function ingest(payload, id) {
    const event = payload.type === 'event_callback';
    const team = event ? payload.team_id : payload.team?.id ?? payload.team_id;
    const user = event ? payload.event?.user ?? payload.event?.assistant_thread?.user_id : payload.user?.id ?? payload.user_id;
    if (team !== identity.team || payload.api_app_id !== identity.app || !/^[UW][A-Z0-9]{5,30}$/.test(user ?? '')) throw new SlackError('wrong_identity', 403);
    // The fallback Home belongs to the gateway, so it has no plugin view token.
    // Re-enter the ordinary owner Home-open path when its Refresh is clicked.
    if (payload.type === 'block_actions' && payload.view?.type === 'home' && payload.actions?.[0]?.action_id === 'connect_home_refresh') return ingest({ type: 'event_callback', team_id: team, api_app_id: identity.app, event: { type: 'app_home_opened', user, tab: 'home' } }, id);
    if (payload.type === 'block_actions' && payload.actions?.[0]?.action_id === 'connect_manage_machines') return {};
    if (event && !['app_mention', 'app_home_opened', 'entity_details_requested', 'message', 'assistant_thread_started', 'assistant_thread_context_changed', 'app_context_changed', 'agent_session_stopped', 'agent_session_title_changed'].includes(payload.event?.type)) return {};
    if (payload.event?.bot_id || payload.event?.subtype) return {};
    const channelReply = event && payload.event.type === 'message' && /^[CG][A-Z0-9]{5,30}$/.test(payload.event.channel ?? '');
    let conversation;
    if (channelReply) {
      const e = payload.event;
      if (e.hidden || !/^\d{10,16}\.\d{6}$/.test(e.ts ?? '') || !/^\d{10,16}\.\d{6}$/.test(e.thread_ts ?? '') || e.ts === e.thread_ts || Math.abs(now() / 1000 - Number(e.ts)) > 300 || typeof e.text !== 'string' || !e.text.trim() || e.text.length > 12000 || e.text.includes(`<@${identity.bot}>`)) return {};
      // Receiving channel messages must not create conversations or capture ambient chat.
      conversation = (await db.query('SELECT link_id FROM slack_conversations WHERE team_id=$1 AND channel=$2 AND root=$3', [identity.team, e.channel, e.thread_ts]))[0];
      if (!conversation) return {};
    }
    rate(`actor:${user}`, 90);
    if (payload.type === 'block_actions' && payload.actions?.[0]?.action_id === 'connect_account') return {};
    // Account setup is handled by the gateway even before a local link exists.
    const setup = payload.command === '/zana' && typeof payload.text === 'string' && /^connect(?:\s+(.*))?$/i.exec(payload.text.trim());
    if (setup) {
      try {
        const connection = await startConnection(user, setup[1]);
        return { ...notice(connection.message), blocks: [
          { type: 'section', text: { type: 'plain_text', text: connection.domain ? `Connect your Slack identity to ${connection.domain}. ${connection.message}` : connection.message } },
          { type: 'actions', elements: [{ type: 'button', action_id: 'connect_account', text: { type: 'plain_text', text: 'Connect my Zana' }, url: connection.connect_url }] },
        ] };
      } catch (error) {
        if (error?.message === 'invalid_domain') return notice(`Use /zana connect my-domain.${connect.browserDomain} with your own Zana address.`);
        throw error;
      }
    }
    const link = await registry.owner(user);
    if (!link) {
      if (channelReply) return {};
      if (jobs.size >= 20) throw new SlackError('busy', 503);
      run(publishHome(user, `Link your Slack identity to your Zana account, choose your domain or computer, then approve access in its Zana for Slack plugin. You can also use /zana connect my-domain.${connect.browserDomain}.`, true));
      if (event && payload.event.type !== 'app_home_opened') run(explain(payload, user, 'Open Zana → Home in Slack and choose Connect my computer.'));
      return notice('Open Zana → Home in Slack and choose Connect my computer.');
    }
    // Slash commands can start in the owner's Zana DM before a message event
    // registered it. Other users' DMs and group DMs are never destinations.
    if (payload.command === '/zana' && /^D[A-Z0-9]{5,30}$/.test(payload.channel_id ?? '')) {
      const info = await call('conversations.info', { channel: payload.channel_id });
      const dm = info.channel;
      if (!info.ok || dm?.id !== payload.channel_id || dm.user !== user || dm.is_im !== true || dm.is_mpim || dm.is_archived) throw new SlackError('channel_not_owned', 403);
      await registry.remember(link, `${link.id}:${payload.channel_id}`, 'agent-dm', 90 * 86400_000);
    }
    if (event && payload.event.type === 'entity_details_requested') {
      const e = payload.event;
      if (!taskId(e.external_ref?.id) || e.external_ref.type !== 'zana_task' || e.entity_url !== `${taskBase(connect.accountUrl, link)}/tasks/${e.external_ref.id}` || typeof e.trigger_id !== 'string' || !e.trigger_id || e.trigger_id.length > 256) throw new SlackError('invalid_entity');
      await registry.object(link, e.external_ref.id, 'entity');
      await registry.remember(link, taskTrigger(e.trigger_id), 'entity-trigger', 60_000);
      await registry.remember(link, taskTrigger(e.trigger_id, e.external_ref.id), 'entity-trigger', 60_000);
    }
    if (event && payload.event.type === 'app_mention') {
      const e = payload.event;
      if (!/^[CG][A-Z0-9]{5,30}$/.test(e.channel ?? '') || !/^\d{10,16}\.\d{6}$/.test(e.ts ?? '') || typeof e.text !== 'string' || !e.text.includes(`<@${identity.bot}>`) || Math.abs(now() / 1000 - Number(e.ts)) > 300) return {};
      if (e.thread_ts !== undefined && !/^\d{10,16}\.\d{6}$/.test(e.thread_ts)) return {};
      // A fresh mention can start in an ordinary existing thread. bind preserves
      // an existing owner's claim and rejects attempts to take over their job.
      await registry.bind(link, e.channel, e.thread_ts || e.ts);
    }
    if (channelReply) {
      if (conversation.link_id !== link.id) return {};
      const info = await call('conversations.info', { channel: payload.event.channel });
      const c = info.channel;
      if (!info.ok || c?.id !== payload.event.channel || c.is_member !== true || c.is_archived !== false || c.is_shared !== false || c.is_ext_shared !== false || c.is_org_shared !== false || c.is_im || c.is_mpim) return {};
      await registry.conversation(link, payload.event.channel, payload.event.thread_ts);
    }
    if (!channelReply && event && ['message', 'assistant_thread_started', 'assistant_thread_context_changed', 'agent_session_stopped', 'agent_session_title_changed'].includes(payload.event.type)) {
      const e = payload.event, thread = e.assistant_thread;
      const channel = e.channel ?? thread?.channel_id, root = e.thread_ts ?? thread?.thread_ts ?? e.ts;
      const ts = e.ts ?? e.event_ts ?? root;
      if (!/^D[A-Z0-9]{5,30}$/.test(channel ?? '') || !/^\d{10,16}\.\d{6}$/.test(root ?? '') || !/^\d{10,16}\.\d{6}$/.test(ts ?? '') || Math.abs(now() / 1000 - Number(ts)) > 300 || (e.type === 'message' && (typeof e.text !== 'string' || !e.text.trim() || e.text.length > 12000))) return {};
      const info = await call('conversations.info', { channel });
      const dm = info.channel;
      if (!info.ok || dm?.id !== channel || dm.user !== user || dm.is_im !== true || dm.is_mpim || dm.is_archived) throw new SlackError('channel_not_owned', 403);
      if (['agent_session_stopped', 'agent_session_title_changed', 'assistant_thread_context_changed'].includes(e.type)) await registry.conversation(link, channel, root);
      else await registry.bind(link, channel, root);
      await registry.remember(link, `${link.id}:${channel}`, 'agent-dm', 90 * 86400_000);
    }
    if (payload.view?.id) await registry.object(link, payload.view.id, 'view');
    if (payload.container?.message_ts) {
      const root = payload.message?.thread_ts ?? payload.container.message_ts;
      await registry.conversation(link, payload.container.channel_id, root);
    }
    if (payload.trigger_id) await registry.remember(link, payload.trigger_id, 'trigger', 3000);
    const saved = await db.transaction(`slack-request:${id}`, async query => {
      const old = (await query('SELECT * FROM slack_requests WHERE id=$1', [id]))[0];
      if (old) return old;
      if (Number((await query('SELECT COUNT(*) AS n FROM slack_requests WHERE link_id=$1', [link.id]))[0].n) >= 2000) throw new SlackError('busy', 429);
      await query('INSERT INTO slack_requests(id,link_id,state,payload,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [id, link.id, event ? 'received' : 'dispatching', JSON.stringify(payload), now(), now() + 86400_000]);
      return null;
    });
    if (saved) return saved.response ? JSON.parse(saved.response) : (event ? {} : notice(uncertain));
    if (event) { void drain(); return {}; }
    if (jobs.size >= 20) { await db.query("UPDATE slack_requests SET state='not-started',payload='' WHERE id=$1", [id]); return notice('Zana is busy. Try again shortly.'); }
    const work = execute(id, link, payload); run(work); return work;
  }
  async function dispatch(request, clientKey = 'unknown') {
    try {
      if (closed || new URL(request.url).origin !== connect.accountUrl) throw new SlackError('service_unavailable', 503);
      const path = new URL(request.url).pathname.replace(/\/$/, '');
      if (path.startsWith('/api/slack/tasks/')) { const work = taskEndpoint(request, clientKey); run(work); return await work; }
      if (path === '/api/slack/mcp') { const work = mcp(request, clientKey); run(work); return await work; }
      if (path === '/api/slack/events' && request.method === 'POST') {
        rate(`ingress:${clientKey}`, 300);
        const raw = await readBody(request);
        if (!verifiedSlack(raw, request.headers, signingSecret, now())) throw new SlackError('invalid_signature', 401);
        let payload;
        const type = request.headers.get('content-type')?.split(';')[0];
        try { payload = type === 'application/json' ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw.toString())); if (payload.payload) payload = JSON.parse(payload.payload); }
        catch { throw new SlackError('invalid_payload'); }
        if (payload.type === 'url_verification') { if (typeof payload.challenge !== 'string' || payload.challenge.length > 300) throw new SlackError('invalid_challenge'); return json({ challenge: payload.challenge }); }
        const id = payload.event_id ? hash(`${identity.team}:${payload.event_id}`) : hash(raw);
        return json(await ingest(payload, id));
      }
      if (!path.startsWith('/api/connect/slack/')) throw new SlackError('not_found', 404);
      const origin = request.headers.get('origin');
      if (origin && origin !== connect.accountUrl) throw new SlackError('untrusted_origin', 403);
      if (path.endsWith('/redeem') && request.method === 'POST') { rate(`redeem:${clientKey}`, 10); return json(await registry.redeem((await readJson(request)).code)); }
      if (['/activate', '/call', '/unlink', '/status'].some(s => path.endsWith(s)) && request.method === 'POST') {
        const link = await registry.authenticate(bearer(request), path.endsWith('/activate'));
        rate(`link:${link.id}`, 240);
        if (path.endsWith('/activate')) {
          if (link.state === 'active') return json({ active: true });
          const result = await send(link, { kind: 'probe' });
          if (result.status !== 200 || result.body?.linkId !== link.id) throw new SlackError('open_chosen_computer', 409);
          return json(await registry.activate(link));
        }
        if (path.endsWith('/status')) return json({ active: true, computer: link.computer });
        if (path.endsWith('/unlink')) return json(await registry.revoke(link.id, link.user_id));
        const input = JSON.parse((await readBody(request)).toString());
        return json(await scoped.proxy(link, input.method, input.args ?? {}));
      }
      const user = await browserAccount(db, request.headers.get('cookie'), sessionSecret, now());
      if (!user) throw new SlackError('sign_in_required', 401);
      if (request.method !== 'GET' && origin !== connect.accountUrl) throw new SlackError('untrusted_origin', 403);
      rate(`account:${user.id}`, 60);
      if (path.endsWith('/info') && request.method === 'GET') {
        const info = await registry.info(new URL(request.url).searchParams.get('code'));
        let target;
        if (info.domain) {
          target = (await connect.listServers(user.id)).find(s => s.address === info.domain && !s.revoked && s.paired);
          if (!target) throw new SlackError('domain_not_owned', 403);
        }
        const member = await call('users.info', { user: info.slack_user });
        return json({ team: identity.teamName ?? identity.team, user: member.user?.real_name ?? info.slack_user, userId: info.slack_user, ...(target ? { domain: new URL(target.browserUrl).host, serverId: target.id } : {}) });
      }
      if (path.endsWith('/links') && request.method === 'GET') {
        const links = await registry.list(user.id);
        return json({ links: links.map(link => ({ ...link, team_name: link.team_id === identity.team ? identity.teamName ?? null : null })) });
      }
      if (path.endsWith('/approve') && request.method === 'POST') {
        const input = await readJson(request);
        if (input.approved !== true || typeof input.serverId !== 'string' || input.serverId.length > 100) throw new SlackError('approval_required');
        return json(await registry.approve(user.id, input.code, input.serverId));
      }
      if (path.endsWith('/revoke') && request.method === 'POST') return json(await registry.revoke((await readJson(request)).id, user.id));
      throw new SlackError('not_found', 404);
    } catch (error) { return json({ error: error instanceof SlackError ? error.message : 'slack_unavailable' }, error instanceof SlackError ? error.status : 503); }
  }
  return { dispatch, registry, drain, async close() { closed = true; clearInterval(timer); await processing; await Promise.allSettled([...jobs]); } };
}
