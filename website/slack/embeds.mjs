import { hash, SlackError } from './security.mjs';

export const taskId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const taskBase = (origin, link) => `${origin}/api/slack/tasks/${link.id}`;
export const taskTrigger = (trigger, entity = '') => hash(`${trigger}:${entity}`);

/** Reconstruct a single owned task entity. No arbitrary links, embeds or payload fields. */
export function taskEntity(input, origin, link, preview = false) {
  const id = input?.external_ref?.id;
  const base = taskBase(origin, link);
  const a = input?.entity_payload?.attributes;
  if (!taskId(id) || input.external_ref.type !== 'zana_task' || input.entity_type !== 'slack#/entities/file' || input.url !== `${base}/tasks/${id}` || typeof a?.title?.text !== 'string' || !a.title.text || a.title.text.length > 120 || !Number.isSafeInteger(a.metadata_last_modified)) throw new SlackError('invalid_metadata');
  const full = a.full_size_preview;
  if (full?.is_supported !== true || full.mime_type !== 'application/vnd.slack-embed') throw new SlackError('invalid_metadata');
  if (preview && (typeof full.preview_url !== 'string' || !full.preview_url.startsWith(`${base}/view/${id}#key=`) || !/^[A-Za-z0-9_-]{43}$/.test(full.preview_url.slice(`${base}/view/${id}#key=`.length)))) throw new SlackError('invalid_metadata');
  if (!preview && full.preview_url !== undefined) throw new SlackError('invalid_metadata');
  return { url: input.url, external_ref: { id, type: 'zana_task' }, entity_type: 'slack#/entities/file', entity_payload: { attributes: { title: { text: a.title.text }, product_name: 'Zana', display_type: 'Agent task', metadata_last_modified: a.metadata_last_modified, full_size_preview: { is_supported: true, mime_type: 'application/vnd.slack-embed', ...(preview ? { preview_url: full.preview_url } : {}) } }, fields: {} } };
}

const headers = {
  'Cache-Control': 'no-store, private', 'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Accept',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors https://*.slack.com https://*.slack-gov.com https://*.slack-mcps.com",
};
/** The public surface forwards only page/data reads to the linked plugin, never product HTTP. */
export function createTaskEndpoint({ registry, send, rate }) {
  let inflight = 0;
  return async (request, clientKey) => {
    try {
      const url = new URL(request.url), match = url.pathname.match(/^\/api\/slack\/tasks\/([0-9a-f-]{36})\/(view|data|tasks)\/([0-9a-f-]{36})\/?$/);
      if (!match || !taskId(match[1]) || !taskId(match[3]) || url.search || url.hash) throw new SlackError('not_found', 404);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      if (request.method !== 'GET') throw new SlackError('read_only', 405);
      rate(`panel-client:${clientKey}`, 180);
      if (inflight >= 20) throw new SlackError('busy', 503);
      if (match[2] === 'tasks') return new Response('Open this task from its Zana card in Slack.', { headers });
      const action = match[2] === 'view' ? 'page' : 'data';
      const key = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      if (action === 'data' && !key) throw new SlackError('reopen_task_in_slack', 403);
      inflight++;
      try {
        const link = await registry.activeById(match[1]);
        await registry.object(link, match[3], 'entity');
        rate(`panel:${link.id}`, 180);
        const result = await send(link, { kind: 'embed', team: link.team_id, app: link.app_id, user: link.slack_user, action, entityId: match[3], ...(key ? { key } : {}) });
        await registry.activeById(link.id);
        const response = result.body?.response;
        if (result.status !== 200 || !result.body?.accepted || ![200, 403, 410].includes(response?.status) || typeof response.body !== 'string' || Buffer.byteLength(response.body) > 64 * 1024) throw new SlackError('computer_unavailable', 503);
        const type = response.headers?.['Content-Type'], csp = response.headers?.['Content-Security-Policy'];
        if (!['text/plain; charset=utf-8', 'text/html; charset=utf-8', 'application/json; charset=utf-8'].includes(type) || typeof csp !== 'string' || csp.length > 2000 || /[\r\n]/.test(csp)) throw new SlackError('invalid_panel_response', 503);
        // Desktop plugins are not trusted to choose policy for the account website's origin.
        // A separate, intersecting policy enforces an opaque origin even in a top-level tab.
        // Only this task's bearer endpoint can be fetched; account APIs are never reachable.
        const isolation = `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src ${url.origin}/api/slack/tasks/${link.id}/data/${match[3]}; base-uri 'none'; form-action 'none'; frame-ancestors https://*.slack.com https://*.slack-gov.com https://*.slack-mcps.com`;
        return new Response(response.body, { status: response.status, headers: { ...headers, 'Content-Type': type, 'Content-Security-Policy': `${isolation}, ${csp}` } });
      } finally { inflight--; }
    } catch (error) {
      return new Response(error instanceof SlackError ? error.message : 'computer_unavailable', { status: error instanceof SlackError ? error.status : 503, headers });
    }
  };
}
