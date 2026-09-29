import { openConnectDatabase } from './database.mjs';
import { createRegistry } from './registry.mjs';
import { createConnectGateway } from './gateway.mjs';
import { createConnectApi, json } from './http.mjs';
import { Readable } from 'node:stream';
import { createSlackService } from '../slack/service.mjs';
import { slackClient } from '../slack/api.mjs';

async function dependencies(env) {
  if (!env.CONNECT_DOMAIN || !env.PUBLIC_BASE_URL || !env.SESSION_SECRET) throw new Error('Set CONNECT_DOMAIN, PUBLIC_BASE_URL and SESSION_SECRET for Zana Connect');
  const db = await openConnectDatabase(env.DATABASE_URL, { production: env.NODE_ENV === 'production' });
  try {
    await db.migrate();
    const registry = createRegistry(db, { domain: env.CONNECT_DOMAIN, browserDomain: env.CONNECT_BROWSER_DOMAIN || env.CONNECT_DOMAIN, accountUrl: env.PUBLIC_BASE_URL, allowLocal: env.NODE_ENV !== 'production' });
    return { db, registry, sessionSecret: env.SESSION_SECRET, allowLocal: env.NODE_ENV !== 'production' };
  } catch (error) { await db.close(); throw error; }
}

export async function createHostedConnect(env) {
  if (!env.CONNECT_DOMAIN) return null;
  const deps = await dependencies(env);
  const gateway = createConnectGateway(deps);
  let slack;
  const account = new URL(deps.registry.accountUrl);
  const slackPath = req => req.headers.host === account.host && /^\/(?:api\/slack\/events|api\/connect\/slack\/)/.test(req.url ?? '');
  try {
    // Registration owns the concrete plugin id; the tunnel remains generic.
    if (env.SLACK_BOT_TOKEN && env.SLACK_SIGNING_SECRET && env.SLACK_APP_ID && env.SLACK_TEAM_ID) {
      const call = slackClient(env.SLACK_BOT_TOKEN);
      const auth = await call('auth.test');
      if (!auth.ok || auth.team_id !== env.SLACK_TEAM_ID || !auth.bot_id || !/^[UW][A-Z0-9]{5,30}$/.test(auth.user_id)) throw new Error('Slack bot installation does not match configured workspace');
      slack = await createSlackService({ ...deps, connect: deps.registry, dispatchPlugin: gateway.dispatchPlugin, pluginId: 'slack-bridge-2ff2', signingSecret: env.SLACK_SIGNING_SECRET, identity: { app: env.SLACK_APP_ID, team: auth.team_id, bot: auth.user_id, teamName: auth.team }, call });
    }
  } catch {
    // A Slack outage must not prevent mobile connections from starting.
    console.error('Slack integration unavailable. Check its configuration and restart the service.');
  }
  return {
    ...gateway,
    matches: req => slackPath(req) || gateway.matches(req),
    async handleHttp(req, res) {
      if (!slackPath(req)) return gateway.handleHttp(req, res);
      let response;
      try {
        if (!deps.allowLocal && req.headers['x-forwarded-proto'] !== 'https') response = json({ error: 'https_required' }, 403);
        else if (!slack) response = json({ error: 'slack_not_configured' }, 503);
        else {
          const request = new Request(`${account.origin}${req.url}`, { method: req.method, headers: req.headers, ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}) });
          response = await slack.dispatch(request, String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',').at(-1).trim().slice(0, 100));
        }
      } catch { response = json({ error: 'slack_unavailable' }, 503); }
      if (!res.destroyed) { res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer())); }
    },
    async close() { await slack?.close(); await gateway.close(); await deps.db.close(); }
  };
}

// Next dev can serve the account UI/API without the front door; tunnel traffic
// still requires the front door. Production routes are handled by that process.
let api;
export async function handleConnectApi(request) {
  if (!process.env.CONNECT_DOMAIN) return json({ error: 'connect_not_configured' }, 503);
  try {
    api ??= dependencies(process.env).then(deps => createConnectApi(deps)).catch(error => { api = undefined; throw error; });
    return (await api).dispatch(request);
  } catch { return json({ error: 'connect_unavailable' }, 503); }
}
