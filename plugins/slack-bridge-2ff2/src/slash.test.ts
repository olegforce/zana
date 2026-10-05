import { afterEach, describe, expect, it, vi } from "vitest";
import { identity, route, setup } from "../test/helpers.js";
import { parseSlash, resolveSlashProject, slashReply } from "./slash.js";
import { destinationBlock } from "./home-view.js";

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
const command = (text = "", overrides: Record<string, unknown> = {}) => ({
  command: "/zana",
  text,
  team_id: identity.team,
  api_app_id: identity.app,
  user_id: "U123456",
  channel_id: route.channel,
  trigger_id: "123.456.trigger",
  ...overrides,
});
const open = (f: ReturnType<typeof setup>) =>
  f.call.mock.calls.filter(([m]) => m === "views.open");
const block = (view: any, id: string) =>
  view.blocks.find((b: any) => b.block_id === id).element;
const receive = (f: ReturnType<typeof setup>, text = "", overrides = {}) =>
  f.receive(command(text, overrides) as any);

describe("slash command grammar", () => {
  it("decodes Slack entities once while preserving literal entity text", () => {
    expect(
      parseSlash("run . a &lt; 3 &amp;&amp; a &gt; 0; &amp;lt; &quot;"),
    ).toEqual({
      action: "run",
      project: ".",
      task: "a < 3 && a > 0; &lt; &quot;",
    });
  });
  it.each(["", "run", "new", "RUN"])("opens the picker for %s", (text) => {
    expect(parseSlash(text)).toEqual({ action: "run", project: "", task: "" });
  });
  it("preserves tasks and resolves names, IDs, and the channel shortcut", () => {
    expect(parseSlash('run "My Project" review\nthe tests')).toEqual({
      action: "run",
      project: "My Project",
      task: "review\nthe tests",
    });
    expect(parseSlash("run 'My Project'")).toEqual({
      action: "run",
      project: "My Project",
      task: "",
    });
    expect(parseSlash("status")).toEqual({ action: "status", project: "" });
    expect(parseSlash("status .")).toEqual({ action: "status", project: "." });
    expect(parseSlash("help")).toEqual({ action: "help" });
    for (const selector of ["p1", ".", "project"])
      expect(
        resolveSlashProject(
          selector,
          route.channel,
          [route],
          [{ id: "p1", name: "Project" }],
        ),
      ).toEqual({ project: "p1" });
    expect(resolveSlashProject(".", "D123456", [route], [])).toHaveProperty(
      "error",
    );
    expect(
      resolveSlashProject(
        "private",
        route.channel,
        [route],
        [{ id: "private", name: "private" }],
      ),
    ).toHaveProperty("error");
    expect(
      resolveSlashProject(
        "same",
        route.channel,
        [route, { ...route, projectId: "p2" }],
        [
          { id: "p1", name: "Same" },
          { id: "p2", name: "same" },
        ],
      ),
    ).toHaveProperty("error", expect.stringContaining("More than one"));
  });
  it.each([
    undefined,
    "x".repeat(2401),
    'run "unfinished',
    "help extra",
    "status p1 extra",
    "stop all",
    'run " " x',
    "run " + "p".repeat(301),
    "run p1 " + "x".repeat(2001),
  ])("rejects malformed or oversized input %#", (text) => {
    expect(parseSlash(text)).toHaveProperty("error");
  });
  it("escapes fallback text and bounds plain-text blocks, including without installation identity", () => {
    const reply = slashReply(["<@U123456>", "x".repeat(3000)], {
      enabled: false,
      routes: [],
    });
    expect(reply.response_type).toBe("ephemeral");
    expect(reply.text).toContain("&lt;@U123456&gt;");
    expect(reply.blocks).toHaveLength(2);
    expect((reply.blocks[1] as any).text.text).toHaveLength(2900);
  });
});

describe("owner-only Slack commands", () => {
  it("lists only mapped Projects and acknowledges read commands without network I/O", async () => {
    const f = await fixture();
    (f.zcc.sdk.projects.list as any).mockResolvedValue([
      { id: "p1", name: "Visible" },
      { id: "private", name: "PRIVATE PATH" },
    ]);
    await f.bridge.home.publish(true);
    f.call.mockClear();
    for (const text of [
      "projects",
      "help",
      "status",
      "status p1",
      "status .",
    ]) {
      const ack = await receive(f, text);
      expect(ack).toHaveBeenCalledWith(
        expect.objectContaining({ response_type: "ephemeral" }),
      );
      expect(JSON.stringify(ack.mock.calls)).not.toContain("PRIVATE PATH");
    }
    expect(f.call).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
    f.bridge.config.routes = [{ ...route, model: "" }];
    expect(JSON.stringify((await receive(f, "projects")).mock.calls)).toContain(
      "Choose a model",
    );
    f.bridge.config.routes = [];
    expect(JSON.stringify((await receive(f, "projects")).mock.calls)).toContain(
      "No Projects connected",
    );
  });
  it.each([
    { user_id: "U222222" },
    { team_id: "T222222" },
    { api_app_id: "A222222" },
  ])(
    "does not disclose data or create forms for wrong identity %j",
    async (override) => {
      const f = await fixture();
      f.call.mockClear();
      const ack = await receive(f, "projects", override);
      expect(JSON.stringify(ack.mock.calls)).not.toContain("agent-work");
      expect(f.call).not.toHaveBeenCalled();
      expect(f.store.list("homeLaunch")).toHaveLength(0);
    },
  );
  it("accepts authenticated Socket Mode payloads without api_app_id, but rejects disabled configuration", async () => {
    const f = await fixture();
    expect(
      JSON.stringify(
        (await receive(f, "projects", { api_app_id: undefined })).mock.calls,
      ),
    ).toContain("agent-work");
    f.bridge.config.enabled = false;
    expect(
      JSON.stringify((await receive(f, "projects")).mock.calls),
    ).not.toContain("agent-work");
  });
  it("persists and ACKs before opening a prefilled form, uses current channel, and deduplicates retries", async () => {
    const f = await fixture();
    f.bridge.config.routes.push({
      ...route,
      channel: "C222222",
      name: "second",
    });
    const ack = vi.fn(async () => {
      expect(f.store.list("homeLaunch")).toHaveLength(1);
      expect(open(f)).toHaveLength(0);
    });
    await f.bridge.home.handle(command("run . Say hello"), ack);
    const view = open(f)[0][1].view;
    expect(block(view, "project").initial_option.value).toBe("p1");
    expect(block(view, destinationBlock("p1")).initial_option.value).toBe(
      route.channel,
    );
    expect(block(view, "task").initial_value).toBe("Say hello");
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.store.list("delivery")).toHaveLength(0);
    await receive(f, "run . Say hello");
    f.bridge.home.reset();
    await receive(f, "run . Say hello");
    expect(open(f)).toHaveLength(1);
    expect(f.store.list("homeLaunch")).toHaveLength(1);
    expect(JSON.stringify(f.store.list("homeLaunch"))).not.toContain("trigger");
    const submission = {
      type: "view_submission",
      team: { id: identity.team },
      api_app_id: identity.app,
      user: { id: "U123456" },
      view: {
        ...view,
        id: "V654321",
        state: {
          values: {
            project: { launch_project: { selected_option: { value: "p1" } } },
            [destinationBlock("p1")]: {
              channel: { selected_option: { value: route.channel } },
            },
            task: { prompt: { value: "Say hello" } },
          },
        },
      },
    };
    await f.receive(submission as any);
    await f.receive(submission as any);
    await f.bridge.home.tick();
    await f.bridge.flush();
    await f.bridge.home.tick();
    await f.bridge.tick();
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });
  it("opens picker or setup, with no response_url access or agent launch", async () => {
    const f = await fixture();
    await receive(f, "", { response_url: "https://untrusted.invalid/secret" });
    expect(block(open(f)[0][1].view, "project").initial_option.value).toBe(
      "p1",
    );
    await receive(f, "connect");
    expect(open(f).at(-1)![1].view.callback_id).toBe("zana_connect_project");
    expect(JSON.stringify(f.call.mock.calls)).not.toContain("untrusted");
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("handles unknown Projects, missing trigger, missing model, and an unknown command", async () => {
    const f = await fixture();
    for (const [text, override] of [
      ["stop", {}],
      ["run missing test", {}],
      ["run p1 test", { trigger_id: "" }],
      ["run p1 test", { trigger_id: "x".repeat(301) }],
    ] as const) {
      const ack = await receive(f, text, override);
      expect(ack).toHaveBeenCalledWith(
        expect.objectContaining({ response_type: "ephemeral" }),
      );
    }
    f.bridge.config.routes = [{ ...route, model: "" }];
    expect(
      JSON.stringify((await receive(f, "run p1 test")).mock.calls),
    ).toContain("No launch-ready");
    expect(open(f)).toHaveLength(0);
  });
  it("filters status to current routes and installation, and distinguishes attention/running/recent", async () => {
    const f = await fixture();
    for (const [key, extra] of [
      ["running", { active: "r" }],
      ["attention", { needsAttention: true }],
      ["idle", { state: "idle" }],
      ["wrong-team", { team: "TOTHER" }],
      ["wrong-app", { app: "AOTHER" }],
      ["deleted", { state: "deleted" }],
      ["other-project", { projectId: "other" }],
    ] as const)
      f.store.put("binding", key, {
        key,
        ...identity,
        ...route,
        root: "1234567890.000001",
        threadId: key,
        state: "running",
        updated: Date.now(),
        ...extra,
      });
    expect(
      JSON.stringify((await receive(f, "status p1")).mock.calls),
    ).toContain("1 running · 1 need attention · 1 recent");
  });
  it("honors form caps and owner changes during ACK, and surfaces modal errors without launching", async () => {
    const f = await fixture();
    const list = vi.spyOn(f.store, "list"),
      original = list.getMockImplementation()!;
    list.mockImplementation(((kind: string, ...args: any[]) =>
      kind === "homeLaunch"
        ? Array(51).fill({})
        : original(kind as any, ...args)) as any);
    expect(
      JSON.stringify((await receive(f, "run p1 test")).mock.calls),
    ).toContain("Too many saved");
    list.mockRestore();
    await f.bridge.home.handle(command("run p1 test"), async () => {
      f.bridge.config.owner = "U222222";
    });
    expect(open(f)).toHaveLength(0);
    f.bridge.config.owner = "U123456";
    const originalCall = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (method, args) =>
      method === "views.open" ? { ok: false } : originalCall(method, args),
    );
    await receive(f, "run p1 test", { trigger_id: "second" });
    await f.bridge.home.publish(true);
    expect(JSON.stringify(f.call.mock.calls)).toContain(
      "The launch form could not open",
    );
    expect(f.spawn).not.toHaveBeenCalled();
  });
});

it("imports an exact registered Project from Slack without launching an agent", async () => {
  const f = await fixture();
  f.bridge.config.projectSync = {
    ...route,
    enabled: true,
    projectIds: [],
    allowSlackImport: true,
  };
  const importer = vi
    .spyOn(f.bridge, "importProjects")
    .mockResolvedValue({ state: "complete" });
  expect(parseSlash('import "My Project"')).toEqual({
    action: "import",
    project: "My Project",
  });
  expect(parseSlash("import")).toEqual({ action: "import", project: "" });
  expect(parseSlash("import p1 extra")).toHaveProperty("error");
  const list = await receive(f, "import");
  expect(JSON.stringify(list.mock.calls)).toContain("Project · p1");
  const ack = await receive(f, "import p1");
  expect(JSON.stringify(ack.mock.calls)).toContain("Import requested");
  expect(importer).toHaveBeenCalledWith({ projectIds: ["p1"] }, true);
  expect(f.spawn).not.toHaveBeenCalled();
  expect(JSON.stringify(f.call.mock.calls)).toContain(
    "Project import processed",
  );
});
it("handles disabled imports, ambiguous names and import failure in the owner's Home", async () => {
  const f = await fixture();
  expect(JSON.stringify((await receive(f, "import p1")).mock.calls)).toContain(
    "What Slack can do",
  );
  f.bridge.config.projectSync = {
    ...route,
    enabled: true,
    projectIds: [],
    allowSlackImport: true,
  };
  vi.mocked(f.zcc.sdk.projects.list).mockResolvedValue([
    { id: "p1", name: "Same" },
    { id: "p2", name: "Same" },
  ]);
  await f.bridge.home.publish(true);
  expect(
    JSON.stringify((await receive(f, "import Same")).mock.calls),
  ).toContain("ambiguous");
  expect(
    JSON.stringify((await receive(f, "import missing")).mock.calls),
  ).toContain("No registered Project");
  vi.spyOn(f.bridge, "importProjects").mockRejectedValue(
    new Error("Import profile offline"),
  );
  await receive(f, "import p1");
  expect(JSON.stringify(f.call.mock.calls)).toContain("Import profile offline");
});

it.each(["projects", "import p1", "run p1 do work", "status"])(
  "blocks disabled functionality through /zana %s",
  async (command) => {
    const f = await fixture();
    f.bridge.config.slackAccess = {
      projects: false,
      launch: false,
      status: false,
    };
    const ack = await receive(f, command);
    expect(JSON.stringify(ack.mock.calls)).toContain("What Slack can do");
    expect(f.store.list("homeLaunch")).toHaveLength(0);
    expect(f.spawn).not.toHaveBeenCalled();
  },
);
