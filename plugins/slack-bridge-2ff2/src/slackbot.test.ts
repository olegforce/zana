import { afterEach, expect, it, vi } from "vitest";
import { SlackbotJobs } from "./slackbot.js";
import { setup, route, identity } from "../test/helpers.js";
const fixtures: ReturnType<typeof setup>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
const job = "a".repeat(64);
const launch = {
  name: "zana_launch_job",
  team: identity.team,
  app: identity.app,
  user: "U123456",
  requestId: job,
  arguments: {
    project_id: route.projectId,
    channel_id: route.channel,
    task: "help",
    request_id: "request_001",
  },
};
async function fixture() {
  const f = setup();
  fixtures.push(f);
  await f.connect();
  return { ...f, jobs: new SlackbotJobs(f.bridge) };
}
const status = (id = job) => ({
  ...launch,
  name: "zana_job_status",
  arguments: { job_id: id },
});

it("lists registered Projects with import state and destinations without local paths", async () => {
  const f = await fixture();
  (f.zcc.sdk.projects.list as any).mockResolvedValue([
    { id: "p1", name: "Visible", path: "/private/path" },
    { id: "secret", name: "PRIVATE" },
  ]);
  const reply = await f.jobs.handle({
    ...launch,
    name: "zana_list_projects",
    arguments: {},
  });
  expect(reply).toMatchObject({
    projects: [
      {
        project_id: "p1",
        name: "Visible",
        destinations: [{ channel_id: route.channel, model: route.model }],
      },
      { project_id: "secret", imported: false, destinations: [] },
    ],
  });
  expect(JSON.stringify(reply)).not.toMatch(/private\/path|hostId/);
  expect(
    await f.jobs.handle({
      ...launch,
      name: "zana_list_projects",
      arguments: { user: "other" },
    }),
  ).toMatchObject({ error: "invalid_arguments" });
  (f.zcc.sdk.projects.list as any).mockImplementation(async () => {
    await f.bridge.disconnect();
    return [];
  });
  expect(
    await f.jobs.handle({
      ...launch,
      name: "zana_list_projects",
      arguments: {},
    }),
  ).toMatchObject({ error: "not_authorized" });
});

it("persists acceptance, launches exactly once through Home/Bridge and exposes only confirmed shared answers", async () => {
  const f = await fixture();
  expect(await f.jobs.handle(launch)).toMatchObject({
    job_id: job,
    state: "queued",
  });
  expect(f.spawn).not.toHaveBeenCalled();
  const restarted = new SlackbotJobs(f.bridge);
  await restarted.handle(launch);
  expect(f.store.list("homeLaunch")).toHaveLength(1);
  await f.bridge.home.tick();
  await f.bridge.flush();
  await f.bridge.home.tick();
  await f.bridge.tick();
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.spawn).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: route.projectId,
      model: route.model,
      prompt: "help",
    }),
  );
  expect(await restarted.handle(launch)).toMatchObject({
    state: "running",
    conversation_url: expect.stringContaining("https://app.slack.com/client/"),
  });
  const binding = f.store.list("binding")[0];
  f.store.put("binding", binding.key, { ...binding, needsAttention: true });
  expect(await f.jobs.handle(status())).toMatchObject({
    needs_attention: true,
    action_required: expect.stringContaining("Open Zana"),
  });
  const delivery = {
    id: "answer",
    key: binding.key,
    channel: binding.channel,
    root: binding.root,
    text: "Private draft",
    state: "queued" as const,
    origin: "operator" as const,
    created: Date.now(),
    next: 0,
    attempts: 0,
    note: "",
  };
  f.store.put("delivery", delivery.id, delivery);
  expect(await f.jobs.handle(status())).not.toHaveProperty("shared_answer");
  f.store.put("delivery", delivery.id, {
    ...delivery,
    state: "sent",
    origin: "agent",
  });
  expect(await f.jobs.handle(status())).not.toHaveProperty("shared_answer");
  f.store.put("delivery", delivery.id, {
    ...delivery,
    state: "sent",
    text: "Approved answer",
  });
  expect(await f.jobs.handle(status())).toMatchObject({
    shared_answer: "Approved answer",
  });
  f.bridge.config.slackAccess = { answers: false };
  expect(await f.jobs.handle(status())).not.toHaveProperty("shared_answer");
  f.bridge.config.routes = [];
  expect(await f.jobs.handle(status())).toMatchObject({
    error: "destination_unavailable",
  });
});

it("rejects foreign callers, forged inputs, changed requests and unmapped destinations", async () => {
  const f = await fixture();
  for (const patch of [
    { user: "U234567" },
    { team: "T234567" },
    { app: "A234567" },
  ])
    expect(await f.jobs.handle({ ...launch, ...patch })).toMatchObject({
      error: "not_authorized",
    });
  expect(await f.jobs.handle({ ...launch, name: "unknown" })).toMatchObject({
    error: "unknown_tool",
  });
  for (const patch of [
    { task: " " },
    { task: "x".repeat(2001) },
    { project_id: null },
    { channel_id: "invalid" },
    { request_id: "short" },
    { cwd: "/tmp" },
  ])
    expect(
      await f.jobs.handle({
        ...launch,
        arguments: { ...launch.arguments, ...patch },
      }),
    ).toMatchObject({ error: "invalid_arguments" });
  expect(await f.jobs.handle({ ...launch, requestId: "bad" })).toMatchObject({
    error: "invalid_arguments",
  });
  expect(await f.jobs.handle(status("bad"))).toMatchObject({
    error: "invalid_arguments",
  });
  expect(
    await f.jobs.handle({
      ...status(),
      arguments: { job_id: job, user: "other" },
    }),
  ).toMatchObject({ error: "invalid_arguments" });
  expect(await f.jobs.handle(status())).toMatchObject({
    error: "job_not_found",
  });
  expect(
    await f.jobs.handle({
      ...launch,
      arguments: { ...launch.arguments, project_id: "private" },
    }),
  ).toMatchObject({ error: "destination_unavailable" });
  await f.jobs.handle(launch);
  expect(
    await f.jobs.handle({
      ...launch,
      arguments: { ...launch.arguments, task: "different" },
    }),
  ).toMatchObject({ error: "request_conflict" });
  const saved = f.store.get("homeLaunch", `mcp:${job}`)!;
  f.store.put("homeLaunch", saved.id, { ...saved, user: "U234567" });
  expect(await f.jobs.handle(status())).toMatchObject({
    error: "job_not_found",
  });
  expect(await f.jobs.handle(launch)).toMatchObject({
    error: "request_conflict",
  });
  expect(f.spawn).not.toHaveBeenCalled();
});

it("retains uncertain sends without launching, surfaces local rejection, and caps admission", async () => {
  const f = await fixture();
  await f.jobs.handle(launch);
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (method, args) => {
    if (method === "chat.postMessage") throw new Error("lost response");
    return original(method, args);
  });
  await f.bridge.home.tick();
  await f.bridge.flush();
  await f.bridge.home.tick();
  await f.bridge.tick();
  expect(await f.jobs.handle(status())).toMatchObject({
    state: "needs-review",
  });
  expect(f.spawn).not.toHaveBeenCalled();
  f.bridge.home.dismiss(`mcp:${job}`);
  expect(await f.jobs.handle(status())).toMatchObject({
    state: "needs-review",
  });
  const saved = f.store.get("homeLaunch", `mcp:${job}`)!;
  for (let i = 0; i < 100; i++)
    f.store.put("homeLaunch", `queue${i}`, {
      ...saved,
      id: `queue${i}`,
      state: "needs-review",
    });
  expect(
    await f.jobs.handle({ ...launch, requestId: "b".repeat(64) }),
  ).toMatchObject({ error: "queue_full" });
});

it("does not acknowledge a launch when durable storage fails", async () => {
  const f = await fixture();
  const put = vi.spyOn(f.store, "put").mockImplementation(() => {
    throw new Error("disk full");
  });
  await expect(f.jobs.handle(launch)).rejects.toThrow("disk full");
  expect(f.spawn).not.toHaveBeenCalled();
  put.mockRestore();
});

it("revoked task status stays unavailable even after the same owner restores its destination", async () => {
  const f = await fixture();
  await f.jobs.handle(launch);
  await f.bridge.home.tick();
  await f.bridge.flush();
  await f.bridge.home.tick();
  await f.bridge.tick();
  expect(await f.jobs.handle(status())).toMatchObject({ state: "running" });
  await f.bridge.resetOwner();
  await f.connect();
  f.bridge.config.owner = launch.user;
  f.bridge.config.routes = [route];
  expect(await f.jobs.handle(status())).toMatchObject({
    error: "destination_unavailable",
  });
});

it("does not return an in-flight read across unlink and relink by the same owner", async () => {
  const f = await fixture();
  (f.zcc.sdk.projects.list as any).mockImplementation(async () => {
    await f.bridge.resetOwner();
    await f.connect();
    f.bridge.config.owner = launch.user;
    f.bridge.config.routes = [route];
    return [{ id: "p1", name: "Private" }];
  });
  expect(
    await f.jobs.handle({
      ...launch,
      name: "zana_list_projects",
      arguments: {},
    }),
  ).toMatchObject({ error: "not_authorized" });
});

it("discovers launch profiles and honors a requested harness/model once across concurrent retries", async () => {
  const f = await fixture();
  (f.zcc.sdk.providers.list as any).mockResolvedValue([
    { id: "codex", displayName: "Codex", available: true },
    { id: "cursor", displayName: "Cursor", available: true },
    { id: "missing", available: false },
  ]);
  (f.zcc.sdk.providers.models as any).mockResolvedValue({
    models: [{ model: "cursor-model" }],
    modelLoadError: null,
  });
  const options = {
    ...launch,
    name: "zana_launch_options",
    arguments: { project_id: "p1", harness: "cursor" },
  };
  expect(await f.jobs.handle(options)).toMatchObject({
    default_harness: "codex",
    default_model: route.model,
    models: [{ id: "cursor-model" }],
    harnesses: [{ id: "codex" }, { id: "cursor" }],
  });
  const request = {
    ...launch,
    arguments: {
      ...launch.arguments,
      harness: "cursor",
      model: "cursor-model",
    },
  };
  const replies = await Promise.all([
    f.jobs.handle(request),
    f.jobs.handle(request),
  ]);
  expect(
    replies.every(
      (r) =>
        r.state === "queued" &&
        r.harness === "cursor" &&
        r.model === "cursor-model",
    ),
  ).toBe(true);
  expect(f.store.list("homeLaunch")).toHaveLength(1);
  await f.bridge.home.tick();
  await f.bridge.flush();
  await f.bridge.home.tick();
  await f.bridge.tick();
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.spawn).toHaveBeenCalledWith(
    expect.objectContaining({ providerId: "cursor", model: "cursor-model" }),
  );
  expect(f.bridge.config.routes).toEqual([route]);
  expect(await f.jobs.handle(status())).toMatchObject({
    harness: "cursor",
    model: "cursor-model",
    state: "running",
  });
  expect(
    await f.jobs.handle({
      ...request,
      arguments: { ...request.arguments, model: "other" },
    }),
  ).toMatchObject({ error: "request_conflict" });
  f.bridge.config.ownerEpoch = "rotated";
  expect(await f.jobs.handle(status())).toMatchObject({
    error: "destination_unavailable",
  });
});
it("rejects invalid, unavailable, ambiguous or revoked launch profile choices", async () => {
  const f = await fixture();
  const options = (arguments_: any) =>
    f.jobs.handle({
      ...launch,
      name: "zana_launch_options",
      arguments: arguments_,
    });
  for (const args of [
    { project_id: null },
    { project_id: "p1", channel_id: "bad" },
    { project_id: "p1", harness: 3 },
    { project_id: "p1", hostId: "other" },
  ])
    expect(await options(args)).toMatchObject({ error: "invalid_arguments" });
  expect(await options({ project_id: "foreign" })).toMatchObject({
    error: "destination_unavailable",
  });
  expect(await options({ project_id: "p1", harness: "foreign" })).toMatchObject(
    { error: "profile_unavailable" },
  );
  f.bridge.config.routes.push({ ...route, channel: "C222222" });
  expect(await options({ project_id: "p1" })).toMatchObject({
    error: "destination_required",
  });
  f.bridge.config.routes.pop();
  for (const args of [{ harness: 3 }, { model: 3 }, { harness: "cursor" }])
    expect(
      await f.jobs.handle({
        ...launch,
        arguments: { ...launch.arguments, ...args },
      }),
    ).toMatchObject({ error: "invalid_arguments" });
  (f.zcc.sdk.providers.models as any).mockResolvedValue({
    models: [],
    modelLoadError: null,
  });
  expect(
    await f.jobs.handle({
      ...launch,
      arguments: { ...launch.arguments, model: "missing" },
    }),
  ).toMatchObject({ error: "profile_unavailable" });
  (f.zcc.sdk.providers.models as any).mockRejectedValue(new Error("offline"));
  expect(await options({ project_id: "p1", harness: "codex" })).toMatchObject({
    error: "profile_unavailable",
  });
  expect(
    await f.jobs.handle({
      ...launch,
      arguments: { ...launch.arguments, model: route.model },
    }),
  ).toMatchObject({ error: "profile_unavailable" });
  (f.zcc.sdk.providers.models as any).mockImplementation(async () => {
    f.bridge.config.routes = [];
    return { models: [{ model: route.model }], modelLoadError: null };
  });
  expect(
    await f.jobs.handle({
      ...launch,
      arguments: { ...launch.arguments, model: route.model },
    }),
  ).toMatchObject({ error: "not_authorized" });
  expect(f.store.list("homeLaunch")).toHaveLength(0);
});
