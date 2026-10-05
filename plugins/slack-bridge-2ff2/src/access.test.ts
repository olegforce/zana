import { afterEach, expect, it, vi } from "vitest";
import {
  accessMessage,
  accessView,
  deliveryEnabled,
  featureEnabled,
  setFeature,
  slackFeatures,
  toolEnabled,
} from "./access.js";
import { setup, body, identity, route, stamp } from "../test/helpers.js";
import { SlackbotJobs } from "./slackbot.js";
import { SlackCapabilities } from "./capabilities.js";
import type { Config, Delivery } from "./model.js";

const fixtures: ReturnType<typeof setup>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
  vi.restoreAllMocks();
});
async function fixture() {
  const f = setup();
  fixtures.push(f);
  await f.connect();
  return f;
}
const caller = { team: identity.team, app: identity.app, user: "U123456" };
const launch = {
  ...caller,
  name: "zana_launch_job",
  requestId: "a".repeat(64),
  arguments: {
    project_id: route.projectId,
    channel_id: route.channel,
    task: "Test",
    request_id: "access_test_001",
  },
};

it("preserves defaults, validates local settings, uses one import switch and persists access", async () => {
  const f = await fixture(),
    c = f.bridge.config;
  expect(accessView(c).filter((v) => v.enabled)).toHaveLength(6);
  expect(toolEnabled(c, "missing")).toBe(false);
  for (const [id, enabled] of [
    ["missing", true],
    ["__proto__", true],
    [1, true],
    ["launch", 1],
  ])
    expect(() => setFeature(c, id, enabled)).toThrow();
  expect(() => setFeature(c, "imports", true)).toThrow("defaults");
  setFeature(c, "projects", false);
  expect(featureEnabled(c, "launch")).toBe(false);
  expect(() => setFeature(c, "launch", true)).toThrow("Browse");
  expect(() => setFeature(c, "imports", true)).toThrow("Browse");
  setFeature(c, "projects", true);
  c.projectSync = {
    enabled: true,
    hostId: "h1",
    providerId: "codex",
    model: "demo-model",
    summaries: false,
  };
  setFeature(c, "imports", true);
  expect(c.projectSync.allowSlackImport).toBe(true);
  expect(featureEnabled(c, "imports")).toBe(true);
  setFeature(c, "imports", false);
  setFeature(c, "answers", false);
  f.bridge.save();
  expect(f.store.config().slackAccess?.answers).toBe(false);
  expect(accessView(c).find((v) => v.id === "imports")).toMatchObject({
    available: true,
    enabled: false,
  });
});

it.each(slackFeatures.flatMap((f) => f.tools.map((name) => [f.id, name])))(
  "blocks disabled %s via MCP %s before side effects",
  async (feature, name) => {
    const f = await fixture();
    f.bridge.config.projectSync = {
      enabled: true,
      hostId: "h1",
      providerId: "codex",
      model: "demo-model",
      summaries: false,
    };
    setFeature(f.bridge.config, feature, false);
    const jobs = new SlackbotJobs(f.bridge);
    expect(await jobs.handle({ ...launch, name })).toMatchObject({
      error: "functionality_disabled",
    });
    expect(f.store.list("homeLaunch")).toHaveLength(0);
    expect(f.spawn).not.toHaveBeenCalled();
  },
);

it("rechecks Project discovery when a setting changes during an async read", async () => {
  const f = await fixture();
  vi.mocked(f.zcc.sdk.projects.list).mockImplementation(async () => {
    setFeature(f.bridge.config, "projects", false);
    return [{ id: "private", name: "Do not disclose" }] as any;
  });
  const response = await new SlackbotJobs(f.bridge).handle({
    ...caller,
    name: "zana_list_projects",
  });
  expect(response).toMatchObject({ isError: true });
  expect(JSON.stringify(response)).not.toContain("Do not disclose");
});

it("blocks mentions and queued dispatch after a setting changes during validation", async () => {
  const f = await fixture();
  setFeature(f.bridge.config, "launch", false);
  await f.receive(body("run blocked", "off"));
  await f.bridge.tick();
  expect(f.store.get("receipt", "off")).toMatchObject({
    state: "rejected",
    note: accessMessage,
  });
  setFeature(f.bridge.config, "launch", true);
  vi.mocked(f.zcc.sdk.projects.list).mockImplementation(async () => {
    setFeature(f.bridge.config, "launch", false);
    return [{ id: "p1", name: "Project" }] as any;
  });
  await f.receive(body("run race", "race"));
  await f.bridge.tick();
  expect(f.store.get("receipt", "race")).toMatchObject({
    state: "rejected",
    note: accessMessage,
  });
  expect(f.spawn).not.toHaveBeenCalled();
});

it("blocks queued MCP jobs and root delivery after launch access is revoked", async () => {
  const f = await fixture(),
    jobs = new SlackbotJobs(f.bridge);
  expect(await jobs.handle(launch)).toMatchObject({ state: "queued" });
  await f.bridge.home.tick();
  setFeature(f.bridge.config, "launch", false);
  await f.bridge.flush();
  await f.bridge.home.tick();
  await f.bridge.tick();
  expect(f.store.get("homeLaunch", `mcp:${launch.requestId}`)?.state).toBe(
    "rejected",
  );
  expect(
    f.store.list("delivery").find((d) => d.id.startsWith("home-root:"))?.state,
  ).toBe("failed");
  expect(
    f.call.mock.calls.filter(([m]) => m === "chat.postMessage"),
  ).toHaveLength(0);
  expect(f.spawn).not.toHaveBeenCalled();
});

it("blocks follow-ups and status while retaining stop, mute, unmute and help", async () => {
  const f = await fixture(),
    root = stamp();
  await f.receive(body("run work", "initial", root));
  await f.bridge.tick();
  setFeature(f.bridge.config, "followups", false);
  setFeature(f.bridge.config, "status", false);
  setFeature(f.bridge.config, "launch", false);
  for (const [id, text] of [
    ["follow", "more work"],
    ["status", "status"],
    ["mute", "mute"],
    ["unmute", "unmute"],
    ["stop", "stop"],
    ["help", "help"],
  ]) {
    await f.receive(body(text, id, root));
    await f.bridge.tick();
  }
  expect(f.store.get("receipt", "follow")?.state).toBe("rejected");
  expect(f.store.get("receipt", "status")?.state).toBe("rejected");
  expect(f.send).not.toHaveBeenCalled();
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.store.get("receipt", "help")?.state).toBe("settled");
  expect(
    deliveryEnabled(f.bridge.config, f.store.get("delivery", "reply:help")!),
  ).toBe(true);
  expect(
    f.store.get("binding", f.store.get("receipt", "initial")!.key)?.paused,
  ).toBe(false);
});

it("blocks previously queued follow-ups at dispatch without stopping running work", async () => {
  const f = await fixture(),
    root = stamp();
  await f.receive(body("run work", "first", root));
  await f.bridge.tick();
  await f.receive(body("follow up", "queued", root));
  await f.bridge.tick();
  expect(f.store.get("receipt", "queued")?.state).toBe("queued");
  setFeature(f.bridge.config, "followups", false);
  await f.bridge.tick();
  expect(f.store.get("receipt", "queued")?.state).toBe("rejected");
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
});

it("blocks automatic and manual answers as well as pending deliveries", async () => {
  const f = await fixture();
  await f.receive(body());
  await f.bridge.tick();
  f.bridge.config.routes[0].summaries = true;
  await f.bridge.publish("th1", "p1", "Queued secret");
  setFeature(f.bridge.config, "answers", false);
  await expect(f.bridge.publish("th1", "p1", "new")).rejects.toThrow();
  await expect(f.bridge.publish("th1", "p1", "manual", true)).rejects.toThrow();
  for (const d of f.store.list("delivery"))
    if (d.origin !== "agent")
      f.store.put("delivery", d.id, { ...d, state: "sent" });
  await f.bridge.flush();
  expect(f.store.get("delivery", "answer:Ev1")?.state).toBe("failed");
  expect(
    f.call.mock.calls.filter(([m]) => m === "chat.postMessage"),
  ).toHaveLength(0);
});

it("enforces sharing policy by delivery type and always permits control acknowledgements", () => {
  const c: Config = {
    enabled: true,
    routes: [],
    slackAccess: { launch: false, status: false, answers: false },
  };
  for (const d of [
    { id: "home-root:x" },
    { id: "x", origin: "agent" },
    { id: "x", origin: "operator" },
    { id: "x", origin: "status" },
  ])
    expect(deliveryEnabled(c, d as Delivery)).toBe(false);
  expect(deliveryEnabled(c, { id: "x", control: true } as Delivery)).toBe(true);
  expect(deliveryEnabled(c, { id: "help:x" } as Delivery)).toBe(true);
});

it("hides plugin tools and rejects in-flight results when the master switch is revoked", async () => {
  const f = await fixture(),
    registry = new SlackCapabilities(f.bridge);
  registry.register("test-plugin", {
    id: "inspect",
    title: "Inspect",
    description: "Read only",
    version: 1,
    readOnly: true,
    fields: {},
    execute: async () => {
      setFeature(f.bridge.config, "plugins", false);
      return { secret: "hidden" };
    },
  });
  registry.enable("test-plugin.inspect", true);
  expect(registry.list()).toHaveLength(1);
  expect(
    await registry.run(
      "test-plugin.inspect",
      JSON.stringify({ project_id: "p1" }),
      () => true,
    ),
  ).toMatchObject({ error: "capability_unavailable" });
  expect(registry.list()).toEqual([]);
  expect(registry.list(true)[0].enabled).toBe(true);
  setFeature(f.bridge.config, "plugins", true);
  expect(registry.list()).toHaveLength(1);
  registry.dispose();
});

it("suppresses an import response if Project access changes before it returns", async () => {
  const f = await fixture();
  f.bridge.config.projectSync = {
    enabled: true,
    allowSlackImport: true,
    hostId: "h1",
    providerId: "codex",
    model: "demo-model",
    summaries: false,
  };
  vi.spyOn(f.bridge, "importProjects").mockImplementation(async () => {
    setFeature(f.bridge.config, "projects", false);
    return {};
  });
  const reply = await new SlackbotJobs(f.bridge).handle({
    ...caller,
    name: "zana_import_project",
    arguments: { project_id: "p1" },
  });
  expect(reply).toMatchObject({ error: "not_authorized" });
  expect(reply).not.toHaveProperty("channel_id");
});
