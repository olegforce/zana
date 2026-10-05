import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setup, body, stamp, route, identity } from "../test/helpers.js";

let now: number;
const fixtures: ReturnType<typeof setup>[] = [];
beforeEach(() => {
  now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
  vi.restoreAllMocks();
});
async function drain(f: ReturnType<typeof setup>, count = 5) {
  for (let n = 0; n < count; n++) {
    now += 2000;
    await f.bridge.flush();
  }
}
async function fixture(postStatus = true) {
  const f = setup();
  fixtures.push(f);
  await f.connect();
  f.bridge.config.routes[0].summaries = true;
  const original = f.call.getMockImplementation()!;
  let seq = 0;
  f.call.mockImplementation(async (m, args) =>
    m === "chat.postMessage"
      ? {
          ok: true,
          channel: args.channel,
          ts: `1790000000.${String(++seq).padStart(6, "0")}`,
        }
      : original(m, args),
  );
  await f.receive(body("Do x", "task"));
  await f.bridge.tick();
  await new Promise((r) => setImmediate(r));
  if (postStatus) await drain(f, 1);
  return f;
}
async function finish(f: ReturnType<typeof setup>) {
  f.threads.get("th1").status = "idle";
  await f.bridge.event({ name: "thread.idle", threadId: "th1" });
}
it("leaves only the delivered answer, then revises it without recreating status chatter", async () => {
  const f = await fixture();
  const status = f.store.get("delivery", "status:task")!;
  await f.bridge.publish("th1", "p1", "Final answer");
  await finish(f);
  await drain(f);
  const answer = f.store.get("delivery", "answer:task")!;
  expect(answer.state).toBe("sent");
  expect(answer.ts).not.toBe(status.ts);
  expect(f.store.get("delivery", status.id)?.state).toBe("removed");
  expect(f.call.mock.calls.filter(([m]) => m === "chat.delete")).toEqual([
    ["chat.delete", { channel: route.channel, ts: status.ts }],
  ]);
  await f.bridge.publish("th1", "p1", "Revised final answer");
  await drain(f);
  expect(f.store.get("delivery", answer.id)).toMatchObject({
    ts: answer.ts,
    state: "sent",
    text: "Revised final answer",
  });
  expect(f.call.mock.calls.filter(([m]) => m === "chat.delete")).toHaveLength(
    1,
  );
  expect(
    f.call.mock.calls.filter(([m]) => m === "chat.postMessage"),
  ).toHaveLength(2);
  expect(JSON.stringify(f.call.mock.calls)).not.toMatch(
    /Turn ended|Answer delivered|Mention me here/,
  );
});
it("never posts a status that was still queued when the confirmed answer arrived", async () => {
  const f = await fixture(false);
  const status = f.store.get("delivery", "status:task")!;
  f.store.put("delivery", status.id, { ...status, next: now + 60_000 });
  await f.bridge.publish("th1", "p1", "Final answer");
  await finish(f);
  await drain(f);
  expect(f.store.get("delivery", status.id)?.state).toBe("removed");
  expect(f.call.mock.calls.filter(([m]) => m === "chat.delete")).toHaveLength(
    0,
  );
  expect(
    f.call.mock.calls.filter(([m]) => m === "chat.postMessage"),
  ).toHaveLength(1);
});
it("keeps a useful failure notice and never removes status for an uncertain answer", async () => {
  const f = await fixture();
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (m, args) =>
    m === "chat.postMessage"
      ? Promise.reject(new Error("offline"))
      : original(m, args),
  );
  await f.bridge.publish("th1", "p1", "Final answer");
  await finish(f);
  await drain(f);
  expect(f.store.get("delivery", "answer:task")?.state).toBe("uncertain");
  expect(f.store.get("delivery", "status:task")?.text).toContain(
    "delivery needs attention",
  );
  expect(f.call.mock.calls.some(([m]) => m === "chat.delete")).toBe(false);
});
it.each(["failed", "stopped"])(
  "preserves %s notices even if an answer was shared before termination",
  async (state) => {
    const f = await fixture();
    await f.bridge.publish("th1", "p1", "Partial answer");
    await drain(f);
    if (state === "stopped")
      await f.bridge.stop(f.store.list("binding")[0].key);
    else await f.bridge.event({ name: "thread.failed", threadId: "th1" });
    await drain(f);
    expect(f.store.get("delivery", "status:task")?.text).toMatch(
      state === "stopped" ? /^⏹️ / : /^❌ /,
    );
    expect(f.bridge.cleanupStatuses()).toEqual({ queued: 0 });
    expect(f.call.mock.calls.some(([m]) => m === "chat.delete")).toBe(false);
  },
);
it("cleans an old turn after its late answer arrives during a newer follow-up", async () => {
  const f = await fixture();
  await f.bridge.publish("th1", "p1", "Old answer");
  await finish(f);
  const root = f.store.list("binding")[0].root;
  await f.receive(body("Continue", "next", root));
  await f.bridge.tick();
  await new Promise((r) => setImmediate(r));
  await drain(f);
  expect(f.store.get("delivery", "status:task")?.state).toBe("removed");
  expect(f.store.get("receipt", "task")?.outcome).toBe("completed");
  expect(f.store.get("delivery", "status:next")?.remove).toBeUndefined();
});
it.each([
  "message_not_found",
  "cant_delete_message",
  "incomplete",
  "timeout",
  "rate-limit",
])(
  "handles deletion %s without replacing the answer or replaying an ambiguous write",
  async (outcome) => {
    const f = await fixture();
    const original = f.call.getMockImplementation()!;
    let deletes = 0;
    f.call.mockImplementation(async (m, args) => {
      if (m !== "chat.delete") return original(m, args);
      deletes++;
      if (outcome === "timeout") throw new Error("timeout");
      if (outcome === "rate-limit" && deletes === 1)
        throw { code: "slack_webapi_rate_limited_error", retryAfter: 1 };
      if (outcome === "incomplete") return { ok: true };
      if (["message_not_found", "cant_delete_message"].includes(outcome))
        return { ok: false, error: outcome };
      return original(m, args);
    });
    await f.bridge.publish("th1", "p1", "Final answer");
    await finish(f);
    await drain(f);
    expect(f.store.get("delivery", "status:task")?.state).toBe(
      ["message_not_found", "rate-limit"].includes(outcome)
        ? "removed"
        : outcome === "cant_delete_message"
          ? "failed"
          : "uncertain",
    );
    expect(f.store.get("delivery", "answer:task")?.state).toBe("sent");
    await drain(f);
    expect(deletes).toBe(outcome === "rate-limit" ? 2 : 1);
  },
);
it("cleans recorded old completion notices, excluding answers, active work and controls", async () => {
  const f = await fixture();
  await finish(f);
  await drain(f);
  const status = f.store.get("delivery", "status:task")!;
  f.store.put("delivery", status.id, {
    ...status,
    text: "✅ Turn ended · No answer shared.",
  });
  const answer = {
    ...status,
    id: "answer:task",
    origin: "agent" as const,
    text: "Real answer",
    ts: "1790000000.000002",
  };
  f.store.put("delivery", answer.id, answer);
  expect(f.bridge.cleanupStatuses()).toEqual({ queued: 1 });
  await drain(f);
  expect(f.store.get("delivery", status.id)?.state).toBe("removed");
  expect(f.store.get("delivery", answer.id)?.state).toBe("sent");
  expect(f.bridge.cleanupStatuses()).toEqual({ queued: 0 });
  await f.bridge.disconnect();
  expect(() => f.bridge.cleanupStatuses()).toThrow("Connect Slack first");
});
it.each(["owner", "route", "record", "answer", "timestamp"])(
  "rechecks %s ownership before removing a queued status",
  async (condition) => {
    const f = await fixture();
    await f.bridge.publish("th1", "p1", "Final answer");
    await finish(f);
    await drain(f, 1);
    const status = f.store.get("delivery", "status:task")!;
    if (condition === "owner") f.bridge.config.owner = "U234567";
    if (condition === "route") f.bridge.config.routes = [];
    if (condition === "record")
      f.store.put("receipt", "task", {
        ...f.store.get("receipt", "task")!,
        user: "U234567",
      });
    if (condition === "answer")
      f.store.put("delivery", status.id, { ...status, origin: "agent" });
    if (condition === "timestamp")
      f.store.put("delivery", status.id, { ...status, ts: "not-a-timestamp" });
    await drain(f);
    expect(f.call.mock.calls.some(([m]) => m === "chat.delete")).toBe(false);
  },
);
