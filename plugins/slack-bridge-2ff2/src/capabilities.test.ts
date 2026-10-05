import { afterEach, expect, it, vi } from "vitest";
import { setup } from "../test/helpers.js";
import { SlackCapabilities, type SlackCapability } from "./capabilities.js";
import { SlackbotJobs } from "./slackbot.js";
const fixtures: ReturnType<typeof setup>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = setup();
  fixtures.push(f);
  await f.connect();
  const capabilities = new SlackCapabilities(f.bridge);
  return { ...f, capabilities };
}
const definition = (
  overrides: Partial<SlackCapability> = {},
): SlackCapability => ({
  id: "inspect",
  title: "Inspect item",
  description: "Read an item in the selected Project.",
  version: 1,
  readOnly: true,
  fields: {
    query: { type: "string", description: "Lookup", maxLength: 100 },
    limit: { type: "number", description: "Count", enum: [1, 5] },
    include: { type: "boolean", description: "Include details" },
  },
  required: ["query"],
  execute: vi.fn(async () => ({ result: "safe" })),
  ...overrides,
});
const args = JSON.stringify({
  project_id: "p1",
  query: "item",
  limit: 1,
  include: true,
});
it("requires exact local consent, scopes dispatch to imported registered Projects, and publishes schema", async () => {
  const f = await fixture(),
    d = definition(),
    dispose = f.capabilities.register("tickets", d);
  expect(f.capabilities.list()).toEqual([]);
  expect(f.capabilities.list(true)).toMatchObject([
    {
      id: "tickets.inspect",
      enabled: false,
      input_schema: { required: ["project_id", "query"] },
    },
  ]);
  expect(
    await f.capabilities.run("tickets.inspect", args, () => true),
  ).toMatchObject({ error: "capability_unavailable" });
  f.capabilities.enable("tickets.inspect", true);
  expect(f.capabilities.list()).toHaveLength(1);
  expect(await f.capabilities.run("tickets.inspect", args, () => true)).toEqual(
    { capability_id: "tickets.inspect", result: { result: "safe" } },
  );
  expect(d.execute).toHaveBeenCalledWith(
    { query: "item", limit: 1, include: true },
    expect.objectContaining({
      projectId: "p1",
      slackUserId: "U123456",
      teamId: "T123456",
      signal: expect.any(AbortSignal),
    }),
  );
  f.capabilities.enable("tickets.inspect", false);
  expect(f.capabilities.list()).toEqual([]);
  dispose();
  expect(f.capabilities.list(true)).toEqual([]);
  dispose();
  for (const [id, enabled] of [
    ["missing", true],
    ["tickets.inspect", "yes"],
    [null, false],
  ])
    expect(() => f.capabilities.enable(id, enabled)).toThrow();
});
it("expires approval after a schema/version change and copies caller-owned metadata", async () => {
  const f = await fixture(),
    d = definition(),
    dispose = f.capabilities.register("tickets", d);
  f.capabilities.enable("tickets.inspect", true);
  d.fields.query.maxLength = 8000;
  expect(
    await f.capabilities.run(
      "tickets.inspect",
      JSON.stringify({ project_id: "p1", query: "x".repeat(101) }),
      () => true,
    ),
  ).toMatchObject({ error: "invalid_arguments" });
  dispose();
  f.capabilities.register("tickets", definition({ version: 2 }));
  expect(f.capabilities.list()).toEqual([]);
});
it("rejects unsupported declarations, duplicate registrations, and an unbounded catalog", async () => {
  const f = await fixture();
  for (const patch of [
    { id: "../oops" },
    { title: "" },
    { description: "" },
    { version: 0 },
    { readOnly: false },
    { execute: null },
    { fields: [] },
    {
      fields: Object.fromEntries(
        Array.from({ length: 13 }, (_, i) => [
          `p${i}`,
          { type: "boolean", description: "x" },
        ]),
      ),
    },
    { fields: { project_id: { type: "string", description: "x" } } },
    { fields: { x: { type: "object", description: "x" } } },
    { fields: { x: { type: "string", description: "x", pattern: ".*" } } },
    { fields: { x: { type: "string", description: "x", maxLength: 4001 } } },
    { fields: { x: { type: "boolean", description: "x", maxLength: 10 } } },
    { fields: { x: { type: "string", description: "x", enum: [true] } } },
    { fields: { x: { type: "number", description: "x", enum: [] } } },
    { required: ["missing"] },
  ])
    expect(() =>
      f.capabilities.register("tickets", definition(patch as any)),
    ).toThrow();
  expect(() => f.capabilities.register("../plugin", definition())).toThrow();
  f.capabilities.register("tickets", definition());
  expect(() => f.capabilities.register("tickets", definition())).toThrow();
  for (let i = 0; i < 49; i++)
    f.capabilities.register("tickets", definition({ id: `tool_${i}` }));
  expect(() =>
    f.capabilities.register("tickets", definition({ id: "over_limit" })),
  ).toThrow();
});
it("validates every remote argument and prevents invocation after revocation or Project removal", async () => {
  const f = await fixture(),
    d = definition();
  f.capabilities.register("tickets", d);
  f.capabilities.enable("tickets.inspect", true);
  for (const input of [
    null,
    "{",
    "x".repeat(8001),
    "null",
    "[]",
    "{}",
    JSON.stringify({ project_id: "foreign", query: "x" }),
    JSON.stringify({ project_id: "p1", unknown: "x", query: "x" }),
    JSON.stringify({ project_id: "p1", query: 3 }),
    JSON.stringify({ project_id: "p1", query: "x", limit: 2 }),
  ])
    expect(
      await f.capabilities.run("tickets.inspect", input, () => true),
    ).toMatchObject({ error: "invalid_arguments" });
  expect(
    await f.capabilities.run("tickets.inspect", args, () => false),
  ).toMatchObject({ error: "capability_unavailable" });
  vi.mocked(f.zcc.sdk.projects.list).mockResolvedValue([]);
  expect(
    await f.capabilities.run("tickets.inspect", args, () => true),
  ).toMatchObject({ error: "capability_unavailable" });
  expect(d.execute).not.toHaveBeenCalled();
});
it("bounds result size, hides plugin exceptions, and withholds results after access changes", async () => {
  const f = await fixture();
  for (const execute of [
    async () => ({ text: "x".repeat(32_001) }),
    async () => null as any,
    async () => {
      throw new Error("private-token");
    },
    async () => {
      f.capabilities.enable("tickets.inspect", false);
      return { secret: true };
    },
  ]) {
    const dispose = f.capabilities.register("tickets", definition({ execute }));
    f.capabilities.enable("tickets.inspect", true);
    const result = await f.capabilities.run(
      "tickets.inspect",
      args,
      () => true,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/private-token|secret/);
    dispose();
  }
});
it("enforces timeout and concurrency even when a plugin ignores cancellation", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  let resolve!: (value: Record<string, unknown>) => void;
  const pending = new Promise<Record<string, unknown>>(
      (done) => (resolve = done),
    ),
    execute = vi.fn(
      (_args: Record<string, unknown>, _context: { signal: AbortSignal }) =>
        pending,
    );
  f.capabilities.register("tickets", definition({ execute }));
  f.capabilities.enable("tickets.inspect", true);
  const calls = Array.from({ length: 4 }, () =>
    f.capabilities.run("tickets.inspect", args, () => true),
  );
  await vi.advanceTimersByTimeAsync(1);
  expect(
    await f.capabilities.run("tickets.inspect", args, () => true),
  ).toMatchObject({ error: "busy" });
  await vi.advanceTimersByTimeAsync(8000);
  expect(await Promise.all(calls)).toEqual(
    Array(4).fill(expect.objectContaining({ error: "capability_failed" })),
  );
  expect(execute.mock.calls[0][1].signal.aborted).toBe(true);
  expect(
    await f.capabilities.run("tickets.inspect", args, () => true),
  ).toMatchObject({ error: "busy" });
  resolve({ ok: true });
  await Promise.resolve();
  await Promise.resolve();
  f.capabilities.dispose();
  expect(f.capabilities.list(true)).toEqual([]);
});
it("routes signed Slackbot capability discovery and execution through the registry", async () => {
  const f = await fixture(),
    jobs = new SlackbotJobs(f.bridge, f.capabilities),
    p = { team: "T123456", app: "A123456", user: "U123456" };
  f.capabilities.register("tickets", definition());
  f.capabilities.enable("tickets.inspect", true);
  expect(
    await jobs.handle({ ...p, name: "zana_list_capabilities", arguments: {} }),
  ).toMatchObject({ capabilities: [{ id: "tickets.inspect" }] });
  expect(
    await jobs.handle({
      ...p,
      name: "zana_list_capabilities",
      arguments: { user: "other" },
    }),
  ).toMatchObject({ error: "invalid_arguments" });
  expect(
    await jobs.handle({
      ...p,
      name: "zana_run_capability",
      arguments: { capability_id: "tickets.inspect", arguments_json: args },
    }),
  ).toMatchObject({ result: { result: "safe" } });
  expect(
    await jobs.handle({
      ...p,
      name: "zana_run_capability",
      arguments: { user: "other" },
    }),
  ).toMatchObject({ error: "invalid_arguments" });
  expect(
    await new SlackbotJobs(f.bridge).handle({
      ...p,
      name: "zana_run_capability",
    }),
  ).toMatchObject({ error: "capability_unavailable" });
});
