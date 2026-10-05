import { afterEach, describe, expect, it, vi } from "vitest";
import {
  body,
  identity,
  internal,
  route,
  setup,
  stamp,
} from "../test/helpers.js";
import {
  homeLink,
  homeView,
  launchView,
  destinationBlock,
  connectView,
} from "./home-view.js";
import { Bridge } from "./bridge.js";
import type { Binding } from "./model.js";
const fixtures: ReturnType<typeof setup>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = setup();
  fixtures.push(f);
  await f.connect();
  await f.bridge.home.publish(true);
  return f;
}
const publications = (f: ReturnType<typeof setup>) =>
  f.call.mock.calls.filter(([m]) => m === "views.publish");
const latest = (f: ReturnType<typeof setup>) => publications(f).at(-1)![1].view;
function action(f: ReturnType<typeof setup>, id: string, value?: string) {
  return {
    type: "block_actions",
    team: { id: identity.team },
    api_app_id: identity.app,
    user: { id: "U123456" },
    trigger_id: "123.456.trigger",
    view: { ...latest(f), id: "V123456" },
    actions: [{ action_id: id, value, action_ts: stamp() }],
  };
}
async function draft(f: ReturnType<typeof setup>) {
  await f.receive(action(f, "home_new") as any);
  return {
    ...f.call.mock.calls.filter(([m]) => m === "views.open").at(-1)![1].view,
    id: "V654321",
  };
}
function submission(
  view: any,
  task = "Say hello",
  channel = route.channel,
  project = route.projectId,
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
          project: { launch_project: { selected_option: { value: project } } },
          [destinationBlock(project)]: {
            channel: { selected_option: { value: channel } },
          },
          task: { prompt: { value: task } },
        },
      },
    },
  };
}
async function submitted(f: ReturnType<typeof setup>) {
  const view = await draft(f);
  await f.receive(submission(view) as any);
  return view.private_metadata as string;
}
async function launch(f: ReturnType<typeof setup>) {
  const id = await submitted(f);
  await f.bridge.home.tick();
  await f.bridge.flush();
  await f.bridge.home.tick();
  await f.bridge.tick();
  return { id, binding: f.store.list("binding")[0] };
}
describe("Slack Home", () => {
  it("lists only connected Projects, including those with no conversations, and bounds a large dashboard", async () => {
    const f = await fixture();
    (f.zcc.sdk.projects.list as any).mockResolvedValue([
      { id: "p1", name: "Connected" },
      { id: "private", name: "PRIVATE LOCAL PROJECT" },
    ]);
    await f.bridge.home.publish(true);
    const text = JSON.stringify(latest(f));
    expect(text).toContain('"text":"Projects"');
    expect(text).toContain("Connected\\n#agent-work");
    expect(text).toContain("home_project_new");
    expect(text).toContain("Connect another Project");
    expect(text).not.toContain("PRIVATE LOCAL PROJECT");
    const routes = Array.from({ length: 20 }, (_, i) => ({
      ...route,
      projectId: `p${i}`,
      channel: `C1234${i}`,
    }));
    const view = homeView({
      config: { ...f.bridge.config, routes },
      projects: [],
      bindings: [],
      deliveries: [],
      launches: [],
      project: "",
      token: "t",
    });
    expect(JSON.stringify(view)).toContain("Showing 8 of 20 Projects");
    expect(
      view.blocks.filter((b) => b.accessory?.action_id === "home_project_new"),
    ).toHaveLength(8);
    f.bridge.config.routes = [];
    await f.bridge.home.publish(true);
    expect(JSON.stringify(latest(f))).toContain("No Projects connected yet");
    expect(JSON.stringify(latest(f))).not.toContain('"action_id":"home_new"');
  });
  it("opens setup from Home even with no routes, without connecting or launching anything", async () => {
    const f = await fixture();
    f.bridge.config.routes = [];
    await f.receive(action(f, "home_connect") as any);
    const view = f.call.mock.calls
      .filter(([m]) => m === "views.open")
      .at(-1)![1].view;
    expect(view.callback_id).toBe("zana_connect_project");
    expect(JSON.stringify(view)).toContain(
      "/extensions/plugins/slack-bridge-2ff2?view=installed&setup=connect#plugin-configure",
    );
    expect(f.bridge.config.routes).toEqual([]);
    expect(f.store.list("homeLaunch")).toHaveLength(0);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(JSON.stringify(connectView())).not.toContain('"url"');
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (m, a) =>
      m === "views.open" ? { ok: false } : original(m, a),
    );
    await f.receive(action(f, "home_connect") as any);
    await f.bridge.home.publish(true);
    expect(JSON.stringify(latest(f))).toContain("Open Zana → Zana for Slack");
  });
  it("separates Project and channel choices, supports several channels and preserves the task input id", async () => {
    const f = await fixture();
    f.bridge.config.routes = [
      route,
      { ...route, channel: "C222222", name: "other" },
      { ...route, projectId: "p2", channel: "C333333", name: "second" },
      { ...route, projectId: "unready", channel: "C444444", model: "" },
    ];
    await f.bridge.home.publish(true);
    const view = await draft(f);
    const get = (v: any, id: string) =>
      v.blocks.find((b: any) => b.block_id === id);
    expect(get(view, "project").element.options).toHaveLength(2);
    expect(get(view, "project").element.initial_option).toBeUndefined();
    expect(
      view.blocks.some((b: any) => b.label?.text === "Slack channel"),
    ).toBe(false);
    const p = {
      ...action(f, "launch_project"),
      view: { ...view, hash: "h1" },
      actions: [
        { action_id: "launch_project", selected_option: { value: "p1" } },
      ],
    };
    await f.receive(p as any);
    const update = f.call.mock.calls
      .filter(([m]) => m === "views.update")
      .at(-1)![1];
    expect(update).toMatchObject({ view_id: "V654321", hash: "h1" });
    expect(
      get(update.view, destinationBlock("p1")).element.options.map(
        (o: any) => o.value,
      ),
    ).toEqual([route.channel, "C222222"]);
    expect(
      get(update.view, destinationBlock("p1")).element.initial_option,
    ).toBeUndefined();
    expect(get(update.view, "task")).toEqual(get(view, "task"));
    p.actions[0].selected_option.value = "p2";
    await f.receive(p as any);
    const second = f.call.mock.calls
      .filter(([m]) => m === "views.update")
      .at(-1)![1].view;
    expect(get(second, destinationBlock("p1"))).toBeUndefined();
    expect(
      get(second, destinationBlock("p2")).element.initial_option.value,
    ).toBe("C333333");
    const rejected = await f.receive(
      submission(
        { ...second, id: "V654321" },
        "hello",
        route.channel,
        "p2",
      ) as any,
    );
    expect(rejected).toHaveBeenCalledWith({
      response_action: "errors",
      errors: { [destinationBlock("p2")]: expect.any(String) },
    });
    await f.receive(
      submission({ ...second, id: "V654321" }, "hello", "C333333", "p2") as any,
    );
    expect(
      f.store.get("homeLaunch", view.private_metadata)?.route?.projectId,
    ).toBe("p2");
  });
  it("preselects a Project from its Home row and rejects forged shortcuts", async () => {
    const f = await fixture();
    f.bridge.config.routes.push({
      ...route,
      projectId: "p2",
      channel: "C333333",
      name: "second",
    });
    await f.receive(action(f, "home_project_new", "p2") as any);
    const view = f.call.mock.calls
      .filter(([m]) => m === "views.open")
      .at(-1)![1].view;
    expect(
      view.blocks.find((b: any) => b.block_id === "project").element
        .initial_option.value,
    ).toBe("p2");
    expect(JSON.stringify(view)).not.toContain("#agent-work");
    const count = f.call.mock.calls.filter(([m]) => m === "views.open").length;
    await f.receive(action(f, "home_project_new", "unknown") as any);
    expect(f.call.mock.calls.filter(([m]) => m === "views.open")).toHaveLength(
      count,
    );
  });
  it("validates modal updates and keeps failed updates from launching anything", async () => {
    const f = await fixture(),
      view = await draft(f);
    const p = {
      ...action(f, "launch_project"),
      view: { ...view, hash: "hash" },
      actions: [
        { action_id: "launch_project", selected_option: { value: "p1" } },
      ],
    };
    for (const invalid of [
      { ...p, user: { id: "someone-else" } },
      { ...p, view: { ...p.view, id: "wrong-view" } },
      { ...p, view: { ...p.view, private_metadata: "unknown" } },
      { ...p, view: { ...p.view, hash: undefined } },
      {
        ...p,
        actions: [
          {
            action_id: "launch_project",
            selected_option: { value: "unknown" },
          },
        ],
      },
    ])
      await f.receive(invalid as any);
    expect(f.call.mock.calls.some(([m]) => m === "views.update")).toBe(false);
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (m, a) =>
      m === "views.update"
        ? { ok: false, error: "hash_conflict" }
        : original(m, a),
    );
    await f.receive(p as any);
    await f.bridge.home.publish(true);
    expect(JSON.stringify(latest(f))).toContain(
      "Project picker could not update",
    );
    await f.receive({
      ...p,
      actions: [{ action_id: "launch_connect" }],
    } as any);
    expect(f.call.mock.calls.some(([m]) => m === "views.push")).toBe(true);
    const old = submission(view);
    delete (old.view.state.values as any).project;
    expect(await f.receive(old as any)).toHaveBeenCalledWith({
      response_action: "errors",
      errors: { task: expect.stringContaining("older form") },
    });
    f.bridge.config.routes[0].model = "revoked";
    const count = f.call.mock.calls.filter(
      ([m]) => m === "views.update",
    ).length;
    await f.receive(p as any);
    expect(
      f.call.mock.calls.filter(([m]) => m === "views.update"),
    ).toHaveLength(count);
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("rechecks the owner after an action ACK before opening a form", async () => {
    const f = await fixture();
    await f.bridge.receive(action(f, "home_new"), async () => {
      f.bridge.config.owner = "U654321";
    });
    expect(f.call.mock.calls.some(([method]) => method === "views.open")).toBe(
      false,
    );
    expect(f.store.list("homeLaunch")).toHaveLength(0);
  });

  it("shows the outcome of a failed repeated submission and permits explicit review without retry", async () => {
    const f = await fixture(),
      view = await draft(f);
    await f.receive(submission(view) as any);
    await f.bridge.home.tick();
    const id = view.private_metadata,
      delivery = f.store.get("delivery", `home-root:${id}`)!;
    f.store.put("delivery", delivery.id, { ...delivery, state: "uncertain" });
    await f.bridge.home.tick();
    const ack = await f.receive(submission(view) as any);
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({
        view: expect.objectContaining({
          title: expect.objectContaining({ text: "Request status" }),
        }),
      }),
    );
    f.bridge.home.dismiss(id);
    expect(f.store.get("delivery", delivery.id)?.state).toBe("reviewed");
    expect(f.store.get("homeLaunch", id)?.state).toBe("settled");
    expect(() => f.bridge.home.dismiss(id)).toThrow("No Home request");
    await f.bridge.home.tick();
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it.each([
    "https://outside.example/archives/C123456/p123",
    "not-a-url",
    "https://demo.slack.com/archives/other/p123",
  ])(
    "rejects untrusted permalink %s while preserving the agent",
    async (permalink) => {
      const f = await fixture(),
        original = f.call.getMockImplementation()!;
      f.call.mockImplementation(async (m, a) =>
        m === "chat.getPermalink" ? { ok: true, permalink } : original(m, a),
      );
      const { binding } = await launch(f);
      expect(binding.slackUrl).toBeUndefined();
      expect(f.spawn).toHaveBeenCalledTimes(1);
      expect(binding.state).toBe("running");
    },
  );

  it("publishes a private bounded empty dashboard, coalesces updates and links to Home", async () => {
    const f = await fixture();
    expect(publications(f)[0][1].user_id).toBe("U123456");
    expect(JSON.stringify(latest(f))).toContain("Your next task starts here");
    expect(JSON.stringify(latest(f))).toContain("saved snapshot");
    await f.bridge.home.publish();
    expect(publications(f)).toHaveLength(1);
    expect(homeLink(f.bridge.config)).toContain("tab=home");
    expect(homeLink({ enabled: false, routes: [] })).toBeUndefined();
    const snap = (await f.bridge.snapshot()) as any;
    expect(snap.home.lastPublished).toBeTypeOf("number");
  });
  it("validates owner, installation, view provenance and event tab without exposing data", async () => {
    const f = await fixture();
    for (const patch of [
      { user: { id: "U654321" } },
      { team: { id: "T654321" } },
      { api_app_id: "A654321" },
      { view: { ...latest(f), id: "foreign" } },
    ]) {
      const ack = await f.receive({
        ...action(f, "home_new"),
        ...patch,
      } as any);
      expect(ack).toHaveBeenCalled();
    }
    expect(f.call.mock.calls.some(([m]) => m === "views.open")).toBe(false);
    for (const tab of ["home", "messages"]) {
      await f.receive({
        type: "event_callback",
        team_id: identity.team,
        api_app_id: identity.app,
        event: { type: "app_home_opened", user: "U123456", tab },
      } as any);
    }
    expect(f.spawn).not.toHaveBeenCalled();
    await f.receive({
      ...action(f, "home_refresh"),
      extra: "a".repeat(256 * 1024),
    } as any);
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("opens a destination-aware modal, persists before ACK, and launches once after confirmed root delivery", async () => {
    const f = await fixture();
    const view = await draft(f);
    expect(view.blocks[1].element.options[0].text.text).toContain("Project");
    expect(JSON.stringify(view)).toContain("Members of this channel can see");
    const request = submission(view, "help");
    const ack = vi.fn(async () => {
      expect(f.store.get("homeLaunch", view.private_metadata)?.state).toBe(
        "queued",
      );
      expect(f.spawn).not.toHaveBeenCalled();
    });
    await f.bridge.receive(request, ack);
    expect(ack).toHaveBeenCalledWith({
      response_action: "update",
      view: expect.objectContaining({
        title: expect.objectContaining({ text: "Request queued" }),
      }),
    });
    await f.receive(request as any);
    await f.bridge.home.tick();
    expect(f.spawn).not.toHaveBeenCalled();
    await f.bridge.flush();
    await f.bridge.home.tick();
    await f.bridge.tick();
    await f.bridge.tick();
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "help",
        model: route.model,
        projectId: route.projectId,
      }),
    );
    expect(f.store.list("binding")[0].slackUrl).toContain(
      "https://demo.slack.com/archives/",
    );
    expect(f.store.list("binding")[0].root).toBe(
      f.store.get("delivery", `home-root:${view.private_metadata}`)?.ts,
    );
    expect(f.store.get("homeLaunch", view.private_metadata)?.state).toBe(
      "settled",
    );
  });
  it("returns inline errors for invalid, expired, changed and unknown forms", async () => {
    const f = await fixture(),
      view = await draft(f);
    for (const [task, channel, block] of [
      [" ", route.channel, "task"],
      ["x".repeat(2001), route.channel, "task"],
      ["hello", "C999999", destinationBlock("p1")],
    ]) {
      const ack = await f.receive(submission(view, task, channel) as any);
      expect(ack).toHaveBeenCalledWith({
        response_action: "errors",
        errors: { [block]: expect.any(String) },
      });
    }
    let ack = await f.receive(
      submission({ ...view, private_metadata: "missing" }) as any,
    );
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({ response_action: "errors" }),
    );
    f.bridge.config.routes[0].model = "changed";
    ack = await f.receive(submission(view) as any);
    expect(ack).toHaveBeenCalledWith({
      response_action: "errors",
      errors: { [destinationBlock("p1")]: expect.any(String) },
    });
    const d = f.store.get("homeLaunch", view.private_metadata)!;
    f.store.put("homeLaunch", d.id, { ...d, expires: 1 });
    ack = await f.receive(submission(view) as any);
    expect(ack).toHaveBeenCalledWith({
      response_action: "errors",
      errors: { task: expect.stringContaining("expired") },
    });
    ack = await f.receive({
      ...submission(view),
      user: { id: "U654321" },
    } as any);
    expect(ack).toHaveBeenCalledWith({ response_action: "clear" });
  });
  it("does not ACK an unpersisted submission", async () => {
    const f = await fixture(),
      view = await draft(f),
      ack = vi.fn(async () => {});
    const put = vi.spyOn(f.store, "put").mockImplementation(() => {
      throw new Error("Disk full");
    });
    await expect(f.bridge.receive(submission(view), ack)).rejects.toThrow(
      "Disk full",
    );
    expect(ack).not.toHaveBeenCalled();
    put.mockRestore();
  });
  it("rejects revoked destinations before posting and again before launch", async () => {
    const f = await fixture(),
      id = await submitted(f);
    await f.bridge.home.tick();
    f.bridge.config.routes[0].summaries = true;
    await f.bridge.flush();
    expect(f.store.get("delivery", `home-root:${id}`)?.state).toBe("failed");
    await f.bridge.home.tick();
    expect(f.store.get("homeLaunch", id)?.state).toBe("rejected");
    expect(f.spawn).not.toHaveBeenCalled();
    const view = await draft(f);
    await f.receive(submission(view) as any);
    await f.bridge.home.tick();
    await f.bridge.flush();
    await f.bridge.home.tick();
    f.bridge.config.routes[0].model = "changed";
    await f.bridge.tick();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.store.get("receipt", `home:${view.private_metadata}`)?.state).toBe(
      "rejected",
    );
  });
  it("does not launch on uncertain posts, shared channels, owner change or restart replay", async () => {
    const f = await fixture(),
      id = await submitted(f);
    await f.bridge.home.tick();
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (m, a) => {
      if (m === "chat.postMessage") throw new Error("lost response");
      return original(m, a);
    });
    await f.bridge.flush();
    await f.bridge.home.tick();
    expect(f.store.get("homeLaunch", id)?.state).toBe("needs-review");
    expect(f.spawn).not.toHaveBeenCalled();
    await f.bridge.home.tick();
    expect(
      f.call.mock.calls.filter(([m]) => m === "chat.postMessage"),
    ).toHaveLength(1);
    f.call.mockImplementation(async (m, a) =>
      m === "conversations.info"
        ? { ok: true, channel: { ...internal, is_shared: true } }
        : original(m, a),
    );
    const next = await submitted(f);
    await f.bridge.home.tick();
    (f.bridge as any).channelNext.clear();
    await f.bridge.flush();
    await f.bridge.home.tick();
    expect(f.store.get("homeLaunch", next)?.state).toBe("needs-review");
    const third = await submitted(f);
    f.bridge.config.owner = "U654321";
    await f.bridge.home.tick();
    expect(f.store.get("homeLaunch", third)?.state).toBe("rejected");
  });
  it("reuses durable receipts after reload and blocks old view actions", async () => {
    const f = await fixture(),
      { id } = await launch(f),
      oldAction = action(f, "home_new");
    const restarted = new Bridge(f.zcc, f.store, f.settings, () => f.slack);
    await restarted.connect();
    await restarted.home.tick();
    await restarted.tick();
    expect(f.spawn).toHaveBeenCalledTimes(1);
    const opens = f.call.mock.calls.filter(([m]) => m === "views.open").length;
    await restarted.receive(oldAction, async () => {});
    expect(f.call.mock.calls.filter(([m]) => m === "views.open")).toHaveLength(
      opens,
    );
    expect(f.store.get("receipt", `home:${id}`)).toBeTruthy();
    await restarted.dispose();
  });
  it("routes Home mute/unmute/stop through the existing durable authorization path", async () => {
    const f = await fixture(),
      { binding } = await launch(f);
    for (const id of ["home_mute", "home_unmute", "home_stop"]) {
      const p = action(f, id, binding.key);
      await f.receive(p as any);
      await f.receive(p as any);
      await f.bridge.tick();
      if (id === "home_mute")
        expect(f.store.get("binding", binding.key)?.paused).toBe(true);
      if (id === "home_unmute")
        expect(f.store.get("binding", binding.key)?.paused).toBe(false);
    }
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.store.get("binding", binding.key)?.state).toBe("stopped");
    await f.receive(action(f, "home_stop", "nonexistent") as any);
    await f.receive(action(f, "home_local") as any);
    expect(f.stop).toHaveBeenCalledTimes(1);
  });
  it("handles Home and modal failures with backoff while keeping intake available", async () => {
    const f = await fixture(),
      original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (m, a) =>
      m === "views.open" ? { ok: false } : original(m, a),
    );
    await draft(f);
    await f.bridge.home.publish(true);
    expect(JSON.stringify(latest(f))).toContain("could not open");
    f.call.mockImplementation(async (m, a) =>
      m === "views.publish"
        ? Promise.reject({ retryAfter: 60 })
        : original(m, a),
    );
    await f.bridge.home.publish(true);
    expect(f.bridge.home.error).toContain("Home could not update");
    const count = publications(f).length;
    await f.bridge.home.tick();
    expect(publications(f)).toHaveLength(count);
    await f.receive(body());
    await f.bridge.tick();
    expect(f.spawn).toHaveBeenCalledTimes(1);
    await f.bridge.disconnect();
    await f.bridge.home.tick();
  });
  it("filters Projects and bounds sections without showing other installations or archived history", async () => {
    const f = await fixture();
    const routes = [
      route,
      { ...route, projectId: "p2", channel: "C654321", name: "second" },
    ];
    f.bridge.config.routes = routes;
    const bindings: Binding[] = Array.from({ length: 30 }, (_, i) => ({
      ...identity,
      key: `key${i}`,
      channel: route.channel,
      root: stamp(),
      projectId: "p1",
      hostId: "h1",
      providerId: "codex",
      threadId: `th${i}`,
      title: `Task ${i}`,
      state: i < 10 ? "running" : i < 20 ? "failed" : "idle",
      needsAttention: i === 0,
      active: i < 10 ? `r${i}` : undefined,
      lastRequest: `r${i}`,
      paused: i === 2,
      updated: Date.now(),
    }));
    const view = homeView({
      config: { ...f.bridge.config, routes },
      bindings: [
        ...bindings,
        { ...bindings[0], team: "other", title: "SECRET" },
        { ...bindings[0], state: "archived", title: "ARCHIVED" },
      ],
      deliveries: [{ id: "answer:r20", state: "sent" } as any],
      launches: [],
      projects: [
        { id: "p1", name: "One" },
        { id: "p2", name: "Two" },
      ],
      project: "",
      token: "token",
    });
    expect(view.blocks.length).toBeLessThan(100);
    const text = JSON.stringify(view);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("ARCHIVED");
    expect(text).toContain("Showing 6");
    expect(text).toContain("Answer delivered");
    expect(text).toContain("confirm");
    const p = action(f, "home_project");
    (p.actions[0] as any).selected_option = { value: "p2" };
    await f.receive(p as any);
    await f.bridge.home.publish(true);
    expect(JSON.stringify(latest(f))).toContain('"value":"p2"');
    (p.actions[0] as any).selected_option = { value: "forged" };
    await f.receive(p as any);
    (p.actions[0] as any).selected_option = { value: "all" };
    await f.receive(p as any);
    await f.receive(action(f, "home_refresh") as any);
  });
  it("caps forms and queue, prunes expired drafts, and reports queue failures", async () => {
    const f = await fixture(),
      view = await draft(f),
      d = f.store.get("homeLaunch", view.private_metadata)!;
    for (let i = 0; i < 50; i++)
      f.store.put("homeLaunch", `d${i}`, { ...d, id: `d${i}` });
    const before = f.call.mock.calls.filter(([m]) => m === "views.open").length;
    await f.receive(action(f, "home_new") as any);
    expect(f.call.mock.calls.filter(([m]) => m === "views.open")).toHaveLength(
      before,
    );
    for (let i = 0; i < 100; i++)
      f.store.put("homeLaunch", `q${i}`, {
        ...d,
        id: `q${i}`,
        state: "needs-review",
      });
    expect(await f.receive(submission(view) as any)).toHaveBeenCalledWith({
      response_action: "errors",
      errors: { task: expect.stringContaining("queue") },
    });
    f.store.prune(Date.now() + 31 * 86400000);
    expect(f.store.list("homeLaunch")).toHaveLength(0);
    const id = await submitted(f);
    const put = vi.spyOn(f.store, "put");
    // Use the actual outbox capacity guard.
    for (let i = 0; i < 500; i++)
      f.store.put("delivery", `d${i}`, {
        id: `d${i}`,
        key: "x",
        channel: route.channel,
        root: "",
        text: "x",
        state: "uncertain",
        created: Date.now(),
        next: 0,
        attempts: 1,
        note: "",
      });
    await f.bridge.home.tick();
    expect(f.store.get("homeLaunch", id)?.state).toBe("rejected");
    put.mockRestore();
    expect(launchView({ ...d, routes: [] }, []).blocks).toBeTruthy();
  });
});

it("rejects stale launch forms and hides launch buttons after local access is disabled", async () => {
  const f = await fixture();
  const view = await draft(f);
  f.bridge.config.slackAccess = { launch: false };
  const ack = await f.receive(submission(view) as any);
  expect(JSON.stringify(ack.mock.calls)).toContain("What Slack can do");
  expect(f.store.list("homeLaunch", ["queued"])).toHaveLength(0);
  await f.bridge.home.publish(true);
  expect(JSON.stringify(latest(f))).not.toContain('"action_id":"home_new"');
  await f.receive(action(f, "home_new") as any);
  expect(f.store.list("homeLaunch")).toHaveLength(1);
  expect(f.spawn).not.toHaveBeenCalled();
});
it("redacts progress and Project browsing in Home while keeping conversation controls", async () => {
  const f = await fixture();
  await launch(f);
  f.bridge.config.slackAccess = { projects: false, status: false };
  await f.bridge.home.publish(true);
  const text = JSON.stringify(latest(f));
  expect(text).not.toContain('"action_id":"home_project_new"');
  expect(text).not.toContain("🟢");
  expect(text).not.toContain('"text":"Running"');
  expect(text).toContain("Conversation controls");
  expect(text).toContain("home_stop");
  expect(text).toContain("home_mute");
});
