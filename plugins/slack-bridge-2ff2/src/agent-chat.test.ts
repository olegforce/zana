import { afterEach, expect, it, vi } from "vitest";
import { contextChannel } from "./agent-chat.js";
import { setup, identity, route, stamp } from "../test/helpers.js";
import { conversationKey, ownerDirect, slackCall } from "./model.js";

let s: ReturnType<typeof setup>;
afterEach(async () => {
  if (s) {
    await s.close();
    s = undefined as any;
  }
  vi.useRealTimers();
});
const dm = { id: "D123456", user: "U123456", is_im: true, is_archived: false };
const event = (type = "message", extra = {}, id = "Chat1", root = stamp()) => ({
  type: "event_callback",
  team_id: identity.team,
  api_app_id: identity.app,
  event_id: id,
  event: {
    type,
    channel: dm.id,
    user: dm.user,
    ts: stamp(),
    thread_ts: root,
    text: "Review this Project",
    ...extra,
  },
});
async function chat() {
  s = setup();
  const original = s.call.getMockImplementation()!;
  s.call.mockImplementation(async (m, a) =>
    m === "conversations.info" && a.channel === dm.id
      ? { ok: true, channel: dm }
      : original(m, a),
  );
  s.bridge.config.agentChatEnabled = true;
  s.bridge.config.routes = [{ ...route, summaries: true }];
  await s.connect();
  return s;
}
const key = (root: string) =>
  conversationKey({ ...identity, channel: dm.id, root });
async function select(root: string) {
  await s.bridge.chat.tick();
  const session = s.store.get("agentChat", key(root))!;
  const p = {
    type: "block_actions",
    team: { id: identity.team },
    api_app_id: identity.app,
    user: { id: dm.user },
    message: { ts: session.welcomeTs, thread_ts: root },
    container: { channel_id: dm.id, message_ts: session.welcomeTs },
    actions: [
      {
        action_id: "agent_project",
        action_ts: stamp(),
        selected_option: { value: route.channel },
      },
    ],
  };
  await s.receive(p as any);
  return p;
}
it("accepts legacy Project overrides, reuses the same agent, and clears native progress", async () => {
  await chat();
  const root = stamp();
  await s.receive(event("message", {}, "first", root));
  expect(s.spawn).not.toHaveBeenCalled();
  expect(s.store.list("receipt")).toHaveLength(0);
  const choice = await select(root);
  expect(s.store.list("receipt")).toHaveLength(1);
  await s.bridge.tick();
  await s.bridge.chat.tick();
  await s.bridge.chat.drain();
  await s.bridge.tick();
  expect(s.spawn).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: route.projectId, model: route.model }),
  );
  const binding = s.store.get("binding", key(root))!;
  expect(binding.sourceChannel).toBe(route.channel);
  await s.receive(choice as any);
  expect(s.store.list("receipt")).toHaveLength(1);
  s.store.put("agentChat", key(root), {
    ...s.store.get("agentChat", key(root))!,
    next: 0,
  });
  await s.bridge.chat.tick();
  expect(s.call).toHaveBeenCalledWith(
    "agents.sessions.setStatus",
    expect.objectContaining({ status: "processing", channel_id: dm.id }),
  );
  s.threads.get(binding.threadId).status = "idle";
  await s.bridge.event({ name: "thread.idle", threadId: binding.threadId });
  s.store.put("agentChat", key(root), {
    ...s.store.get("agentChat", key(root))!,
    next: 0,
  });
  await s.bridge.chat.tick();
  expect(s.call).toHaveBeenCalledWith(
    "agents.sessions.setStatus",
    expect.objectContaining({ status: "active" }),
  );
  await s.receive(event("message", { text: "Continue" }, "follow", root));
  await s.bridge.tick();
  await s.bridge.chat.tick();
  await s.bridge.chat.drain();
  await s.bridge.tick();
  expect(s.send).toHaveBeenCalledWith(
    expect.objectContaining({ threadId: binding.threadId }),
  );
  await s.receive(event("agent_session_stopped", {}, "native-stop", root));
  await s.bridge.tick();
  await s.bridge.chat.tick();
  await s.bridge.chat.drain();
  await s.bridge.tick();
  expect(s.stop).toHaveBeenCalled();
  await s.receive(
    event("agent_session_title_changed", { title: "My review" }, "title", root),
  );
  expect(s.store.get("binding", key(root))?.title).toBe("My review");
});
it("decodes Slack entities once in private messages before dispatch", async () => {
  await chat();
  const root = stamp();
  await s.receive(
    event(
      "message",
      { text: "a &lt; 3 &amp;&amp; a &gt; 0; &amp;lt; &quot;" },
      "entities",
      root,
    ),
  );
  await select(root);
  await s.bridge.tick();
  await s.bridge.chat.tick();
  await s.bridge.chat.drain();
  await s.bridge.tick();
  expect(s.spawn).toHaveBeenCalledWith(
    expect.objectContaining({
      prompt: "a < 3 && a > 0; &lt; &quot;",
    }),
  );
});
it("strips its own mention from native chat tasks and stop commands", async () => {
  await chat();
  const root = stamp();
  await s.receive(
    event(
      "message",
      { text: `<@${identity.bot}> Review <@U987654>` },
      "mentioned-task",
      root,
    ),
  );
  await select(root);
  await s.bridge.tick();
  await s.bridge.chat.tick();
  await s.bridge.chat.drain();
  await s.bridge.tick();
  expect(s.spawn).toHaveBeenCalledWith(
    expect.objectContaining({ prompt: "Review <@U987654>" }),
  );
  await s.receive(
    event(
      "message",
      { text: `<@${identity.bot}> stop` },
      "mentioned-stop",
      root,
    ),
  );
  await s.bridge.tick();
  await s.bridge.chat.tick();
  await s.bridge.chat.drain();
  await s.bridge.tick();
  expect(s.stop).toHaveBeenCalledTimes(1);
  expect(s.spawn).toHaveBeenCalledTimes(1);
  expect(s.send).not.toHaveBeenCalled();
});
it("a bare mention offers Project selection and later shows status without sending a task", async () => {
  await chat();
  const root = stamp();
  await s.receive(
    event("message", { text: `<@${identity.bot}>` }, "bare-start", root),
  );
  await select(root);
  await s.bridge.tick();
  await s.bridge.chat.tick();
  await s.bridge.chat.drain();
  await s.bridge.tick();
  expect(s.spawn).not.toHaveBeenCalled();
  expect(s.store.get("agentChat", key(root))?.pending).toBeUndefined();
  await s.receive(event("message", { text: "Review" }, "real-task", root));
  await s.bridge.tick();
  await s.bridge.chat.tick();
  await s.bridge.chat.drain();
  await s.bridge.tick();
  await s.receive(
    event("message", { text: `<@${identity.bot}>` }, "bare-status", root),
  );
  await s.bridge.tick();
  await s.bridge.chat.tick();
  await s.bridge.chat.drain();
  await s.bridge.tick();
  expect(s.spawn).toHaveBeenCalledTimes(1);
  expect(s.send).not.toHaveBeenCalled();
  expect(s.store.get("receipt", "bare-status")?.state).toBe("settled");
});
it("uses modern and legacy context only for a new configured Project", async () => {
  await chat();
  const root = stamp();
  await s.receive(
    event(
      "assistant_thread_started",
      {
        channel: undefined,
        thread_ts: undefined,
        assistant_thread: {
          channel_id: dm.id,
          thread_ts: root,
          user_id: dm.user,
          context: { team_id: identity.team, channel_id: route.channel },
        },
      },
      "start",
      root,
    ),
  );
  expect(s.store.get("agentChat", key(root))?.route?.channel).toBe(
    route.channel,
  );
  await s.receive(
    event(
      "assistant_thread_context_changed",
      {
        assistant_thread: {
          context: { team_id: identity.team, channel_id: "C987654" },
        },
      },
      "context",
      root,
    ),
  );
  await s.receive(
    event("app_context_changed", { context: {} }, "modern-context", root),
  );
  expect(s.store.get("agentChat", key(root))?.route?.channel).toBe(
    route.channel,
  );
  await s.receive(
    event(
      "message",
      {
        app_context: {
          entities: [
            {
              type: "slack#/types/channel_id",
              team_id: identity.team,
              value: route.channel,
            },
          ],
        },
      },
      "go",
      root,
    ),
  );
  await s.bridge.tick();
  await s.bridge.chat.tick();
  await s.bridge.chat.drain();
  await s.bridge.tick();
  expect(s.spawn).toHaveBeenCalledTimes(1);
  expect(
    contextChannel(
      {
        entities: [
          {
            type: "slack#/types/channel_id",
            team_id: "other",
            value: route.channel,
          },
        ],
      },
      identity.team,
    ),
  ).toBeUndefined();
  expect(contextChannel(null, identity.team)).toBeUndefined();
});
it.each([
  { user: "U234567" },
  { bot_id: "B123456" },
  { subtype: "message_changed" },
  { text: "" },
  { text: "a".repeat(12001) },
  { ts: "1234567890.000001" },
  { thread_ts: "bad" },
])("ignores invalid or non-owner DM input %j", async (extra) => {
  await chat();
  await s.receive(event("message", extra));
  expect(s.spawn).not.toHaveBeenCalled();
  expect(s.store.list("receipt")).toHaveLength(0);
});
it("does not restore access after a remap, owner rotation, disabled flag or another workspace", async () => {
  await chat();
  const root = stamp();
  await s.receive(
    event(
      "message",
      {
        app_context: {
          entities: [
            {
              type: "slack#/types/channel_id",
              team_id: identity.team,
              value: route.channel,
            },
          ],
        },
      },
      "go",
      root,
    ),
  );
  expect(s.bridge.destinationRoute(dm.id, root)).toHaveProperty(
    "sourceChannel",
    route.channel,
  );
  s.bridge.config.routes = [{ ...route, model: "changed", summaries: true }];
  expect(s.bridge.destinationRoute(dm.id, root)).toBeUndefined();
  await s.bridge.tick();
  await s.bridge.chat.tick();
  await s.bridge.chat.drain();
  await s.bridge.tick();
  expect(s.spawn).not.toHaveBeenCalled();
  s.bridge.config.routes = [{ ...route, summaries: true }];
  s.bridge.config.ownerEpoch = "new";
  expect(s.bridge.destinationRoute(dm.id, root)).toBeUndefined();
  await s.receive(event("message", {}, "again", root));
  expect(s.store.get("agentChat", key(root))?.ownerEpoch).toBeUndefined();
  s.bridge.config.ownerEpoch = undefined;
  s.bridge.config.agentChatEnabled = false;
  await s.receive(event("message", {}, "off"));
  expect(s.bridge.destinationRoute(dm.id, root)).toBeUndefined();
  const p = event();
  p.team_id = "T987654";
  await s.receive(p);
  expect(s.spawn).not.toHaveBeenCalled();
});
it("requires a valid welcome message to choose a Project and preserves the first pending task", async () => {
  await chat();
  const root = stamp();
  await s.receive(event("message", {}, "first", root));
  await s.receive(event("message", { text: "overwrite" }, "second", root));
  expect(s.store.get("agentChat", key(root))?.pending?.text).toBe(
    "Review this Project",
  );
  const choice = await select(root);
  expect(s.store.list("receipt")[0].id).toBe("first");
  const forged = {
    ...choice,
    container: { ...choice.container, message_ts: "1234567890.000001" },
  };
  await s.receive(forged as any);
  expect(s.store.list("receipt")).toHaveLength(1);
  s.store.put("agentChat", key(root), {
    ...s.store.get("agentChat", key(root))!,
    choices: [],
  });
  await s.receive(choice as any);
  expect(s.spawn).not.toHaveBeenCalled();
});
it.each(["wrong-owner", "shared-source", "revoke-during-check"])(
  "fails closed on %s",
  async (scenario) => {
    await chat();
    const root = stamp();
    await s.receive(
      event(
        "message",
        {
          app_context: {
            entities: [
              {
                type: "slack#/types/channel_id",
                team_id: identity.team,
                value: route.channel,
              },
            ],
          },
        },
        "go",
        root,
      ),
    );
    const original = s.call.getMockImplementation()!;
    s.call.mockImplementation(async (m, a) => {
      if (m === "conversations.info") {
        if (scenario === "wrong-owner" && a.channel === dm.id)
          return { ok: true, channel: { ...dm, user: "U987654" } };
        if (scenario === "shared-source" && a.channel === route.channel)
          return { ok: true, channel: { ...route, is_shared: true } };
        if (scenario === "revoke-during-check")
          s.bridge.config.agentChatEnabled = false;
      }
      return original(m, a);
    });
    await s.bridge.tick();
    await s.bridge.chat.tick();
    await s.bridge.chat.drain();
    await s.bridge.tick();
    expect(s.spawn).not.toHaveBeenCalled();
  },
);
it.each(["reject", "throw", "malformed"])(
  "does not retry an unconfirmed welcome (%s)",
  async (mode) => {
    await chat();
    await s.receive(event());
    const original = s.call.getMockImplementation()!;
    s.call.mockImplementation(async (m, a) => {
      if (m === "chat.postMessage") {
        if (mode === "throw") throw new Error("timeout");
        return mode === "reject"
          ? { ok: false, error: "missing_scope" }
          : { ok: true, ts: "bad" };
      }
      return original(m, a);
    });
    await s.bridge.chat.tick();
    await s.bridge.chat.tick();
    expect(
      s.call.mock.calls.filter(([m]) => m === "chat.postMessage"),
    ).toHaveLength(1);
    expect(s.store.list("agentChat")[0].state).toBe(
      mode === "reject" ? "failed" : "uncertain",
    );
  },
);
it("falls back only on definitive old API rejection and retains actionable native API errors", async () => {
  await chat();
  const root = stamp();
  await s.receive(event());
  await select(root);
  const original = s.call.getMockImplementation()!;
  s.call.mockImplementation(async (m, a) =>
    m === "agents.sessions.setStatus"
      ? Promise.reject({
          code: "slack_webapi_platform_error",
          data: { error: "unknown_method" },
        })
      : original(m, a),
  );
  s.store.put("agentChat", key(root), {
    ...s.store.get("agentChat", key(root))!,
    next: 0,
  });
  await s.bridge.chat.tick();
  expect(s.call).toHaveBeenCalledWith(
    "assistant.threads.setStatus",
    expect.objectContaining({ status: "" }),
  );
  s.bridge.chat.reset();
  s.store.put("agentChat", key(root), {
    ...s.store.get("agentChat", key(root))!,
    status: undefined,
    next: 0,
  });
  s.call.mockImplementation(async (m, a) =>
    m === "agents.sessions.setStatus"
      ? { ok: false, error: "missing_scope" }
      : original(m, a),
  );
  await s.bridge.chat.tick();
  expect(s.store.get("agentChat", key(root))?.note).toContain("missing_scope");
  s.store.put("agentChat", key(root), {
    ...s.store.get("agentChat", key(root))!,
    next: 0,
  });
  s.call.mockImplementation(async (m, a) => {
    if (m === "agents.sessions.setStatus") throw new Error("timeout");
    return original(m, a);
  });
  await s.bridge.chat.tick();
  expect(s.store.get("agentChat", key(root))?.note).toContain("continues");
});
it("caps sessions and excludes inaccessible route choices", async () => {
  await chat();
  s.bridge.config.slackAccess = { projects: false };
  await s.receive(event());
  expect(s.store.list("agentChat")[0].choices).toEqual([]);
  const saved = s.store.list("agentChat")[0];
  for (let i = 0; i < 500; i++)
    s.store.put("agentChat", "cap" + i, { ...saved, id: "cap" + i });
  await s.receive(event("message", {}, "new", "1790879999.000002"));
  expect(s.store.list("agentChat", undefined, 1000)).toHaveLength(501);
  expect(ownerDirect({ ...dm, is_mpim: true }, dm.user)).toBe(false);
  await expect(
    slackCall(
      {
        call: async () => {
          throw new Error("transport");
        },
      } as any,
      "x",
      {},
    ),
  ).rejects.toThrow("transport");
});
it("recovers a sending welcome without replay and clears a revoked progress indicator", async () => {
  await chat();
  const root = stamp();
  await s.receive(event("message", {}, "first", root));
  await select(root);
  const saved = s.store.get("agentChat", key(root))!;
  s.store.put("agentChat", saved.id, {
    ...saved,
    next: 0,
    status: "processing",
  });
  s.bridge.config.slackAccess = { status: false };
  await s.bridge.chat.tick();
  expect(s.call).toHaveBeenCalledWith(
    "agents.sessions.setStatus",
    expect.objectContaining({ status: "active" }),
  );
  s.store.put("agentChat", saved.id, { ...saved, state: "sending" });
  s.store.recover();
  expect(s.store.get("agentChat", saved.id)?.state).toBe("uncertain");
});
