import { taskEntity, taskTrigger } from "./embeds.mjs";
import { SlackError } from "./security.mjs";

const channelId = (value) =>
  typeof value === "string" && /^[CG][A-Z0-9]{5,30}$/.test(value);
const timestamp = (value) =>
  typeof value === "string" && /^\d{10,16}\.\d{6}$/.test(value);
const formMethods = new Set([
  "auth.test",
  "users.info",
  "users.conversations",
  "conversations.info",
  "conversations.list",
  "chat.getPermalink",
]);
const managedChannelName = (value) =>
  typeof value === "string" &&
  value.length <= 80 &&
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-)?zana-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(
    value,
  );
export const internalChannel = (c) =>
  c &&
  channelId(c.id) &&
  c.is_member === true &&
  c.is_archived === false &&
  c.is_shared === false &&
  c.is_ext_shared === false &&
  c.is_org_shared === false &&
  !c.is_im &&
  !c.is_mpim;

/** Fixed Slack origin, no redirects, no retries of writes, bounded bodies. */
export function slackClient(botToken, fetcher = fetch) {
  return async (method, args = {}) => {
    if (!/^[a-z]+\.[a-zA-Z]+$/.test(method))
      throw new SlackError("invalid_method");
    // Slack's simple read methods ignore or reject their arguments when this
    // workspace receives them as JSON. Keep writes on JSON because views and
    // message blocks need structured payloads.
    const formEncoded = formMethods.has(method);
    const body = formEncoded
      ? new URLSearchParams(
          Object.entries(args).map(([key, value]) => [key, String(value)]),
        ).toString()
      : JSON.stringify(args);
    if (Buffer.byteLength(body) > 256 * 1024)
      throw new SlackError("body_too_large", 413);
    const response = await fetcher(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${botToken}`,
        "content-type": formEncoded
          ? "application/x-www-form-urlencoded"
          : "application/json",
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new SlackError(
        response.status === 429 ? "slack_rate_limited" : "slack_unavailable",
        503,
      );
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 256 * 1024) {
          await reader.cancel();
          throw new SlackError("slack_response_too_large", 503);
        }
        chunks.push(value);
      }
      const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!result.ok)
        return {
          ok: false,
          error: /^[a-z_]{1,80}$/.test(result.error)
            ? result.error
            : "slack_error",
        };
      return result;
    } finally {
      reader.releaseLock();
    }
  };
}

export function createScopedSlack({ call, registry, identity, origin }) {
  async function memberChannels(link) {
    const ids = new Set();
    let cursor;
    for (let page = 0; page < 5; page++) {
      const value = await call("users.conversations", {
        user: link.slack_user,
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      if (!value.ok) throw new SlackError("cannot_verify_membership", 503);
      for (const c of value.channels ?? []) if (channelId(c.id)) ids.add(c.id);
      cursor = value.response_metadata?.next_cursor;
      if (!cursor) break;
    }
    return ids;
  }
  async function channel(link, id) {
    if (!channelId(id)) throw new SlackError("invalid_channel");
    if (!(await memberChannels(link)).has(id))
      throw new SlackError("channel_not_owned", 403);
    const value = await call("conversations.info", { channel: id });
    if (!value.ok || !internalChannel(value.channel))
      throw new SlackError("channel_not_allowed", 403);
    return value;
  }
  async function proxy(link, method, input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new SlackError("invalid_arguments");
    if (method === "auth.test")
      return {
        ok: true,
        team_id: identity.team,
        user_id: identity.bot,
        bot_id: identity.bot,
        team: identity.teamName,
      };
    if (method === "users.info") {
      if (input.user !== link.slack_user)
        throw new SlackError("user_not_owned", 403);
      return call(method, { user: link.slack_user });
    }
    if (method === "conversations.create") {
      if (input.is_private !== true || !managedChannelName(input.name))
        throw new SlackError("channel_not_allowed", 403);
      if ((await registry.count(link, "project-channel")) >= 250)
        throw new SlackError("project_channel_limit", 429);
      const value = await call(method, { name: input.name, is_private: true });
      if (value.ok && channelId(value.channel?.id)) {
        await registry.remember(
          link,
          value.channel.id,
          "project-channel",
          365 * 86400_000,
        );
        return {
          ok: true,
          channel: {
            id: value.channel.id,
            name: String(value.channel.name || input.name).slice(0, 80),
          },
        };
      }
      return value;
    }
    if (method === "conversations.invite") {
      if (!channelId(input.channel) || input.users !== link.slack_user)
        throw new SlackError("channel_not_allowed", 403);
      await registry.object(link, input.channel, "project-channel");
      return call(method, { channel: input.channel, users: link.slack_user });
    }
    if (method === "conversations.rename") {
      if (!channelId(input.channel) || !managedChannelName(input.name))
        throw new SlackError("channel_not_allowed", 403);
      await registry.object(link, input.channel, "project-channel");
      const value = await call(method, {
        channel: input.channel,
        name: input.name,
      });
      if (value.ok && value.channel?.id === input.channel)
        return {
          ok: true,
          channel: {
            id: value.channel.id,
            name: String(value.channel.name || input.name).slice(0, 80),
          },
        };
      return value;
    }
    if (method === "conversations.info") return channel(link, input.channel);
    if (method === "conversations.list") {
      const memberships = await memberChannels(link);
      const value = await call(method, {
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        ...(typeof input.cursor === "string" && input.cursor.length < 500
          ? { cursor: input.cursor }
          : {}),
      });
      return {
        ok: value.ok,
        channels: (value.channels ?? []).filter(
          (c) => memberships.has(c.id) && internalChannel(c),
        ),
        response_metadata: value.response_metadata,
      };
    }
    if (method === "views.publish") {
      if (input.user_id !== link.slack_user || input.view?.type !== "home")
        throw new SlackError("user_not_owned", 403);
      const value = await call(method, {
        user_id: link.slack_user,
        view: input.view,
      });
      if (value.ok && value.view?.id)
        await registry.remember(link, value.view.id, "view", 30 * 86400_000);
      return value;
    }
    if (["views.open", "views.push", "views.update"].includes(method)) {
      if (input.view?.type !== "modal") throw new SlackError("invalid_view");
      const args = { view: input.view };
      if (method === "views.update") {
        await registry.object(link, input.view_id, "view");
        args.view_id = input.view_id;
        if (typeof input.hash === "string") args.hash = input.hash;
      } else {
        await registry.object(link, input.trigger_id, "trigger");
        args.trigger_id = input.trigger_id;
      }
      const value = await call(method, args);
      if (value.ok && value.view?.id)
        await registry.remember(link, value.view.id, "view");
      return value;
    }
    if (method === "entity.presentDetails") {
      if (typeof input.trigger_id !== "string" || !input.trigger_id || input.trigger_id.length > 256) throw new SlackError("invalid_trigger");
      await registry.object(link, taskTrigger(input.trigger_id), "entity-trigger");
      if (input.error?.status === "restricted") return call(method, { trigger_id: input.trigger_id, error: { status: "restricted" } });
      const metadata = taskEntity(input.metadata, origin, link, true);
      await registry.object(link, taskTrigger(input.trigger_id, metadata.external_ref.id), "entity-trigger");
      await registry.object(link, metadata.external_ref.id, "entity");
      return call(method, { trigger_id: input.trigger_id, metadata });
    }
    if (
      !["chat.postMessage", "chat.update", "chat.getPermalink"].includes(method)
    )
      throw new SlackError("method_not_allowed", 403);
    await channel(link, input.channel);
    if (method === "chat.getPermalink") {
      if (!timestamp(input.message_ts))
        throw new SlackError("invalid_timestamp");
      await registry.conversation(link, input.channel, input.message_ts);
      return call(method, {
        channel: input.channel,
        message_ts: input.message_ts,
      });
    }
    const args = {
      channel: input.channel,
      text: input.text,
      blocks: input.blocks,
      mrkdwn: false,
      parse: "none",
      unfurl_links: false,
      unfurl_media: false,
    };
    let entity;
    if (input.metadata !== undefined) {
      if (!Array.isArray(input.metadata?.entities) || input.metadata.entities.length !== 1) throw new SlackError("invalid_metadata");
      entity = taskEntity(input.metadata.entities[0], origin, link);
      // Claim before posting: a competing user's UUID must never appear in Slack.
      await registry.remember(link, entity.external_ref.id, "entity", 90 * 86400_000);
      args.metadata = { entities: [entity] };
    }
    if (method === "chat.update") {
      await registry.object(link, `${input.channel}:${input.ts}`, "message");
      args.ts = input.ts;
    }
    if (input.thread_ts) {
      if (!timestamp(input.thread_ts))
        throw new SlackError("invalid_timestamp");
      await registry.conversation(link, input.channel, input.thread_ts);
      args.thread_ts = input.thread_ts;
    }
    const value = await call(method, args);
    if (value.ok && timestamp(value.ts)) {
      await registry.remember(
        link,
        `${input.channel}:${value.ts}`,
        "message",
        90 * 86400_000,
      );
      if (method === "chat.postMessage" && !input.thread_ts)
        await registry.bind(link, input.channel, value.ts);
    }
    return value;
  }
  return { proxy, channel };
}
