import { afterEach, expect, it, vi } from "vitest";
import {
  body,
  identity,
  internal,
  route,
  setup,
  stamp,
} from "../test/helpers.js";
import {
  destinationBlock,
  harnessBlock,
  modelBlock,
  launchView,
  bindingRoute,
} from "./home-view.js";
import { Store } from "./store.js";
const fixtures: ReturnType<typeof setup>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture(defaultProject = false) {
  const f = setup();
  fixtures.push(f);
  if (defaultProject)
    (f.zcc.sdk.projects.list as any).mockResolvedValue([
      { id: "p1", name: "Renamed default", quickAgent: true },
    ]);
  (f.zcc.sdk.providers.list as any).mockResolvedValue([
    { id: "codex", displayName: "Codex", available: true },
    { id: "cursor", displayName: "Cursor", available: true },
    { id: "unavailable", available: false },
  ]);
  (f.zcc.sdk.providers.models as any).mockImplementation(
    async ({ providerId }: any) => ({
      models: [
        { model: providerId === "cursor" ? "cursor-model" : "demo-model" },
      ],
      modelLoadError: null,
    }),
  );
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (m, a) =>
    m === "conversations.info" && a.channel === "C222222"
      ? { ok: true, channel: { ...internal, id: "C222222", name: "caller" } }
      : m === "conversations.info" && a.channel === "D123456"
        ? { ok: true, channel: { id: "D123456", user: "U123456", is_im: true } }
        : original(m, a),
  );
  await f.connect();
  await f.bridge.home.publish(true);
  return f;
}
async function slash(f: ReturnType<typeof setup>, channel = "C222222") {
  await f.receive({
    command: "/zana",
    text: "run p1 Say hello",
    user_id: "U123456",
    team_id: identity.team,
    api_app_id: identity.app,
    channel_id: channel,
    trigger_id: "trigger",
  } as any);
  return {
    ...f.call.mock.calls.filter(([m]) => m === "views.open").at(-1)![1].view,
    id: "V654321",
  };
}
function submit(
  view: any,
  channel = "C222222",
  provider = "codex",
  model = "demo-model",
) {
  return {
    type: "view_submission",
    team: { id: identity.team },
    api_app_id: identity.app,
    user: { id: "U123456" },
    view: {
      ...view,
      state: {
        values: {
          project: { launch_project: { selected_option: { value: "p1" } } },
          [destinationBlock("p1")]: {
            channel: { selected_option: { value: channel } },
          },
          [harnessBlock("p1")]: {
            launch_harness: { selected_option: { value: provider } },
          },
          [modelBlock("p1", provider)]: {
            launch_model: { selected_option: { value: model } },
          },
          task: { prompt: { value: "Say hello" } },
        },
      },
    },
  };
}
async function suggestions(
  f: ReturnType<typeof setup>,
  view: any,
  provider = "cursor",
  value = "",
) {
  return f.receive({
    type: "block_suggestion",
    team: { id: identity.team },
    api_app_id: identity.app,
    user: { id: "U123456" },
    action_id: "launch_model",
    block_id: modelBlock("p1", provider),
    value,
    view: submit(view, "C222222", provider).view,
  } as any);
}
async function drain(f: ReturnType<typeof setup>) {
  await f.bridge.home.tick();
  await f.bridge.flush();
  await f.bridge.home.tick();
  await f.bridge.tick();
}
it("persists an explicit approved mention default on an older host without the built-in marker", async () => {
  const f = await fixture();
  await f.bridge.setMentionDefault({ projectId: "p1" });
  expect(f.store.config().mentionDefaultProjectId).toBe("p1");
  const m = body("Do x", "EvExplicitDefault");
  m.event.channel = "C222222";
  await f.receive(m);
  await f.bridge.tick();
  expect(f.spawn).toHaveBeenCalledTimes(1);
  await f.bridge.setMentionDefault({ projectId: "" });
  expect(f.store.config().mentionDefaultProjectId).toBeUndefined();
});
it.each([
  "unknown Project",
  "unmapped",
  "missing model",
  "owner reset",
  "connection changed",
])("rejects a mention default with %s", async (condition) => {
  const f = await fixture();
  if (condition === "unmapped") f.bridge.config.routes = [];
  if (condition === "missing model")
    f.bridge.config.routes = [{ ...route, model: undefined }];
  if (condition === "owner reset") f.bridge.config.owner = undefined;
  if (condition === "connection changed")
    (f.zcc.sdk.projects.list as any).mockImplementation(async () => {
      await f.bridge.disconnect();
      return [{ id: "p1" }];
    });
  await expect(
    f.bridge.setMentionDefault({
      projectId: condition === "unknown Project" ? "foreign" : "p1",
    }),
  ).rejects.toThrow();
  expect(f.store.config().mentionDefaultProjectId).toBeUndefined();
});
it("starts a bare task directly in an unmapped thread using the host-marked Default Project and retains its profile", async () => {
  const f = await fixture(true),
    m = body("Do x", "EvDefault");
  m.event.channel = "C222222";
  await f.receive(m);
  await f.receive(m);
  expect(f.store.list("homeLaunch")).toHaveLength(0);
  expect(f.store.list("receipt")).toHaveLength(1);
  expect(f.store.get("receipt", m.event_id)?.requestedRoute).toMatchObject({
    ...route,
    channel: "C222222",
    sourceChannel: route.channel,
  });
  await f.bridge.tick();
  expect(f.spawn).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      projectId: "p1",
      hostId: "h1",
      providerId: "codex",
      model: "demo-model",
    }),
  );
  const b = f.store.list("binding")[0];
  expect(b).toMatchObject({
    channel: m.event.channel,
    root: m.event.thread_ts,
  });
  expect(
    f.call.mock.calls.some(
      ([method, args]) =>
        method === "chat.postMessage" &&
        args.text?.startsWith("Task from Zana:"),
    ),
  ).toBe(false);
  f.threads.get(b.threadId).status = "idle";
  await f.bridge.event({ name: "thread.idle", threadId: b.threadId });
  await f.receive({
    ...m,
    event_id: "EvDefaultFollowup",
    event: { ...m.event, text: "<@U999999> Continue" },
  });
  await f.bridge.tick();
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.spawn).toHaveBeenCalledTimes(1);
  f.bridge.config.routes = [{ ...route, model: "another-model" }];
  await f.receive({ ...m, event_id: "EvDefaultRevoked" });
  await f.bridge.tick();
  expect(f.bridge.destinationRoute(b.channel, b.root)).toBeUndefined();
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.send).toHaveBeenCalledTimes(1);
});
it("keeps an explicit channel mapping ahead of the Default Project", async () => {
  const f = await fixture(true);
  f.bridge.config.routes.push({
    ...route,
    channel: "C222222",
    providerId: "cursor",
    model: "cursor-model",
  });
  const m = body("Do x", "EvMapped");
  m.event.channel = "C222222";
  await f.receive(m);
  await f.bridge.tick();
  expect(f.spawn).toHaveBeenCalledWith(
    expect.objectContaining({ providerId: "cursor", model: "cursor-model" }),
  );
  expect(f.store.list("launchConversation")).toHaveLength(0);
});
it.each(["missing route", "missing model", "disabled", "stale", "oversized"])(
  "does not auto-launch a Default Project task with %s",
  async (condition) => {
    const f = await fixture(true),
      m = body("Do x", "EvUnsafeDefault");
    m.event.channel = "C222222";
    if (condition === "missing route") f.bridge.config.routes = [];
    if (condition === "missing model")
      f.bridge.config.routes = [{ ...route, model: undefined }];
    if (condition === "disabled")
      f.bridge.config.slackAccess = { launch: false };
    if (condition === "stale")
      m.event.ts = `${Math.floor(Date.now() / 1000) - 600}.000001`;
    if (condition === "oversized")
      m.event.text = `<@U999999> ${"x".repeat(2001)}`;
    await f.receive(m);
    await f.bridge.tick();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.store.list("launchConversation")).toHaveLength(0);
  },
);
it.each(["named", "ambiguous", "failed lookup"])(
  "requires a unique host-owned Default Project marker: %s",
  async (condition) => {
    const f = setup();
    fixtures.push(f);
    (f.zcc.sdk.projects.list as any)[
      condition === "failed lookup" ? "mockRejectedValue" : "mockResolvedValue"
    ](
      condition === "failed lookup"
        ? new Error("offline")
        : condition === "named"
          ? [{ id: "p1", name: "Default Project" }]
          : [
              { id: "p1", quickAgent: true },
              { id: "p2", quickAgent: true },
            ],
    );
    await f.connect();
    const m = body("Do x", "EvNoDefault");
    m.event.channel = "C222222";
    await f.receive(m);
    expect(f.store.list("homeLaunch")).toHaveLength(1);
    expect(f.store.list("receipt")).toHaveLength(0);
  },
);
it("rechecks available models before auto-launching and refuses unavailable defaults", async () => {
  const f = await fixture(true),
    m = body("Do x", "EvMissingDefaultModel");
  m.event.channel = "C222222";
  (f.zcc.sdk.providers.models as any).mockResolvedValue({
    models: [],
    modelLoadError: null,
  });
  await f.receive(m);
  await f.bridge.tick();
  expect(f.spawn).not.toHaveBeenCalled();
  expect(f.store.get("receipt", m.event_id)?.state).toBe("rejected");
});
it("prefills the calling channel and Project defaults, offers installed harnesses and resets the model on harness change", async () => {
  const f = await fixture(),
    view = await slash(f);
  const get = (v: any, id: string) =>
    v.blocks.find((b: any) => b.block_id === id)?.element;
  expect(get(view, destinationBlock("p1")).initial_option.value).toBe(
    "C222222",
  );
  expect(
    get(view, harnessBlock("p1")).options.map((o: any) => o.value),
  ).toEqual(["codex", "cursor"]);
  expect(get(view, modelBlock("p1", "codex")).initial_option.value).toBe(
    "demo-model",
  );
  await f.receive({
    type: "block_actions",
    team: { id: identity.team },
    api_app_id: identity.app,
    user: { id: "U123456" },
    view: { ...submit(view).view, hash: "h1" },
    actions: [
      { action_id: "launch_harness", selected_option: { value: "cursor" } },
    ],
  } as any);
  const update = f.call.mock.calls
    .filter(([m]) => m === "views.update")
    .at(-1)![1].view;
  expect(
    get(update, modelBlock("p1", "cursor")).initial_option,
  ).toBeUndefined();
  expect(get(update, modelBlock("p1", "codex"))).toBeUndefined();
});
it("launches in an unconnected calling channel using chosen harness/model and keeps subsequent turns pinned", async () => {
  const f = await fixture(),
    view = await slash(f);
  expect(await suggestions(f, view)).toHaveBeenCalledWith({
    options: [
      {
        text: { type: "plain_text", text: "cursor-model" },
        value: "cursor-model",
      },
    ],
  });
  await f.receive(submit(view, "C222222", "cursor", "cursor-model") as any);
  await f.receive(submit(view, "C222222", "cursor", "cursor-model") as any);
  await drain(f);
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.spawn).toHaveBeenCalledWith(
    expect.objectContaining({
      providerId: "cursor",
      model: "cursor-model",
      projectId: "p1",
      hostId: "h1",
    }),
  );
  const b = f.store.list("binding")[0];
  expect(b.channel).toBe("C222222");
  expect(bindingRoute(f.bridge.config, b)?.providerId).toBe("cursor");
  expect(f.bridge.config.routes).toEqual([route]);
  await f.bridge.home.publish(true);
  const home = JSON.stringify(
    f.call.mock.calls.filter(([m]) => m === "views.publish").at(-1)![1],
  );
  expect(home).toContain("Say hello");
  f.threads.get(b.threadId).status = "idle";
  await f.bridge.event({ threadId: b.threadId, name: "thread.idle" });
  const m = body("Follow up", "follow", b.root);
  m.event.channel = b.channel;
  await f.receive(m);
  await f.bridge.tick();
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.send).toHaveBeenCalledTimes(1);
  f.bridge.config.routes = [];
  expect(f.bridge.routeFor(b)).toBeUndefined();
  expect(f.bridge.destinationRoute(b.channel, b.root)).toBeUndefined();
  f.bridge.config.routes = [
    { ...route, channel: b.channel, projectId: "another" },
  ];
  expect(f.bridge.destinationRoute(b.channel, b.root)).toBeUndefined();
});
it("allows an alternate profile in the Project channel and preserves its source authority", async () => {
  const f = await fixture(),
    view = await slash(f, route.channel);
  await suggestions(f, view);
  await f.receive(submit(view, route.channel, "cursor", "cursor-model") as any);
  await drain(f);
  const b = f.store.list("binding")[0];
  expect(f.bridge.routeFor(b)?.model).toBe("cursor-model");
  f.bridge.config.ownerEpoch = "rotated";
  expect(bindingRoute(f.bridge.config, b)).toBeUndefined();
});
it("rejects forged harnesses, unoffered models and destinations without launching", async () => {
  const f = await fixture(),
    view = await slash(f);
  for (const [channel, provider, model] of [
    ["C222222", "unavailable", "anything"],
    ["C222222", "cursor", "demo-model"],
    ["C999999", "codex", "demo-model"],
  ]) {
    const ack = await f.receive(submit(view, channel, provider, model) as any);
    expect(ack.mock.calls[0][0]).toHaveProperty("response_action", "errors");
  }
  expect(f.spawn).not.toHaveBeenCalled();
  expect(f.store.list("homeLaunch")[0].state).toBe("draft");
});
it("filters/bounds model suggestions and refuses stale, foreign or failed lookups", async () => {
  const f = await fixture(),
    view = await slash(f);
  (f.zcc.sdk.providers.models as any).mockResolvedValue({
    models: Array.from({ length: 120 }, (_, i) => ({
      model: `test-${i}`,
    })).concat([{ model: "x".repeat(151) }]),
    modelLoadError: null,
  });
  const all = await suggestions(f, view);
  expect((all.mock.calls[0][0] as any).options).toHaveLength(100);
  expect(
    (await suggestions(f, view, "cursor", "test-119")).mock.calls[0][0],
  ).toMatchObject({ options: [{ value: "test-119" }] });
  expect(
    (await suggestions(f, { ...view, id: "foreign" })).mock.calls[0][0],
  ).toEqual({ options: [] });
  (f.bridge.home as any).modelCache.clear();
  (f.zcc.sdk.providers.models as any).mockRejectedValue(new Error("offline"));
  expect((await suggestions(f, view)).mock.calls[0][0]).toEqual({
    options: [],
  });
  f.bridge.config.routes = [];
  expect((await suggestions(f, view)).mock.calls[0][0]).toEqual({
    options: [],
  });
});
it("does not post or launch when the caller channel becomes shared or the source changes", async () => {
  const f = await fixture(),
    view = await slash(f);
  await f.receive(submit(view) as any);
  await f.bridge.home.tick();
  f.call.mockResolvedValue({
    ok: true,
    channel: { ...internal, id: "C222222", is_shared: true },
  });
  await f.bridge.flush();
  expect(f.store.list("delivery")[0].state).toBe("failed");
  expect(f.spawn).not.toHaveBeenCalled();
  f.bridge.config.routes[0] = { ...route, model: "changed" };
  await f.bridge.home.tick();
  expect(f.store.list("homeLaunch")[0].state).toBe("rejected");
});
it("rechecks the model catalog before spawn and rejects a removed model", async () => {
  const f = await fixture(),
    view = await slash(f);
  await f.receive(submit(view) as any);
  (f.zcc.sdk.providers.models as any).mockResolvedValue({
    models: [],
    modelLoadError: null,
  });
  await drain(f);
  expect(f.spawn).not.toHaveBeenCalled();
  expect(f.store.list("receipt")[0]).toMatchObject({
    state: "rejected",
    note: expect.stringContaining("no longer available"),
  });
});
it("accepts a slash launch and a plain follow-up in the owner's verified DM", async () => {
  const f = await fixture(),
    view = await slash(f, "D123456");
  await f.receive(submit(view, "D123456") as any);
  await drain(f);
  const b = f.store.list("binding")[0];
  expect(b.channel).toBe("D123456");
  f.threads.get(b.threadId).status = "idle";
  await f.bridge.event({ threadId: b.threadId, name: "thread.idle" });
  await f.receive({
    type: "event_callback",
    team_id: identity.team,
    api_app_id: identity.app,
    event_id: "dm-follow",
    event: {
      type: "message",
      channel: b.channel,
      user: "U123456",
      thread_ts: b.root,
      ts: stamp(),
      text: "Follow up",
    },
  } as any);
  await f.bridge.tick();
  expect(f.send).toHaveBeenCalledTimes(1);
});
it("offers a durable picker for an unconnected mention and opens it only from its owned button", async () => {
  const f = await fixture(),
    m = body("run Say hello", "anywhere");
  m.event.channel = "C222222";
  await f.receive(m);
  await f.receive(m);
  expect(f.store.list("homeLaunch")).toHaveLength(1);
  await f.bridge.home.tick();
  const d = f.store.list("homeLaunch")[0];
  expect(d).toMatchObject({ offer: "sent", task: "Say hello" });
  expect(f.spawn).not.toHaveBeenCalled();
  const action = {
    type: "block_actions",
    team: { id: identity.team },
    api_app_id: identity.app,
    user: { id: "U123456" },
    trigger_id: "t",
    container: { channel_id: d.callerChannel, message_ts: d.offerTs },
    message: { thread_ts: d.replyRoot },
    actions: [{ action_id: "launch_here", value: d.id }],
  };
  await f.receive({
    ...action,
    container: { ...action.container, message_ts: "foreign" },
  } as any);
  expect(f.call.mock.calls.some(([m]) => m === "views.open")).toBe(false);
  await f.receive(action as any);
  const view = {
    ...f.call.mock.calls.filter(([m]) => m === "views.open").at(-1)![1].view,
    id: "V654321",
  };
  await f.receive(submit(view) as any);
  await drain(f);
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.store.list("binding")[0].root).toBe(m.event.thread_ts);
});
it("retains uncertain invitations across restart and never automatically resends them", async () => {
  const f = await fixture(),
    m = body("Task", "uncertain");
  m.event.channel = "C222222";
  await f.receive(m);
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (method, args) =>
    method === "chat.postMessage"
      ? Promise.reject(new Error("timeout"))
      : original(method, args),
  );
  await f.bridge.home.tick();
  await f.bridge.home.tick();
  expect(
    f.call.mock.calls.filter(([m]) => m === "chat.postMessage"),
  ).toHaveLength(1);
  expect(f.store.list("homeLaunch")[0].offer).toBe("uncertain");
  const d = f.store.list("homeLaunch")[0];
  f.store.put("homeLaunch", d.id, { ...d, offer: "sending" });
  new Store((f.store as any).db);
  expect(f.store.get("homeLaunch", d.id)?.offer).toBe("uncertain");
});
it("offers a picker for a fresh owner DM but ignores foreign owners and stale messages", async () => {
  const f = await fixture();
  const event = {
    type: "event_callback",
    team_id: identity.team,
    api_app_id: identity.app,
    event_id: "DM",
    event: {
      type: "message",
      channel: "D123456",
      user: "U123456",
      ts: stamp(),
      text: "<@U999999> Review",
    },
  };
  await f.receive({
    ...event,
    event: { ...event.event, user: "U222222" },
  } as any);
  expect(f.store.list("homeLaunch")).toHaveLength(0);
  await f.receive(event as any);
  await f.bridge.home.tick();
  expect(f.store.list("homeLaunch")[0]).toMatchObject({
    offer: "sent",
    task: "Review",
  });
});

it("a bare app mention offers a task form in a connected channel and shows status in an existing task", async () => {
  const f = await fixture();
  const bare = body("", "bare");
  await f.receive(bare);
  await f.bridge.home.tick();
  expect(f.store.list("homeLaunch")[0]).toMatchObject({
    task: "",
    offer: "sent",
  });
  expect(f.spawn).not.toHaveBeenCalled();
  const d = f.store.list("homeLaunch")[0];
  await f.receive({
    type: "block_actions",
    team: { id: identity.team },
    api_app_id: identity.app,
    user: { id: "U123456" },
    trigger_id: "t",
    container: { channel_id: d.callerChannel, message_ts: d.offerTs },
    message: { thread_ts: d.replyRoot },
    actions: [{ action_id: "launch_here", value: d.id }],
  } as any);
  const opened = f.call.mock.calls
    .filter(([m]) => m === "views.open")
    .at(-1)![1].view;
  expect(
    opened.blocks.find((b: any) => b.block_id === "project").element
      .initial_option.value,
  ).toBe("p1");
  const view = await slash(f);
  await f.receive(submit(view) as any);
  await drain(f);
  const b = f.store.list("binding")[0];
  const status = body("", "bare-status", b.root);
  status.event.channel = b.channel;
  await f.receive(status);
  await f.bridge.tick();
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.store.get("receipt", "bare-status")?.state).toBe("settled");
});

it("ignores stale or oversized unconnected mention invitations", async () => {
  const f = await fixture();
  for (const [id, ts, text] of [
    ["old", "1000000000.000000", "Review"],
    ["future", `${Math.floor(Date.now() / 1000) + 400}.123456`, "Review"],
    ["oversized", stamp(), "x".repeat(2001)],
  ]) {
    const m = body(text, id);
    m.event.channel = "C222222";
    m.event.ts = ts;
    await f.receive(m);
  }
  expect(f.store.list("homeLaunch")).toHaveLength(0);
  expect(f.spawn).not.toHaveBeenCalled();
});
