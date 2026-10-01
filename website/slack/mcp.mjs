import { hash, readBody, SlackError, verifiedSlack } from './security.mjs';
import { json } from '../connect/http.mjs';

import catalog from './capabilities.json' with { type: 'json' };
export const slackbotTools = catalog.tools;
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.isError ? { isError: true } : {}) });
const failure = (error, message, extra = {}) => result({ isError: true, error, message, ...extra });
const uncertain = jobId => failure('needs_review', 'Delivery is unconfirmed. Inspect Zana for Slack diagnostics on your computer before launching again. Do not use a new request_id to retry.', { job_id: jobId });
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const versions = ['2025-03-26', '2025-06-18', '2025-11-25'];
function argumentsFor(tool, value) {
  const args = value ?? {};
  if (!object(args) || Object.keys(args).some(k => !Object.hasOwn(tool.inputSchema.properties, k))) throw new SlackError('invalid_arguments');
  for (const key of tool.inputSchema.required) if (!Object.hasOwn(args, key)) throw new SlackError('invalid_arguments');
  for (const [key, input] of Object.entries(args)) {
    const rule = tool.inputSchema.properties[key];
    if (typeof input !== 'string' || !input.trim() || input.length > (rule.maxLength ?? 100) || (rule.pattern && !new RegExp(rule.pattern).test(input))) throw new SlackError('invalid_arguments');
  }
  // Normalize key order too: JSON object order is not part of request identity.
  return Object.fromEntries(Object.keys(tool.inputSchema.properties).filter(key => Object.hasOwn(args, key)).map(key => [key, args[key].trim()]));
}

/** Stateless Streamable HTTP: each signed POST yields one JSON-RPC response.
 * No session ID is an authorization credential; every tool call resolves its signed caller again.
 */
export function createSlackbotMcp({ db, registry, identity, signingSecret, send, rate, now = Date.now, startConnection }) {
  let active = 0;
  async function invoke(name, args, caller) {
    if (!object(caller) || caller.team_id !== identity.team || !/^[UW][A-Z0-9]{5,30}$/.test(caller.user_id ?? '')) return failure('wrong_identity', 'A verified user in the configured Slack workspace is required. Enterprise calls must resolve to this workspace.');
    rate(`mcp-user:${caller.user_id}`, 60);
    if (name === 'zana_connect') {
      try { return result(await startConnection(caller.user_id, args.domain)); }
      catch (error) {
        if (error?.message === 'invalid_domain') return failure('invalid_domain', 'Use your own Zana domain or its label, without a path, query, credentials, or external hostname.');
        throw error;
      }
    }
    const link = await registry.owner(caller.user_id);
    if (!link) return failure('not_connected', 'Ask to connect your Zana domain with zana_connect, or open Zana → Home in Slack and connect your computer before using jobs.');
    if (active >= 20) return failure('busy', 'Zana is busy. Try again shortly with the same request_id.');
    active++;
    try {
      const jobId = name === 'zana_launch_job' ? hash(`slackbot:${link.id}:${args.request_id}`) : args.job_id;
      if (name === 'zana_job_status') {
        const saved = (await db.query('SELECT * FROM slack_mcp_requests WHERE id=$1 AND link_id=$2', [jobId, link.id]))[0];
        if (!saved) return failure('job_not_found', 'No job with that ID belongs to your current computer link.');
        if (saved.state === 'not-started') return JSON.parse(saved.response);
        // A read may recover the locally persisted acceptance after an interrupted response.
      }
      if (name === 'zana_launch_job') {
        const digest = hash(JSON.stringify(args));
        const saved = await db.transaction(`slack-mcp:${link.id}`, async query => {
          const old = (await query('SELECT * FROM slack_mcp_requests WHERE id=$1', [jobId]))[0];
          if (old) return old;
          if (Number((await query('SELECT COUNT(*) AS n FROM slack_mcp_requests WHERE link_id=$1', [link.id]))[0].n) >= 2000) throw new SlackError('busy', 429);
          await query('INSERT INTO slack_mcp_requests(id,link_id,payload_hash,state,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [jobId, link.id, digest, 'dispatching', now(), now() + 30 * 86400_000]);
          return null;
        });
        if (saved) return saved.payload_hash !== digest ? failure('request_conflict', 'This request_id already belongs to another task. Do not change its arguments on retry.') : saved.response ? JSON.parse(saved.response) : uncertain(jobId);
      }
      let response, state = 'delivered';
      try {
        await registry.authenticate(`${link.id}.${registry.key(link)}`);
        const received = await send(link, { kind: 'tool', team: identity.team, app: identity.app, user: link.slack_user, name, arguments: args, requestId: jobId });
        if (received.status !== 200 || received.body?.accepted !== true || !object(received.body.response)) throw new SlackError(received.body?.notStarted === true ? 'plugin_unavailable' : 'unconfirmed', 503);
        response = result(received.body.response);
      } catch (error) {
        const notSent = ['computer_offline', 'plugin_unavailable', 'link_revoked'].includes(error?.message);
        state = notSent ? 'not-started' : 'needs-review';
        response = name === 'zana_import_project'
          ? failure('import_unconfirmed', 'The import response is unavailable. Check zana_list_projects for the destination or inspect Zana for Slack before retrying. No job was launched.')
          : name !== 'zana_launch_job'
          ? failure('status_unavailable', 'Your computer or plugin could not return current data. This does not establish whether an earlier job is running. Check Zana; do not launch a replacement.', { ...(jobId ? { job_id: jobId } : {}) })
          : notSent ? failure('not_started', 'Your computer or plugin is unavailable. This request was not started. Open Zana and check the connection.', { job_id: jobId }) : uncertain(jobId);
      }
      if (name === 'zana_launch_job') await db.query('UPDATE slack_mcp_requests SET state=$1,response=$2 WHERE id=$3', [state, JSON.stringify(response), jobId]);
      return response;
    } finally { active--; }
  }
  return async (request, clientKey) => {
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin) throw new SlackError('untrusted_origin', 403);
    const version = request.headers.get('mcp-protocol-version');
    if (version && !versions.includes(version)) throw new SlackError('unsupported_protocol');
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    rate(`mcp-ingress:${clientKey}`, 300);
    const raw = await readBody(request);
    if (!verifiedSlack(raw, request.headers, signingSecret, now())) throw new SlackError('invalid_signature', 401);
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return json({ error: 'unsupported_media_type' }, 415);
    let rpc;
    try { rpc = JSON.parse(raw); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const validId = typeof rpc?.id === 'string' && rpc.id.length <= 200 || typeof rpc?.id === 'number' && Number.isSafeInteger(rpc.id);
    const reply = value => json({ jsonrpc: '2.0', id: validId ? rpc.id : null, ...value });
    const error = (code, message) => reply({ error: { code, message } });
    if (!object(rpc) || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string' || (rpc.params !== undefined && !object(rpc.params))) return error(-32600, 'Invalid Request');
    if (!Object.hasOwn(rpc, 'id')) return new Response(null, { status: 202 });
    if (!validId) return error(-32600, 'Invalid Request');
    const params = rpc.params ?? {};
    if (rpc.method === 'initialize') return reply({ result: { protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'zana-slackbot', version: '0.11.0' }, instructions: 'Use zana_connect when the user asks to connect their Zana domain. They must complete account and local approval before using jobs. List Projects first. Import only the Project the user requests, using zana_import_project. Discover locally enabled plugin tools with zana_list_capabilities. Jobs run asynchronously. Reuse request_id on retry and use zana_job_status for progress; never turn an uncertain response into a fresh launch.' } });
    if (rpc.method === 'ping') return reply({ result: {} });
    if (rpc.method === 'tools/list') return reply({ result: { tools: slackbotTools } });
    if (rpc.method !== 'tools/call') return error(-32601, 'Method not found');
    const tool = slackbotTools.find(t => t.name === params.name);
    if (!tool) return error(-32602, 'Unknown tool');
    let args;
    try { args = argumentsFor(tool, params.arguments); } catch { return error(-32602, 'Invalid tool arguments'); }
    return reply({ result: await invoke(tool.name, args, params._meta?.slack) });
  };
}
