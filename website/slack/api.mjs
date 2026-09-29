import { SlackError } from './security.mjs';

const channelId = value => typeof value === 'string' && /^[CG][A-Z0-9]{5,30}$/.test(value);
const timestamp = value => typeof value === 'string' && /^\d{10,16}\.\d{6}$/.test(value);
export const internalChannel = c => c && channelId(c.id) && c.is_member === true && c.is_archived === false && c.is_shared === false && c.is_ext_shared === false && c.is_org_shared === false && !c.is_im && !c.is_mpim;

/** Fixed Slack origin, no redirects, no retries of writes, bounded bodies. */
export function slackClient(botToken, fetcher = fetch) {
  return async (method, args = {}) => {
    if (!/^[a-z]+\.[a-zA-Z]+$/.test(method)) throw new SlackError('invalid_method');
    const body = JSON.stringify(args);
    if (Buffer.byteLength(body) > 256 * 1024) throw new SlackError('body_too_large', 413);
    const response = await fetcher(`https://slack.com/api/${method}`, { method: 'POST', headers: { authorization: `Bearer ${botToken}`, 'content-type': 'application/json' }, body, redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok) { await response.body?.cancel(); throw new SlackError(response.status === 429 ? 'slack_rate_limited' : 'slack_unavailable', 503); }
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 256 * 1024) { await reader.cancel(); throw new SlackError('slack_response_too_large', 503); } chunks.push(value); }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!result.ok) return { ok: false, error: /^[a-z_]{1,80}$/.test(result.error) ? result.error : 'slack_error' };
      return result;
    } finally { reader.releaseLock(); }
  };
}

export function createScopedSlack({ call, registry, identity }) {
  async function memberChannels(link) {
    const ids = new Set(); let cursor;
    for (let page = 0; page < 5; page++) {
      const value = await call('users.conversations', { user: link.slack_user, types: 'public_channel,private_channel', exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}) });
      if (!value.ok) throw new SlackError('cannot_verify_membership', 503);
      for (const c of value.channels ?? []) if (channelId(c.id)) ids.add(c.id);
      cursor = value.response_metadata?.next_cursor;
      if (!cursor) break;
    }
    return ids;
  }
  async function channel(link, id) {
    if (!channelId(id)) throw new SlackError('invalid_channel');
    if (!(await memberChannels(link)).has(id)) throw new SlackError('channel_not_owned', 403);
    const value = await call('conversations.info', { channel: id });
    if (!value.ok || !internalChannel(value.channel)) throw new SlackError('channel_not_allowed', 403);
    return value;
  }
  async function proxy(link, method, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SlackError('invalid_arguments');
    if (method === 'auth.test') return { ok: true, team_id: identity.team, user_id: identity.bot, bot_id: identity.bot, team: identity.teamName };
    if (method === 'users.info') {
      if (input.user !== link.slack_user) throw new SlackError('user_not_owned', 403);
      return call(method, { user: link.slack_user });
    }
    if (method === 'conversations.info') return channel(link, input.channel);
    if (method === 'conversations.list') {
      const memberships = await memberChannels(link);
      const value = await call(method, { types: 'public_channel,private_channel', exclude_archived: true, limit: 200, ...(typeof input.cursor === 'string' && input.cursor.length < 500 ? { cursor: input.cursor } : {}) });
      return { ok: value.ok, channels: (value.channels ?? []).filter(c => memberships.has(c.id) && internalChannel(c)), response_metadata: value.response_metadata };
    }
    if (method === 'views.publish') {
      if (input.user_id !== link.slack_user || input.view?.type !== 'home') throw new SlackError('user_not_owned', 403);
      const value = await call(method, { user_id: link.slack_user, view: input.view });
      if (value.ok && value.view?.id) await registry.remember(link, value.view.id, 'view', 30 * 86400_000);
      return value;
    }
    if (['views.open', 'views.push', 'views.update'].includes(method)) {
      if (input.view?.type !== 'modal') throw new SlackError('invalid_view');
      const args = { view: input.view };
      if (method === 'views.update') { await registry.object(link, input.view_id, 'view'); args.view_id = input.view_id; if (typeof input.hash === 'string') args.hash = input.hash; }
      else { await registry.object(link, input.trigger_id, 'trigger'); args.trigger_id = input.trigger_id; }
      const value = await call(method, args);
      if (value.ok && value.view?.id) await registry.remember(link, value.view.id, 'view');
      return value;
    }
    if (!['chat.postMessage', 'chat.update', 'chat.getPermalink'].includes(method)) throw new SlackError('method_not_allowed', 403);
    await channel(link, input.channel);
    if (method === 'chat.getPermalink') {
      if (!timestamp(input.message_ts)) throw new SlackError('invalid_timestamp');
      await registry.conversation(link, input.channel, input.message_ts);
      return call(method, { channel: input.channel, message_ts: input.message_ts });
    }
    const args = { channel: input.channel, text: input.text, blocks: input.blocks, mrkdwn: false, parse: 'none', unfurl_links: false, unfurl_media: false };
    if (method === 'chat.update') { await registry.object(link, `${input.channel}:${input.ts}`, 'message'); args.ts = input.ts; }
    if (input.thread_ts) { if (!timestamp(input.thread_ts)) throw new SlackError('invalid_timestamp'); await registry.conversation(link, input.channel, input.thread_ts); args.thread_ts = input.thread_ts; }
    const value = await call(method, args);
    if (value.ok && timestamp(value.ts)) {
      await registry.remember(link, `${input.channel}:${value.ts}`, 'message', 90 * 86400_000);
      if (method === 'chat.postMessage' && !input.thread_ts) await registry.bind(link, input.channel, value.ts);
    }
    return value;
  }
  return { proxy, channel };
}
