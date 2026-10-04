import { taskEntity, taskTrigger } from "./embeds.mjs";
import { SlackError } from "./security.mjs";
import { diagramPng, uploadDiagram } from "./diagram-upload.mjs";

const channelId = (value) =>
  typeof value === "string" && /^[CG][A-Z0-9]{5,30}$/.test(value);
const directId = value => typeof value === "string" && /^D[A-Z0-9]{5,30}$/.test(value);
const timestamp = (value) =>
  typeof value === "string" && /^\d{10,16}\.\d{6}$/.test(value);
const formMethods = new Set([
  "auth.test",
  "users.info",
  "users.conversations",
  "conversations.info",
  "conversations.list",
  "chat.getPermalink",
  "files.getUploadURLExternal",
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
  return async function call(method, args = {}) {
    if (method === "files.uploadDiagram") return uploadDiagram(call, fetcher, args);
    if (!/^[a-z]+(?:\.[a-zA-Z]+){1,2}$/.test(method))
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

export function createScopedSlack({ call, registry, identity, origin, decorateHome }) {
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
    if (directId(id)) {
      await registry.object(link, `${link.id}:${id}`, "agent-dm");
      const value = await call("conversations.info", { channel: id });
      const c = value.channel;
      if (!value.ok || c?.id !== id || c.user !== link.slack_user || c.is_im !== true || c.is_mpim || c.is_archived) throw new SlackError("channel_not_owned", 403);
      return value;
    }
    if (!channelId(id)) throw new SlackError("invalid_channel");
    if (!(await memberChannels(link)).has(id))
      throw new SlackError("channel_not_owned", 403);
    const value = await call("conversations.info", { channel: id });
    if (!value.ok || value.channel?.id !== id || !internalChannel(value.channel))
      throw new SlackError("channel_not_allowed", 403);
    return value;
  }
  async function proxy(link, method, input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new SlackError("invalid_arguments");
    if (method === "files.uploadDiagram") {
      await channel(link, input.channel);
      if (!timestamp(input.thread_ts)) throw new SlackError("invalid_timestamp");
      await registry.conversation(link, input.channel, input.thread_ts);
      diagramPng(input.png);
      if (await registry.count(link, "diagram") >= 500) throw new SlackError("diagram_limit", 429);
      const value = await call(method, { png: input.png });
      if (value.ok && /^F[A-Z0-9]{5,30}$/.test(value.file_id || "")) {
        await registry.remember(link, value.file_id, "diagram", 90 * 86400_000);
        await registry.remember(link, `${input.channel}:${input.thread_ts}:${value.file_id}`, "diagram-destination", 90 * 86400_000);
      }
      return value;
    }
    if (["agents.sessions.setStatus", "assistant.threads.setStatus", "assistant.threads.setSuggestedPrompts"].includes(method)) {
      await channel(link, input.channel_id);
      if (!timestamp(input.thread_ts)) throw new SlackError("invalid_timestamp");
      await registry.conversation(link, input.channel_id, input.thread_ts);
      const args = { channel_id: input.channel_id, thread_ts: input.thread_ts };
      if (method === "agents.sessions.setStatus") {
        if (!["processing", "active", "suspended", "closed"].includes(input.status) || (input.initiator_user_id !== undefined && input.initiator_user_id !== link.slack_user)) throw new SlackError("invalid_status");
        args.status = input.status;
        if (typeof input.title === "string" && input.title.length <= 100) args.title = input.title;
        if (input.initiator_user_id) args.initiator_user_id = link.slack_user;
      } else if (method === "assistant.threads.setStatus") {
        if (typeof input.status !== "string" || input.status.length > 150) throw new SlackError("invalid_status");
        args.status = input.status;
      } else {
        if (!Array.isArray(input.prompts) || input.prompts.length > 4 || input.prompts.some(p => typeof p?.title !== "string" || !p.title || p.title.length > 75 || typeof p.message !== "string" || !p.message || p.message.length > 500)) throw new SlackError("invalid_prompts");
        args.prompts = input.prompts.map(p => ({ title: p.title, message: p.message }));
      }
      return call(method, args);
    }
    if (method === "canvases.create") {
      await channel(link, input.conversation_channel);
      if (!timestamp(input.conversation_ts)) throw new SlackError("invalid_timestamp");
      await registry.conversation(link, input.conversation_channel, input.conversation_ts);
      if (typeof input.title !== "string" || !input.title || input.title.length > 200 || input.document_content?.type !== "markdown" || typeof input.document_content.markdown !== "string" || Buffer.byteLength(input.document_content.markdown) > 24000 || (directId(input.conversation_channel) ? input.channel_id !== undefined : input.channel_id !== input.conversation_channel)) throw new SlackError("invalid_canvas");
      if (await registry.count(link, "canvas") >= 500) throw new SlackError("canvas_limit", 429);
      for (const match of input.document_content.markdown.matchAll(/https:\/\/[^\s)]+\/files\/[^\s)]*?(F[A-Z0-9]{5,30})(?:\/[^\s)]*)?/g)) await registry.object(link, `${input.conversation_channel}:${input.conversation_ts}:${match[1]}`, "diagram-destination");
      const value = await call(method, { title: input.title, document_content: { type: "markdown", markdown: input.document_content.markdown }, ...(input.channel_id ? { channel_id: input.channel_id } : {}) });
      if (value.ok && /^F[A-Z0-9]{5,30}$/.test(value.canvas_id || "")) await registry.remember(link, value.canvas_id, "canvas", 365 * 86400_000);
      return value;
    }
    if (method === "canvases.access.set") {
      if (!/^F[A-Z0-9]{5,30}$/.test(input.canvas_id || "") || input.access_level !== "read" || input.channel_ids !== undefined || !Array.isArray(input.user_ids) || input.user_ids.length !== 1 || input.user_ids[0] !== link.slack_user) throw new SlackError("canvas_not_owned", 403);
      await registry.object(link, input.canvas_id, "canvas");
      await registry.object(link, input.canvas_id, "canvas-delivered");
      return call(method, { canvas_id: input.canvas_id, access_level: "read", user_ids: [link.slack_user] });
    }
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
        view: decorateHome ? await decorateHome(input.view, link) : input.view,
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
      !["chat.postMessage", "chat.update", "chat.delete", "chat.getPermalink"].includes(method)
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
    if (method === "chat.delete") {
      if (!timestamp(input.ts)) throw new SlackError("invalid_timestamp");
      // A linked owner may delete only messages this bot posted for that link.
      await registry.object(link, `${input.channel}:${input.ts}`, "message");
      return call(method, { channel: input.channel, ts: input.ts });
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
    // Permit removal, never arbitrary caller-supplied attachments. Ownership
    // is checked below before the update reaches Slack.
    if (input.attachments !== undefined) {
      if (method !== "chat.update" || !Array.isArray(input.attachments) || input.attachments.length !== 0) throw new SlackError("invalid_attachments");
      args.attachments = [];
    }
    let entity;
    if (input.metadata !== undefined) {
      // Slack requires {} to remove existing metadata; omission retains it.
      // The message-ownership check below also gates metadata-only updates.
      if (method === "chat.update" && input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata) && Object.keys(input.metadata).length === 0) {
        args.metadata = {};
      } else {
        if (!Array.isArray(input.metadata?.entities) || input.metadata.entities.length !== 1) throw new SlackError("invalid_metadata");
        entity = taskEntity(input.metadata.entities[0], origin, link);
        // Claim before posting: a competing user's UUID must never appear in Slack.
        await registry.remember(link, entity.external_ref.id, "entity", 90 * 86400_000);
        args.metadata = { entities: [entity] };
      }
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
    // Images must be uploaded for this exact conversation by this linked owner.
    const imageBlocks = [];
    let blockNodes = 0;
    const inspect = (value, depth = 0) => {
      if (++blockNodes > 2000 || depth > 20) throw new SlackError("invalid_blocks");
      if (!value || typeof value !== "object") return;
      if (value.type === "image") imageBlocks.push(value);
      for (const child of Object.values(value)) if (child && typeof child === "object") inspect(child, depth + 1);
    };
    if (input.blocks !== undefined) {
      if (!Array.isArray(input.blocks) || input.blocks.length > 50) throw new SlackError("invalid_blocks");
      inspect(input.blocks);
    }
    for (const block of imageBlocks) {
      if (!/^F[A-Z0-9]{5,30}$/.test(block.slack_file?.id || "") || block.image_url || block.slack_file.url) throw new SlackError("invalid_diagram_image");
      const root = input.thread_ts || input.conversation_ts;
      if (!timestamp(root)) throw new SlackError("invalid_timestamp");
      await registry.conversation(link, input.channel, root);
      if (method === "chat.update") await registry.object(link, `${input.channel}:${input.ts}:${root}`, "message-conversation");
      await registry.object(link, block.slack_file.id, "diagram");
      await registry.object(link, `${input.channel}:${root}:${block.slack_file.id}`, "diagram-destination");
    }
    const canvasMatch = directId(input.channel) && typeof input.text === "string"
      ? input.text.match(new RegExp(`https://app\\.slack\\.com/docs/${identity.team}/(F[A-Z0-9]{5,30})(?:\\s|$)`))
      : undefined;
    // Authorize before the write. A post-write rejection would turn an already
    // delivered message into an ambiguous failure in the laptop's outbox.
    if (canvasMatch) await registry.object(link, canvasMatch[1], "canvas");
    const value = await call(method, args);
    if (value.ok && timestamp(value.ts)) {
      await registry.remember(
        link,
        `${input.channel}:${value.ts}`,
        "message",
        90 * 86400_000,
      );
      if (method === "chat.postMessage" && input.thread_ts) await registry.remember(link, `${input.channel}:${value.ts}:${input.thread_ts}`, "message-conversation", 90 * 86400_000);
      if (method === "chat.postMessage" && !input.thread_ts)
        await registry.bind(link, input.channel, value.ts);
      if (canvasMatch)
        await registry.remember(link, canvasMatch[1], "canvas-delivered", 365 * 86400_000);
    }
    return value;
  }
  return { proxy, channel };
}
