import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setup,
  body,
  route,
  internal,
  identity,
  stamp,
} from "../test/helpers.js";
import { Bridge } from "./bridge.js";
import { homeView, bindingRoute } from "./home-view.js";
const fixtures: ReturnType<typeof setup>[] = [];
const fixture = async () => {
  const f = setup();
  fixtures.push(f);
  await f.connect();
  return f;
};
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
  vi.restoreAllMocks();
});
async function run(
  f: Awaited<ReturnType<typeof fixture>>,
  text = "run hello",
  id = "Ev1",
  root = stamp(),
) {
  await f.receive(body(text, id, root));
  await f.bridge.tick();
  return root;
}

describe("Slack admission and thread control", () => {
  it("launches a full-only provider and rejects providers without a supported mode before spawning", async () => {
    for (const permissionModes of [["full"], ["auto", "full"], []]) {
      const f = await fixture();
      vi.mocked(f.zcc.sdk.providers.list).mockResolvedValue([
        { id: "pi", available: true, capabilities: { permissionModes } },
      ]);
      f.bridge.config.routes = [{ ...route, providerId: "pi" }];
      await run(f);
      if (!permissionModes.length) {
        expect(f.spawn).not.toHaveBeenCalled();
        expect(f.store.get("receipt", "Ev1")).toMatchObject({
          state: "rejected",
          note: expect.stringContaining("permission mode"),
        });
      } else {
        expect(f.spawn).toHaveBeenCalledWith(
          expect.objectContaining({
            providerId: "pi",
            permissionMode: permissionModes[0],
          }),
        );
      }
    }
  });
  it("decodes Slack's three entities once before dispatching an owner mention", async () => {
    const f = await fixture();
    await run(
      f,
      'run if (a &lt; 3 &amp;&amp; a &gt; 0) return "a &amp; b"; &amp;lt; &quot;',
    );
    expect(f.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'if (a < 3 && a > 0) return "a & b"; &lt; &quot;',
      }),
    );
  });
  it("persists before ACK, deduplicates deliveries, launches and follows up in the same thread", async () => {
    const f = await fixture();
    const root = stamp();
    const ack = await f.receive(body("run review tests", "Ev1", root));
    expect(ack).toHaveBeenCalledOnce();
    expect(f.store.get("receipt", "Ev1")?.state).toBe("received");
    expect(f.spawn).not.toHaveBeenCalled();
    await f.bridge.tick();
    expect(f.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        hostId: "h1",
        permissionMode: "accept-edits",
        model: "demo-model",
        prompt: "review tests",
        pluginMetadata: expect.any(Object),
      }),
    );
    await f.receive(body("run review tests", "Ev1", root));
    await f.bridge.tick();
    expect(f.spawn).toHaveBeenCalledOnce();
    await run(f, "also check errors", "Ev2", root);
    expect(f.send).not.toHaveBeenCalled();
    f.threads.get("th1").status = "idle";
    await f.bridge.event({ name: "thread.idle", threadId: "th1" });
    await f.bridge.tick();
    expect(f.send).toHaveBeenCalledWith({
      threadId: "th1",
      prompt: "also check errors",
      mode: "start",
    });
    await run(f, "stop", "Ev3", root);
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.store.list("binding")[0].state).toBe("stopped");
    expect(f.store.get("receipt", "Ev2")?.state).toBe("settled");
  });
  it("rejects unknown owners, wrong apps, stale events and unsafe channels; offers a form for a bare mention", async () => {
    const f = await fixture();
    await f.receive(body("run x", "bad", stamp(), "U654321"));
    await f.receive({ ...body(), api_app_id: "A654321" });
    expect(f.store.list("receipt")).toHaveLength(0);
    await run(f, "");
    expect(f.store.get("receipt", "Ev1")).toBeUndefined();
    expect(f.store.get("homeLaunch", "mention:Ev1")?.task).toBe("");
    const old = body("run x", "old");
    old.event.ts = "1000000000.000000";
    await f.receive(old);
    expect(f.store.get("receipt", "old")?.note).toContain("expired");
    f.call.mockImplementation(async () => ({
      channel: { ...internal, is_ext_shared: true },
    }));
    await run(f, "run x", "shared");
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.store.get("receipt", "shared")?.state).toBe("rejected");
  });
  it("links only the challenged member once, never using bot auth identity as owner", async () => {
    const f = await fixture();
    f.bridge.config.owner = undefined;
    const { code } = f.bridge.pair("U123456");
    expect(() => f.bridge.pair("bad")).toThrow();
    await run(f, "link wrong", "wrong");
    expect(f.bridge.config.owner).toBeUndefined();
    await run(f, `link ${code}`, "link");
    expect(f.bridge.config.owner).toBe("U123456");
    expect(f.store.get("receipt", "link")?.text).toBe("[Owner verification]");
    expect(() => f.bridge.pair("U123456")).toThrow();
    await f.bridge.resetOwner();
    expect(f.bridge.config.routes).toEqual([]);
    expect(f.bridge.connection).toBe("Disconnected");
  });
  it("rejects an expired challenge and guest accounts", async () => {
    const f = await fixture();
    f.bridge.config.owner = undefined;
    let { code } = f.bridge.pair("U123456");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60000);
    await run(f, `link ${code}`);
    expect(f.bridge.config.owner).toBeUndefined();
    vi.restoreAllMocks();
    ({ code } = f.bridge.pair("U123456"));
    f.call.mockImplementation(async (method) =>
      method === "users.info"
        ? {
            user: {
              id: "U123456",
              team_id: identity.team,
              is_bot: false,
              deleted: false,
              is_restricted: true,
              is_ultra_restricted: false,
            },
          }
        : { channel: internal },
    );
    await run(f, `link ${code}`, "guest");
    expect(f.bridge.config.owner).toBeUndefined();
  });
  it("validates mapping against registered resources and live Slack channel classification", async () => {
    const f = await fixture();
    await expect(
      f.bridge.addRoute({ ...route, projectId: "unknown" }),
    ).rejects.toThrow("registered");
    await expect(
      f.bridge.addRoute({ ...route, channel: "bad" }),
    ).rejects.toThrow();
    await f.bridge.addRoute({ ...route, summaries: true });
    expect(f.bridge.config.routes[0].summaries).toBe(true);
    f.call.mockResolvedValue({ channel: { ...internal, is_shared: true } });
    await expect(f.bridge.addRoute(route)).rejects.toThrow("unshared");
    f.bridge.removeRoute(route.channel);
    expect(f.bridge.config.routes).toEqual([]);
  });
  it("imports only selected Projects and preserves manual mappings", async () => {
    const f = await fixture();
    vi.mocked(f.zcc.sdk.projects.list).mockResolvedValue([
      { id: "p1", name: "Project" },
      { id: "p2", name: "Website App" },
    ]);
    const original = f.call.getMockImplementation()!;
    const names = new Map<string, string>();
    let created = 0;
    f.call.mockImplementation(async (method, args) => {
      if (method === "conversations.create") {
        const id = created++ === 0 ? "G123457" : "G234567";
        names.set(id, args.name);
        return { ok: true, channel: { id, name: args.name } };
      }
      if (method === "conversations.invite") return { ok: true };
      if (method === "conversations.info" && names.has(args.channel))
        return {
          ok: true,
          channel: {
            ...internal,
            id: args.channel,
            name: names.get(args.channel),
            is_private: true,
          },
        };
      return original(method, args);
    });
    await f.bridge.configureProjectSync({
      enabled: true,
      hostId: route.hostId,
      providerId: route.providerId,
      model: route.model,
      summaries: true,
    });
    expect(
      f.call.mock.calls.some(([method]) => method === "conversations.create"),
    ).toBe(false);
    const result = await f.bridge.importProjects({ projectIds: ["p1", "p2"] });
    expect(result).toMatchObject({ state: "complete", created: 2 });
    expect(
      f.call.mock.calls.filter(([method]) => method === "conversations.create"),
    ).toHaveLength(2);
    expect(f.call).toHaveBeenCalledWith(
      "conversations.create",
      expect.objectContaining({
        name: "zana-website-app",
        is_private: true,
      }),
    );
    expect(f.call).toHaveBeenCalledWith("conversations.invite", {
      channel: "G234567",
      users: "U123456",
    });
    expect(f.bridge.config.routes).toContainEqual(
      expect.objectContaining({
        channel: "G234567",
        projectId: "p2",
        hostId: route.hostId,
        providerId: route.providerId,
        model: route.model,
        summaries: true,
      }),
    );
    expect(f.bridge.config.routes).toContainEqual(route);
    expect(f.bridge.config.projectSync?.pending).toEqual([]);
    expect(f.bridge.config.projectSync?.channels).toHaveLength(2);
  });
  it("uses a custom prefix and adds a stable suffix only after a Slack name collision", async () => {
    const f = await fixture();
    vi.mocked(f.zcc.sdk.projects.list).mockResolvedValue([
      { id: "p2", name: "Website App" },
    ]);
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (method, args) => {
      if (
        method === "conversations.create" &&
        args.name === "team-one-zana-website-app"
      )
        return { ok: false, error: "name_taken" };
      if (method === "conversations.create")
        return { ok: true, channel: { id: "G234567", name: args.name } };
      if (method === "conversations.invite") return { ok: true };
      if (method === "conversations.info" && args.channel === "G234567")
        return {
          ok: true,
          channel: {
            ...internal,
            id: "G234567",
            name: "team-one-zana-website-app-3946ca",
            is_private: true,
          },
        };
      return original(method, args);
    });
    await expect(
      f.bridge
        .configureProjectSync({
          enabled: true,
          channelPrefix: "Team One",
          hostId: route.hostId,
          providerId: route.providerId,
          model: route.model,
          summaries: true,
        })
        .then(() => f.bridge.importProjects({ projectIds: ["p2"] })),
    ).resolves.toMatchObject({ state: "complete", created: 1 });
    expect(f.bridge.config.projectSync?.channelPrefix).toBe("team-one");
    expect(
      f.call.mock.calls
        .filter(([method]) => method === "conversations.create")
        .map(([, args]) => args.name),
    ).toEqual([
      "team-one-zana-website-app",
      "team-one-zana-website-app-3946ca",
    ]);
  });
  it("renames legacy managed channels to the clean current prefix without touching manual mappings", async () => {
    const f = await fixture();
    vi.mocked(f.zcc.sdk.projects.list).mockResolvedValue([
      { id: "p2", name: "Website App" },
    ]);
    const managedRoute = {
      ...route,
      channel: "G234567",
      name: "zana-website-app-3946ca",
      projectId: "p2",
    };
    f.bridge.config.routes = [route, managedRoute];
    f.bridge.config.projectSync = {
      enabled: true,
      hostId: route.hostId,
      providerId: route.providerId,
      model: route.model,
      summaries: true,
      channels: [
        {
          projectId: "p2",
          channel: "G234567",
          name: "zana-website-app-3946ca",
        },
      ],
    };
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (method, args) =>
      method === "conversations.rename"
        ? { ok: true, channel: { id: args.channel, name: args.name } }
        : original(method, args),
    );
    await expect(
      f.bridge.configureProjectSync({
        enabled: true,
        channelPrefix: "Team One",
        hostId: route.hostId,
        providerId: route.providerId,
        model: route.model,
        summaries: true,
      }),
    ).resolves.toMatchObject({
      state: "complete",
      created: 0,
      renamed: 1,
      remaining: 0,
    });
    expect(f.call).toHaveBeenCalledWith("conversations.rename", {
      channel: "G234567",
      name: "team-one-zana-website-app",
    });
    expect(f.bridge.config.routes).toContainEqual(route);
    expect(f.bridge.config.routes).toContainEqual(
      expect.objectContaining({
        channel: "G234567",
        name: "team-one-zana-website-app",
      }),
    );
  });
  it("keeps the stable suffix after Slack confirms the clean name is taken", async () => {
    const f = await fixture();
    vi.mocked(f.zcc.sdk.projects.list).mockResolvedValue([
      { id: "p2", name: "Website App" },
    ]);
    f.bridge.config.routes = [
      {
        ...route,
        channel: "G234567",
        name: "zana-website-app-3946ca",
        projectId: "p2",
      },
    ];
    f.bridge.config.projectSync = {
      enabled: true,
      hostId: route.hostId,
      providerId: route.providerId,
      model: route.model,
      summaries: true,
      channels: [
        {
          projectId: "p2",
          channel: "G234567",
          name: "zana-website-app-3946ca",
        },
      ],
    };
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (method, args) =>
      method === "conversations.rename"
        ? { ok: false, error: "name_taken" }
        : original(method, args),
    );
    await expect(f.bridge.syncProjects()).resolves.toMatchObject({
      state: "complete",
      created: 0,
      renamed: 0,
      remaining: 0,
    });
    expect(
      f.call.mock.calls.filter(([method]) => method === "conversations.rename"),
    ).toHaveLength(1);
    expect(f.bridge.config.projectSync?.channels?.[0]).toMatchObject({
      name: "zana-website-app-3946ca",
      prefix: "",
      collision: true,
    });
  });
  it("continues large Project sets in bounded batches", async () => {
    const f = await fixture();
    vi.mocked(f.zcc.sdk.projects.list).mockResolvedValue(
      Array.from({ length: 6 }, (_, index) => ({
        id: `project-${index + 1}`,
        name: `Project ${index + 1}`,
      })),
    );
    const original = f.call.getMockImplementation()!;
    const names = new Map<string, string>();
    let created = 0;
    f.call.mockImplementation(async (method, args) => {
      if (method === "conversations.create") {
        const id = `G${String(++created).padStart(6, "0")}`;
        names.set(id, args.name);
        return { ok: true, channel: { id, name: args.name } };
      }
      if (method === "conversations.invite") return { ok: true };
      if (method === "conversations.info" && names.has(args.channel))
        return {
          ok: true,
          channel: {
            ...internal,
            id: args.channel,
            name: names.get(args.channel),
            is_private: true,
          },
        };
      return original(method, args);
    });
    await expect(
      f.bridge
        .configureProjectSync({
          enabled: true,
          hostId: route.hostId,
          providerId: route.providerId,
          model: route.model,
          summaries: true,
        })
        .then(() =>
          f.bridge.importProjects({
            projectIds: Array.from({ length: 6 }, (_, i) => `project-${i + 1}`),
          }),
        ),
    ).resolves.toMatchObject({ state: "pending", created: 5, remaining: 1 });
    expect(f.bridge.config.projectSync?.channels).toHaveLength(5);
    await expect(f.bridge.syncProjects()).resolves.toMatchObject({
      state: "complete",
      created: 1,
      remaining: 0,
    });
    expect(f.bridge.config.projectSync?.channels).toHaveLength(6);
  });
  it("resumes a created private channel and reports missing Slack scope safely", async () => {
    const f = await fixture();
    vi.mocked(f.zcc.sdk.projects.list).mockResolvedValue([
      { id: "p2", name: "Website App" },
    ]);
    f.bridge.config.projectSync = {
      enabled: true,
      hostId: route.hostId,
      providerId: route.providerId,
      model: route.model,
      summaries: false,
      projectIds: ["p2"],
      pending: [
        {
          projectId: "p2",
          channel: "G234567",
          name: "zana-website-app-3946ca",
        },
      ],
    };
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (method, args) => {
      if (method === "conversations.invite")
        return { ok: false, error: "already_in_channel" };
      if (method === "conversations.info" && args.channel === "G234567")
        return {
          ok: true,
          channel: {
            ...internal,
            id: "G234567",
            name: "zana-website-app-3946ca",
            is_private: true,
          },
        };
      return original(method, args);
    });
    await expect(f.bridge.syncProjects()).resolves.toMatchObject({
      created: 1,
    });
    expect(
      f.call.mock.calls.some(([method]) => method === "conversations.create"),
    ).toBe(false);

    f.bridge.config.routes = [route];
    f.bridge.config.projectSync.pending = [];
    f.bridge.config.projectSync.projectIds = ["p1"];
    vi.mocked(f.zcc.sdk.projects.list).mockResolvedValue([
      { id: "p1", name: "Project" },
    ]);
    f.call.mockImplementation(async (method, args) =>
      method === "conversations.create"
        ? { ok: false, error: "missing_scope" }
        : original(method, args),
    );
    await expect(f.bridge.syncProjects()).rejects.toThrow("groups:write");
    expect(((await f.bridge.snapshot()) as any).projectSync).toMatchObject({
      state: "error",
      error: expect.stringContaining("groups:write"),
    });
    await expect(
      f.bridge.configureProjectSync({ enabled: false }),
    ).resolves.toMatchObject({ state: "idle" });
    expect(f.bridge.config.projectSync.enabled).toBe(false);
  });
  it("requires a discovered model and fails clearly for old mappings or unavailable catalogs", async () => {
    const f = await fixture();
    await expect(
      f.bridge.models({ hostId: "unknown", providerId: "codex" }),
    ).rejects.toThrow("registered");
    await expect(
      f.bridge.addRoute({ ...route, model: "default" }),
    ).rejects.toThrow("available model");
    const models = vi.mocked(f.zcc.sdk.providers.models);
    models.mockResolvedValue({
      models: [
        { id: "default", model: "default", supportedReasoningEfforts: [] },
      ],
      selectedOnlyModels: [],
      modelLoadError: null,
    });
    expect(
      await f.bridge.models({ hostId: "h1", providerId: "codex" }),
    ).toEqual([]);
    models.mockResolvedValue({
      models: [],
      selectedOnlyModels: [],
      modelLoadError: { providerId: "codex", code: "offline" },
    });
    await expect(
      f.bridge.models({ hostId: "h1", providerId: "codex" }),
    ).rejects.toThrow("Could not load models");
    f.bridge.config.routes = [{ ...route, model: undefined }];
    await run(f);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.store.get("receipt", "Ev1")?.note).toContain("Choose a model");
  });
  it("does not dispatch queued work with a different model after a mapping change", async () => {
    const f = await fixture();
    await f.receive(body());
    await f.bridge.tick();
    await run(f, "queued follow-up", "Ev2");
    f.bridge.config.routes = [{ ...route, model: "changed-model" }];
    await f.bridge.tick();
    expect(f.store.get("receipt", "Ev2")?.note).toBe(
      "Mapping or owner changed. Check the channel settings in Zana, then start a new Slack conversation.",
    );
    expect(f.send).not.toHaveBeenCalled();
  });
  it("quarantines uncertain spawn results and never retries them automatically", async () => {
    const f = await fixture();
    f.spawn.mockRejectedValue(new Error("transport lost"));
    await run(f);
    expect(f.store.get("receipt", "Ev1")?.state).toBe("needs-review");
    await f.bridge.tick();
    expect(f.spawn).toHaveBeenCalledOnce();
    f.bridge.resolve("Ev1");
    expect(f.store.get("receipt", "Ev1")?.state).toBe("cancelled");
    expect(() => f.bridge.resolve("missing")).toThrow();
  });
  it("handles immediate completion during spawn and send", async () => {
    const f = await fixture();
    f.spawn.mockImplementation(async (args) => {
      f.threads.set("th1", { ...args, id: "th1", status: "idle" });
      await f.bridge.event({ name: "thread.idle", threadId: "th1" });
      return { id: "th1" };
    });
    const root = await run(f);
    expect(f.store.get("receipt", "Ev1")?.state).toBe("settled");
    f.send.mockImplementation(async () => {
      await f.bridge.event({ name: "thread.idle", threadId: "th1" });
      return { id: "th1" };
    });
    await run(f, "next", "Ev2", root);
    expect(f.store.get("receipt", "Ev2")?.state).toBe("settled");
  });
  it("blocks queued work after destination or installation changes and expires waiting work", async () => {
    const f = await fixture();
    await f.receive(body());
    f.bridge.removeRoute(route.channel);
    await f.bridge.tick();
    expect(f.spawn).not.toHaveBeenCalled();
    f.bridge.config.routes = [route];
    await f.receive(body("run later", "later"));
    f.bridge.config.identity = { ...identity, app: "A654321" };
    await f.bridge.tick();
    expect(f.store.get("receipt", "later")?.state).toBe("rejected");
    f.bridge.config.identity = identity;
    await f.receive(body("run old", "old"));
    const r = f.store.get("receipt", "old")!;
    f.store.put("receipt", r.id, { ...r, created: Date.now() - 31 * 60000 });
    await f.bridge.tick();
    expect(f.store.get("receipt", "old")?.state).toBe("rejected");
  });
  it("serializes per project, caps queued work, and cancels followups on stop", async () => {
    const f = await fixture();
    const root = await run(f);
    await run(
      f,
      "run second",
      "Ev2",
      `${Math.floor(Date.now() / 1000)}.000002`,
    );
    expect(f.spawn).toHaveBeenCalledOnce();
    await run(f, "followup", "Ev3", root);
    await run(f, "stop", "Ev4", root);
    expect(f.store.get("receipt", "Ev3")?.state).toBe("cancelled");
    expect(f.spawn).toHaveBeenCalledTimes(2);
  });
  it("serves status/help, pause/resume, and prevents unsafe summary exports", async () => {
    const f = await fixture();
    const root = await run(f);
    await expect(f.bridge.publish("th1", "p1", "answer")).rejects.toThrow(
      "not enabled",
    );
    await expect(
      f.bridge.publish("th1", "wrong", "answer", true),
    ).rejects.toThrow("not connected");
    await run(f, "pause", "pause", root);
    await expect(
      f.bridge.publish("th1", "p1", "answer", true),
    ).rejects.toThrow();
    await run(f, "resume", "resume", root);
    const before = f.store.list("delivery").length;
    await expect(
      f.bridge.publish("th1", "p1", "x".repeat(2001), true),
    ).rejects.toThrow("invalid input");
    expect(f.store.list("delivery")).toHaveLength(before);
    const code = "```text\n" + "x".repeat(1988) + "\n```";
    expect(code.length).toBe(2000);
    await f.bridge.publish("th1", "p1", code, true);
    expect(f.store.list("delivery").some((d) => d.text === code)).toBe(true);
    await f.bridge.publish("th1", "p1", "<@everyone> result", true);
    await run(f, "status", "status", root);
    await run(f, "help", "help", root);
    expect(f.store.get("receipt", "help")?.state).toBe("settled");
    expect(
      f.store
        .list("delivery")
        .some((d) => d.text.includes("Mention me with a task")),
    ).toBe(true);
    f.bridge.config.routes[0].summaries = true;
    await expect(f.bridge.publish("th1", "p1", "answer")).resolves.toEqual({
      state: "queued",
    });
    await f.bridge.event({ name: "thread.active", threadId: "th1" });
    await f.bridge.event({ name: "thread.failed", threadId: "th1" });
    expect(f.store.list("binding")[0].state).toBe("failed");
    await f.bridge.event({ name: "thread.archived", threadId: "th1" });
    await f.bridge.event({ name: "thread.deleted", threadId: "th1" });
    await f.bridge.event({ name: "thread.idle", threadId: "unknown" });
  });
  it("reports failed stop without claiming success", async () => {
    const f = await fixture();
    await run(f);
    f.stop.mockRejectedValue(new Error("offline"));
    await expect(f.bridge.stop(f.store.list("binding")[0].key)).rejects.toThrow(
      "could not be confirmed",
    );
    expect(f.store.list("binding")[0].state).toBe("needs-review");
  });
  it("shows redacted snapshots and tolerates missing optional machine API", async () => {
    const f = await fixture();
    delete (f.zcc.sdk as any).hosts;
    const s = (await f.bridge.snapshot()) as any;
    expect(s.hosts[0].id).toBe("h1");
    expect(JSON.stringify(s)).not.toContain("xoxb");
  });
  it("requires valid credentials and stops on dispose", async () => {
    const f = await fixture();
    f.settings.get.mockResolvedValue({
      appToken: "bad",
      botToken: "xoxb-test",
      appId: identity.app,
    });
    await expect(f.bridge.connect()).rejects.toThrow("Connection failed");
    await f.bridge.dispose();
    await expect(f.bridge.connect()).rejects.toThrow();
    await f.bridge.tick();
    expect(f.slack.close).toHaveBeenCalled();
  });
});

describe("confirmed and uncertain outbound delivery", () => {
  async function outgoing() {
    const f = await fixture();
    await run(f, "status");
    await f.bridge.flush();
    await new Promise((r) => setImmediate(r));
    return f;
  }
  it("records Slack confirmation and disables automatic retries after ambiguous errors", async () => {
    const f = await outgoing();
    expect(f.store.list("delivery")[0].state).toBe("sent");
    await run(f, "help", "next");
    f.call.mockImplementation(async (method) => {
      if (method === "conversations.info") return { channel: internal };
      throw new Error("network timeout");
    });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
    await f.bridge.flush();
    expect(f.store.list("delivery").some((d) => d.state === "uncertain")).toBe(
      true,
    );
    const n = f.call.mock.calls.length;
    await f.bridge.flush();
    expect(f.call.mock.calls.length).toBe(n);
  });
  it("backs off 429, distinguishes platform rejection, and blocks removed destinations", async () => {
    const f = await fixture();
    await f.receive(body("status"));
    await f.bridge.tick();
    await new Promise((r) => setImmediate(r));
    f.call.mockImplementation(async (method) => {
      if (method === "conversations.info") return { channel: internal };
      throw Object.assign(new Error(), {
        code: "slack_webapi_rate_limited_error",
        retryAfter: 5,
      });
    });
    await f.bridge.flush();
    expect(f.store.list("delivery")[0]).toMatchObject({
      state: "queued",
      attempts: 1,
    });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
    f.call.mockImplementation(async (method) => {
      if (method === "conversations.info") return { channel: internal };
      throw Object.assign(new Error(), { code: "slack_webapi_platform_error" });
    });
    await f.bridge.flush();
    expect(f.store.list("delivery")[0].state).toBe("failed");
    await run(f, "help", "other");
    f.bridge.removeRoute(route.channel);
    await f.bridge.flush();
    expect(f.store.list("delivery")[0].state).toBe("failed");
  });
});

describe("revocation and crash boundaries", () => {
  it("leaves failed persistence unacknowledged for Slack retry", async () => {
    const f = await fixture();
    const insert = vi.spyOn(f.store, "insert").mockImplementation(() => {
      throw new Error("disk full");
    });
    const ack = vi.fn(async () => {});
    await expect(f.bridge.receive(body(), ack)).rejects.toThrow("disk full");
    expect(ack).not.toHaveBeenCalled();
    insert.mockRestore();
  });
  it("does not dispatch a cancelled request after channel validation resolves", async () => {
    const f = await fixture();
    await f.receive(body());
    let unblock: ((x: any) => void) | undefined;
    f.call.mockImplementation(async (method) =>
      method === "conversations.info"
        ? new Promise((r) => {
            unblock = r;
          })
        : {},
    );
    const tick = f.bridge.tick();
    await new Promise((r) => setImmediate(r));
    const r = f.store.get("receipt", "Ev1")!;
    f.store.put("receipt", r.id, { ...r, state: "cancelled" });
    unblock!({ channel: internal });
    await tick;
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.store.get("receipt", "Ev1")?.state).toBe("cancelled");
  });
  it("freezes queued execution destinations and reserves capacity for uncertain launches", async () => {
    const f = await fixture();
    f.spawn.mockRejectedValue(new Error("lost"));
    await run(f);
    await run(
      f,
      "run another",
      "Ev2",
      `${Math.floor(Date.now() / 1000)}.000002`,
    );
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.store.get("receipt", "Ev2")?.state).toBe("queued");
    f.bridge.resolve("Ev1");
    f.bridge.config.routes = [{ ...route, projectId: "p2" }];
    await f.bridge.tick();
    expect(f.store.get("receipt", "Ev2")?.state).toBe("rejected");
    expect(f.spawn).toHaveBeenCalledOnce();
  });
  it("rechecks sharing permission after async channel validation", async () => {
    const f = await fixture();
    await run(f);
    f.bridge.config.routes[0].summaries = true;
    await f.bridge.publish("th1", "p1", "private summary");
    for (const d of f.store.list("delivery"))
      if (d.text !== "private summary")
        f.store.put("delivery", d.id, { ...d, state: "sent" });
    let unblock: ((x: any) => void) | undefined;
    f.call.mockImplementation(
      async () =>
        new Promise((r) => {
          unblock = r;
        }),
    );
    await new Promise((r) => setImmediate(r));
    const flush = f.bridge.flush();
    await new Promise((r) => setImmediate(r));
    f.bridge.config.routes[0].summaries = false;
    unblock!({ channel: internal });
    await flush;
    expect(
      f.store.list("delivery").find((d) => d.text === "private summary")?.state,
    ).toBe("failed");
    expect(f.call.mock.calls.some((c) => c[0] === "chat.postMessage")).toBe(
      false,
    );
  });
});

describe("durable recovery attribution", () => {
  it("does not infer successful dispatch from an uncorrelated idle event after recovery", async () => {
    const f = await fixture();
    await run(f);
    const r = f.store.get("receipt", "Ev1")!;
    f.store.put("receipt", r.id, { ...r, state: "dispatching" });
    f.store.recover();
    await f.bridge.event({ name: "thread.idle", threadId: "th1" });
    expect(f.store.get("receipt", "Ev1")?.state).toBe("needs-review");
  });
  it("treats incomplete Slack success as uncertain", async () => {
    const f = await fixture();
    await run(f, "status");
    await new Promise((r) => setImmediate(r));
    f.call.mockImplementation(async (method) =>
      method === "conversations.info" ? { channel: internal } : { ok: true },
    );
    await f.bridge.flush();
    expect(f.store.list("delivery")[0].state).toBe("uncertain");
  });
});

it("marks uncertain deliveries reviewed without resending", async () => {
  const f = await fixture();
  await run(f, "status");
  await new Promise((r) => setImmediate(r));
  f.call.mockImplementation(async (method) =>
    method === "conversations.info" ? { channel: internal } : { ok: true },
  );
  await f.bridge.flush();
  const d = f.store.list("delivery")[0];
  f.bridge.resolveDelivery(d.id);
  expect(f.store.get("delivery", d.id)?.state).toBe("reviewed");
  expect(() => f.bridge.resolveDelivery(d.id)).toThrow();
});

it("unlink revokes imports, capabilities and task access even after relinking the same channel", async () => {
  const f = await fixture();
  const root = await run(f, "private old task");
  const old = f.store.list("binding")[0];
  f.bridge.config.projectSync = {
    enabled: true,
    projectIds: [route.projectId],
    allowSlackImport: true,
    ...route,
  };
  f.bridge.config.capabilityGrants = { "plugin:tool": "consent" };
  f.store.put("homeLaunch", "waiting", {
    id: "waiting",
    user: "U123456",
    team: identity.team,
    app: identity.app,
    state: "queued",
    task: "pending",
    note: "",
    created: Date.now(),
    expires: Date.now() + 60_000,
    routes: [route],
    route,
  });
  await f.bridge.resetOwner();
  expect(f.bridge.config.projectSync).toBeUndefined();
  expect(f.bridge.config.capabilityGrants).toBeUndefined();
  expect(f.store.list("delivery", ["queued"])).toEqual([]);
  expect(f.store.get("homeLaunch", "waiting")?.state).toBe("rejected");
  const epoch = f.bridge.config.ownerEpoch;
  expect(epoch).toEqual(expect.any(String));
  expect(f.store.config().ownerEpoch).toBe(epoch);
  await f.connect();
  f.bridge.config.owner = "U123456";
  f.bridge.config.routes = [route];
  await f.bridge.event({ name: "thread.active", threadId: old.threadId });
  expect(
    bindingRoute(f.bridge.config, f.store.get("binding", old.key)!),
  ).toBeUndefined();
  await expect(
    f.bridge.publish(old.threadId, old.projectId, "old answer", true),
  ).rejects.toThrow();
  await expect(f.bridge.stop(old.key)).rejects.toThrow();
  expect(() => f.bridge.mute(old.key, false)).toThrow();
  for (const [n, command] of [
    "follow-up",
    "status",
    "stop",
    "unmute",
  ].entries()) {
    await run(f, command, `old-${n}`, root);
    expect(f.store.get("receipt", `old-${n}`)?.state).toBe("rejected");
  }
  const view = homeView({
    config: f.bridge.config,
    bindings: [old],
    deliveries: [],
    launches: [],
    projects: [],
    project: "",
    token: "token",
  });
  expect(JSON.stringify(view)).not.toContain("private old task");
  expect(f.send).not.toHaveBeenCalled();
  expect(f.stop).not.toHaveBeenCalled();
  await run(f, "new task", "new", "1790800522.000001");
  expect(f.spawn).toHaveBeenCalledTimes(2);
  expect(
    f.store.list("binding").find((b) => b.threadId === "th2")?.ownerEpoch,
  ).toBe(epoch);
});

it("a task whose spawn finishes after unlink retains its revoked connection epoch", async () => {
  const f = await fixture();
  const original = f.spawn.getMockImplementation()!;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  f.spawn.mockImplementation(async (args) => {
    entered();
    await new Promise<void>((r) => {
      release = r;
    });
    return original(args);
  });
  await f.receive(body("task racing unlink"));
  const tick = f.bridge.tick();
  await started;
  await f.bridge.resetOwner();
  release();
  await tick;
  await f.connect();
  f.bridge.config.owner = "U123456";
  f.bridge.config.routes = [route];
  const b = f.store.list("binding")[0];
  expect(b).toBeDefined();
  expect(bindingRoute(f.bridge.config, b)).toBeUndefined();
  await expect(
    f.bridge.publish(b.threadId, b.projectId, "late answer", true),
  ).rejects.toThrow();
});

it.each(["owner", "workspace"])(
  "changing %s invalidates old task ownership and consent",
  async (kind) => {
    const f = await fixture();
    await run(f, "private task");
    const old = f.store.list("binding")[0];
    f.bridge.config.capabilityGrants = { tool: "granted" };
    f.bridge.save();
    await f.bridge.dispose();
    const original = f.call.getMockImplementation()!;
    const nextIdentity = {
      ...identity,
      team: kind === "workspace" ? "T654321" : identity.team,
    };
    f.call.mockImplementation(async (method, args) =>
      method === "auth.test"
        ? {
            ok: true,
            team_id: nextIdentity.team,
            user_id: identity.bot,
            bot_id: "B123456",
          }
        : original(method, args),
    );
    const bridge = new Bridge(
      f.zcc,
      f.store,
      f.settings,
      () => f.slack,
      async () => ({
        client: f.slack,
        identity: nextIdentity,
        owner: "U654321",
      }),
    );
    try {
      await bridge.connect();
      expect(bridge.config.owner).toBe("U654321");
      expect(bridge.config.routes).toEqual([]);
      expect(bridge.config.capabilityGrants).toBeUndefined();
      bridge.config.routes = [route];
      expect(bindingRoute(bridge.config, old)).toBeUndefined();
    } finally {
      await bridge.dispose();
    }
  },
);

// Rich content shares the existing fixed destination and durable confirmed-delivery path.
describe("rich report delivery", () => {
  const report = {
    title: "Review",
    sections: [{ type: "text", title: "Finding", text: "First" }],
  };
  async function ready() {
    const f = await fixture();
    f.bridge.config.routes[0].summaries = true;
    await run(f);
    await f.bridge.flush();
    const b = f.store.list("binding")[0];
    f.call.mockClear();
    return { ...f, b };
  }
  it("requires opt-in and exact thread/project, validates before enqueue, and revisions report changes", async () => {
    const f = await ready();
    await expect(
      f.bridge.publish(f.b.threadId, "p1", "Summary", false, report),
    ).rejects.toThrow("disabled");
    f.bridge.config.richResultsEnabled = true;
    await expect(
      f.bridge.publish(f.b.threadId, "other", "Summary", false, report),
    ).rejects.toThrow("not connected");
    await expect(
      f.bridge.publish(f.b.threadId, "p1", "Summary", false, {
        ...report,
        html: "x",
      }),
    ).rejects.toThrow("Invalid");
    await f.bridge.publish(f.b.threadId, "p1", "Summary", false, report);
    const id = `answer:${f.b.active || f.b.lastRequest}`;
    expect(f.store.get("delivery", id)?.state).toBe("queued");
    expect(f.store.sharedAnswer(f.b.key, true)).toBeUndefined();
    await f.bridge.publish(f.b.threadId, "p1", "Summary", false, report);
    expect(f.store.get("delivery", id)?.revision).toBe(1);
    await f.bridge.publish(f.b.threadId, "p1", "Summary", false, {
      ...report,
      title: "Updated",
    });
    expect(f.store.get("delivery", id)?.revision).toBe(2);
    // Earlier status posts consume channel pacing; release that gate with the clock.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
    await f.bridge.flush();
    expect(f.store.sharedAnswer(f.b.key, true)?.result?.title).toBe("Updated");
    expect(
      f.call.mock.calls.find((c) => c[0] === "chat.postMessage")?.[1],
    ).toMatchObject({
      channel: f.b.channel,
      thread_ts: f.b.root,
      blocks: [
        { type: "header", text: { text: "Updated" } },
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      ],
    });
    await f.bridge.publish(f.b.threadId, "p1", "Plain answer");
    expect(f.store.get("delivery", id)?.result).toBeUndefined();
  });
  it("rechecks answer and rich sharing when flushing queued reports", async () => {
    for (const reason of ["rich", "answers", "summaries", "mute"]) {
      const f = await ready();
      f.bridge.config.richResultsEnabled = true;
      await f.bridge.publish(f.b.threadId, "p1", "Summary", false, report);
      if (reason === "rich") f.bridge.config.richResultsEnabled = false;
      if (reason === "answers")
        f.bridge.config.slackAccess = { answers: false };
      if (reason === "summaries") f.bridge.config.routes[0].summaries = false;
      if (reason === "mute") f.bridge.mute(f.b.key, true);
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
      await f.bridge.flush();
      expect(
        f.call.mock.calls.some(
          (c) => c[0] === "chat.postMessage" && c[1].text === "Summary",
        ),
      ).toBe(false);
      vi.restoreAllMocks();
    }
  });
  it("falls back only on definitive block rejection and retains the authorized report; timeouts are uncertain", async () => {
    for (const mode of ["invalid_blocks", "thrown", "timeout", "revoked"]) {
      const f = await ready();
      f.bridge.config.richResultsEnabled = true;
      await f.bridge.publish(f.b.threadId, "p1", "Summary", true, report);
      const d = f.store.list("delivery").find((d) => d.result)!;
      const previous = f.call.getMockImplementation()!;
      let posts = 0;
      f.call.mockImplementation(async (m, a) => {
        if (["chat.postMessage", "chat.update"].includes(m)) {
          posts++;
          if (mode === "timeout") throw new Error("timeout");
          if (a.blocks) {
            if (mode === "revoked") f.bridge.config.richResultsEnabled = false;
            if (mode === "thrown")
              throw Object.assign(new Error("rejected"), {
                code: "slack_webapi_platform_error",
                data: { error: "invalid_blocks" },
              });
            return { ok: false, error: "invalid_blocks" };
          }
        }
        return previous(m, a);
      });
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
      await f.bridge.flush();
      expect(posts).toBe(mode === "timeout" || mode === "revoked" ? 1 : 3);
      expect(f.store.get("delivery", d.id)?.state).toBe(
        mode === "timeout"
          ? "uncertain"
          : mode === "revoked"
            ? "failed"
            : "sent",
      );
      if (mode === "invalid_blocks" || mode === "thrown") {
        expect(f.store.sharedAnswer(f.b.key, false)?.result).toEqual(report);
        f.call.mockClear();
        await f.bridge.publish(f.b.threadId, "p1", "Next", true, report);
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
        await f.bridge.flush();
        expect(
          f.call.mock.calls.filter((c) => c[0] === "chat.postMessage")[0][1]
            .blocks,
        ).toBeDefined();
      }
      vi.restoreAllMocks();
    }
  });
});

it("can remove rejected Work Object metadata and rejected rich blocks in either order, with bounded retries", async () => {
  for (const order of ["metadata-first", "blocks-first"]) {
    const f = await fixture();
    f.bridge.config.richResultsEnabled = true;
    await run(f);
    await f.bridge.flush();
    const b = f.store.list("binding")[0];
    const report = {
      title: "Review",
      sections: [{ type: "text", title: "Finding", text: "Bounded" }],
    };
    await f.bridge.publish(b.threadId, "p1", "Summary", true, report);
    const metadata = { entities: [] };
    const canEmbed = vi
      .spyOn(f.bridge.embeds, "metadata")
      .mockReturnValue(metadata);
    const prior = f.call.getMockImplementation()!;
    const posts: any[] = [];
    f.call.mockImplementation(async (method, args) => {
      if (method === "chat.postMessage") {
        posts.push(args);
        const failMetadata =
          args.metadata && (order === "metadata-first" || !args.blocks);
        if (failMetadata) return { ok: false, error: "invalid_metadata" };
        if (args.blocks)
          return {
            ok: false,
            error:
              order === "blocks-first"
                ? "invalid_blocks"
                : "feature_not_enabled",
          };
      }
      return prior(method, args);
    });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
    await f.bridge.flush();
    expect(posts).toHaveLength(4);
    expect(posts.at(-1)).toMatchObject({ text: "Summary" });
    expect(posts.at(-1).metadata).toBeUndefined();
    expect(posts.at(-1).blocks).toBeUndefined();
    expect(f.store.list("delivery").find((d) => d.result)?.state).toBe("sent");
    canEmbed.mockRestore();
    vi.restoreAllMocks();
  }
});
