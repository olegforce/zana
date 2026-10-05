import { afterEach, expect, it, vi } from "vitest";
import { setup, route, internal } from "../test/helpers.js";
import { Bridge } from "./bridge.js";
import { SlackbotJobs } from "./slackbot.js";
const fixtures: ReturnType<typeof setup>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = setup();
  fixtures.push(f);
  await f.connect();
  vi.mocked(f.zcc.sdk.projects.list).mockResolvedValue([
    { id: "p1", name: "One" },
    { id: "p2", name: "Two" },
    { id: "p3", name: "Three" },
  ]);
  const original = f.call.getMockImplementation()!,
    names = new Map<string, string>();
  f.call.mockImplementation(async (method, args) => {
    if (method === "conversations.create") {
      const id = `G12345${names.size}`;
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
  return f;
}
const defaults = { ...route, enabled: true, allowSlackImport: true };
it("only imports the selection, never future Projects, and removing a mapping prevents recreation", async () => {
  const f = await fixture();
  await f.bridge.configureProjectSync(defaults);
  expect(f.bridge.config.projectSync?.projectIds).toEqual([]);
  await f.bridge.importProjects({ projectIds: ["p2"] });
  await f.bridge.syncProjects();
  expect(
    f.call.mock.calls.filter(([method]) => method === "conversations.create"),
  ).toHaveLength(1);
  expect(f.bridge.config.routes.map((r) => r.projectId)).toEqual(["p1", "p2"]);
  const channel = f.bridge.config.routes.find(
    (r) => r.projectId === "p2",
  )!.channel;
  f.bridge.removeRoute(channel);
  await f.bridge.syncProjects();
  expect(f.bridge.config.routes).toEqual([route]);
  expect(f.bridge.config.projectSync?.projectIds).toEqual([]);
  await f.bridge.importProjects({ projectIds: ["p2"] });
  expect(
    f.bridge.config.routes.find((r) => r.projectId === "p2")?.channel,
  ).toBe(channel);
  expect(
    f.call.mock.calls.filter(([method]) => method === "conversations.create"),
  ).toHaveLength(1);
});
it("migrates only existing managed mappings and does not finish legacy automatic pending imports", async () => {
  const f = await fixture();
  f.store.configure({
    ...f.bridge.config,
    projectSync: {
      ...defaults,
      channels: [
        {
          projectId: "p1",
          channel: route.channel,
          name: "zana-one",
          prefix: "",
        },
      ],
      pending: [{ projectId: "p3", channel: "G999999", name: "zana-three" }],
    },
  });
  const restarted = new Bridge(f.zcc, f.store, {} as any, () => {
    throw new Error("unused");
  });
  expect(restarted.config.projectSync).toMatchObject({
    projectIds: ["p1"],
    allowSlackImport: false,
  });
  expect(f.store.config().projectSync?.projectIds).toEqual(["p1"]);
  await restarted.dispose();
});
it("validates IDs, rejects unapproved Slack imports, and rechecks connection after discovery", async () => {
  const f = await fixture();
  await expect(f.bridge.importProjects({ projectIds: ["p2"] })).rejects.toThrow(
    "defaults",
  );
  await f.bridge.configureProjectSync({ ...defaults, allowSlackImport: false });
  await expect(
    f.bridge.importProjects({ projectIds: ["p2"] }, true),
  ).rejects.toThrow("Enable imports");
  for (const projectIds of [
    null,
    [],
    ["p2", "p2"],
    [4],
    ["x".repeat(101)],
    Array(251).fill("p2"),
    ["foreign"],
  ])
    await expect(f.bridge.importProjects({ projectIds })).rejects.toThrow();
  vi.mocked(f.zcc.sdk.projects.list).mockImplementation(async () => {
    await f.bridge.disconnect();
    return [{ id: "p2", name: "Two" }];
  });
  await expect(f.bridge.importProjects({ projectIds: ["p2"] })).rejects.toThrow(
    "changed",
  );
  expect(
    f.call.mock.calls.some(([method]) => method === "conversations.create"),
  ).toBe(false);
});
it("handles owner-scoped Slackbot imports idempotently with errors and no job launch", async () => {
  const f = await fixture(),
    jobs = new SlackbotJobs(f.bridge);
  const call = (arguments_: unknown, user = "U123456") =>
    jobs.handle({
      name: "zana_import_project",
      team: "T123456",
      app: "A123456",
      user,
      arguments: arguments_,
    });
  expect(await call({ project_id: "p2" })).toMatchObject({
    error: "functionality_disabled",
  });
  await f.bridge.configureProjectSync(defaults);
  expect(await call({ project_id: "p2" }, "U234567")).toMatchObject({
    error: "not_authorized",
  });
  expect(await call({ project_id: "p2", hostId: "other" })).toMatchObject({
    error: "invalid_arguments",
  });
  expect(await call({ project_id: "missing" })).toMatchObject({
    error: "import_unavailable",
  });
  expect(await call({ project_id: "p2" })).toMatchObject({
    state: "imported",
    channel_name: "zana-two",
  });
  expect(await call({ project_id: "p2" })).toMatchObject({
    state: "imported",
    channel_name: "zana-two",
  });
  expect(
    f.call.mock.calls.filter(([method]) => method === "conversations.create"),
  ).toHaveLength(1);
  expect(f.spawn).not.toHaveBeenCalled();
});
it("keeps concurrent import/settings mutations out of an active batch", async () => {
  const f = await fixture();
  await f.bridge.configureProjectSync(defaults);
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve)),
    original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (method, args) => {
    if (method === "conversations.create") await wait;
    return original(method, args);
  });
  const pending = f.bridge.importProjects({ projectIds: ["p2"] });
  await vi.waitFor(() =>
    expect(
      f.call.mock.calls.some(([method]) => method === "conversations.create"),
    ).toBe(true),
  );
  await expect(f.bridge.importProjects({ projectIds: ["p3"] })).rejects.toThrow(
    "in progress",
  );
  await expect(f.bridge.configureProjectSync(defaults)).rejects.toThrow(
    "in progress",
  );
  expect(() => f.bridge.removeRoute(route.channel)).toThrow("in progress");
  release();
  await pending;
  expect(f.bridge.config.projectSync?.projectIds).toEqual(["p2"]);
});
