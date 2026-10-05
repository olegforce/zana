import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setup,
  body,
  route,
  internal,
  stamp,
  identity,
} from "../test/helpers.js";
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
async function fixture() {
  const f = setup();
  fixtures.push(f);
  await f.connect();
  return f;
}
async function task(
  f: ReturnType<typeof setup>,
  text = "Review the tests",
  id = "task",
  root = stamp(),
) {
  await f.receive(body(text, id, root));
  await f.bridge.tick();
  await new Promise((resolve) => setImmediate(resolve));
  return root;
}
async function drain(f: ReturnType<typeof setup>, count = 5) {
  for (let n = 0; n < count; n++) {
    now += 2000;
    await f.bridge.flush();
  }
}
const messages = (f: ReturnType<typeof setup>) =>
  f.call.mock.calls.filter(
    ([m]) => m === "chat.postMessage" || m === "chat.update",
  );
describe("Slack UX outcomes", () => {
  it("updates one status message with real thinking/working/attention/done markers, without exposing reasoning", async () => {
    const f = await fixture();
    const events = vi.fn(async (): Promise<any[]> => []);
    (f.zcc.sdk.threads.events as any).list = events;
    await task(f);
    await drain(f, 1);
    const original = f.store.get("delivery", "status:task")!;
    expect(original.text).toMatch(/^⚙️ /);
    events.mockResolvedValue([
      {
        seq: 1,
        type: "item/reasoning/textDelta",
        payload: { itemId: "thought", delta: "PRIVATE_REASONING" },
      },
    ]);
    now += 11000;
    await f.bridge.tick();
    await drain(f, 1);
    expect(f.store.get("delivery", original.id)).toMatchObject({
      ts: original.ts,
      text: "🧠 Thinking…",
    });
    expect(JSON.stringify(messages(f))).not.toContain("PRIVATE_REASONING");
    f.threads.get("th1").hasPendingInteraction = true;
    now += 11000;
    await f.bridge.tick();
    await drain(f, 1);
    expect(f.store.get("delivery", original.id)?.text).toMatch(/^⚠️ /);
    events.mockResolvedValue([
      {
        seq: 2,
        type: "item/started",
        payload: { item: { id: "tool", type: "commandExecution" } },
      },
    ] as any);
    f.threads.get("th1").hasPendingInteraction = false;
    now += 11000;
    await f.bridge.tick();
    await drain(f, 1);
    expect(f.store.get("delivery", original.id)?.text).toMatch(/^⚙️ /);
    f.threads.get("th1").status = "idle";
    await f.bridge.event({ name: "thread.idle", threadId: "th1" });
    await drain(f, 1);
    expect(f.store.get("delivery", original.id)?.text).toMatch(/^⚠️ /);
    expect(messages(f).filter(([m]) => m === "chat.postMessage")).toHaveLength(
      1,
    );
    expect(JSON.stringify(messages(f))).not.toContain('"type":"actions"');
  });
  it.each(["ended", "stopped", "disconnected", "revoked"])(
    "does not revive a task that was %s while activity was loading",
    async (condition) => {
      const f = await fixture();
      await task(f);
      (f.zcc.sdk.threads.events as any).list = vi.fn(async () => {
        if (condition === "ended") {
          f.threads.get("th1").status = "idle";
          await f.bridge.event({ name: "thread.idle", threadId: "th1" });
        }
        if (condition === "stopped")
          await f.bridge.stop(f.store.list("binding")[0].key);
        if (condition === "disconnected") await f.bridge.disconnect();
        if (condition === "revoked") f.bridge.config.routes = [];
        return [
          {
            seq: 1,
            type: "item/started",
            payload: { item: { id: "thought", type: "reasoning" } },
          },
        ];
      });
      now += 11000;
      await f.bridge.tick();
      expect(f.store.list("binding")[0].activity).not.toBe("thinking");
      expect(f.store.get("delivery", "status:task")?.text).not.toContain(
        "Thinking",
      );
    },
  );
  it("keeps uncertain launch or stop status visible when new activity arrives", async () => {
    const f = await fixture();
    await task(f);
    const r = f.store.get("receipt", "task")!;
    f.store.put("receipt", r.id, {
      ...r,
      state: "needs-review",
      note: "Stop could not be confirmed.",
    });
    const d = f.store.get("delivery", "status:task")!;
    f.store.put("delivery", d.id, {
      ...d,
      text: "⚠️ Stop could not be confirmed.",
    });
    (f.zcc.sdk.threads.events as any).list = vi.fn(async () => [
      {
        seq: 1,
        type: "item/started",
        payload: { item: { id: "thought", type: "reasoning" } },
      },
    ]);
    now += 11000;
    await f.bridge.tick();
    expect(f.store.get("delivery", d.id)?.text).toBe(
      "⚠️ Stop could not be confirmed.",
    );
  });
  it("preserves activity and attention when event lookup fails", async () => {
    const f = await fixture();
    await task(f);
    const b = f.store.list("binding")[0];
    f.store.put("binding", b.key, {
      ...b,
      activity: "thinking",
      needsAttention: true,
      pendingInteractions: ["pending"],
    });
    (f.zcc.sdk.threads.events as any).list = vi.fn(async () => {
      throw new Error("offline");
    });
    now += 11000;
    await f.bridge.tick();
    expect(f.store.list("binding")[0]).toMatchObject({
      activity: "thinking",
      needsAttention: true,
    });
  });
  it("preserves the last confirmed activity when the host lookup fails", async () => {
    const f = await fixture();
    await task(f);
    const b = f.store.list("binding")[0];
    f.store.put("binding", b.key, {
      ...b,
      activity: "thinking",
      needsAttention: true,
    });
    (f.zcc.sdk.threads.get as any).mockRejectedValue(new Error("offline"));
    now += 11000;
    await f.bridge.tick();
    expect(f.store.list("binding")[0]).toMatchObject({
      activity: "thinking",
      needsAttention: true,
    });
  });
  it("accepts a natural task, updates one card, and honestly reports no shared answer", async () => {
    const f = await fixture();
    await task(f);
    await drain(f);
    expect(f.spawn.mock.calls[0][0]).toMatchObject({
      prompt: "Review the tests",
      title: "Slack · Review the tests",
    });
    expect(messages(f)).toHaveLength(1);
    expect(
      messages(f)[0][1]
        .blocks.flatMap((b: any) => b.elements || [])
        .some((e: any) => e.action_id === "bridge_stop"),
    ).toBe(false);
    f.threads.get("th1").status = "idle";
    await f.bridge.event({ name: "thread.idle", threadId: "th1" });
    await drain(f);
    expect(messages(f).map(([m]) => m)).toEqual([
      "chat.postMessage",
      "chat.update",
    ]);
    expect(messages(f)[1][1].text).toContain("No answer shared");
    const count = messages(f).length;
    await f.bridge.event({ name: "thread.archived", threadId: "th1" });
    await f.bridge.event({ name: "thread.deleted", threadId: "th1" });
    await drain(f);
    expect(messages(f)).toHaveLength(count);
    await task(f, "stop", "stale-control", f.store.list("binding")[0].root);
    expect(f.store.get("receipt", "stale-control")?.state).toBe("rejected");
    expect(f.store.get("delivery", "status:stale-control")?.text).toContain(
      "new top-level Slack mention",
    );
    expect(f.stop).not.toHaveBeenCalled();
    await expect(f.bridge.stop(f.store.list("binding")[0].key)).rejects.toThrow(
      "no longer available",
    );
  });
  it("uses one answer per turn and confirms delivery separately from execution", async () => {
    const f = await fixture();
    f.bridge.config.routes[0].summaries = true;
    await task(f);
    await drain(f);
    await f.bridge.publish("th1", "p1", "First answer");
    await f.bridge.publish("th1", "p1", "Final answer");
    f.threads.get("th1").status = "idle";
    await f.bridge.event({ name: "thread.idle", threadId: "th1" });
    expect(f.store.get("delivery", "status:task")?.text).toContain("Working");
    expect(f.store.get("delivery", "status:task")?.text).not.toContain(
      "Turn ended",
    );
    await drain(f);
    expect(f.store.get("delivery", "answer:task")?.state).toBe("sent");
    expect(f.store.get("delivery", "status:task")?.state).toBe("removed");
    expect(f.call.mock.calls.filter(([m]) => m === "chat.delete")).toHaveLength(
      1,
    );
    expect(messages(f).filter(([m]) => m === "chat.postMessage")).toHaveLength(
      2,
    );
    expect(messages(f).some(([, a]) => a.text === "First answer")).toBe(false);
  });
  it("keeps a newer completion while a status POST is in flight", async () => {
    const f = await fixture();
    await task(f);
    const original = f.call.getMockImplementation()!;
    let release!: (v: any) => void;
    f.call.mockImplementation(async (m, a) =>
      m === "chat.postMessage"
        ? new Promise((r) => (release = r))
        : original(m, a),
    );
    const flushing = f.bridge.flush();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.threads.get("th1").status = "idle";
    await f.bridge.event({ name: "thread.idle", threadId: "th1" });
    release({ ok: true, channel: route.channel, ts: stamp() });
    await flushing;
    expect(f.store.get("delivery", "status:task")).toMatchObject({
      state: "queued",
      text: expect.stringContaining("No answer shared"),
      ts: stamp(),
    });
    f.call.mockImplementation(original);
    await drain(f);
    expect(messages(f).map(([m]) => m)).toEqual([
      "chat.postMessage",
      "chat.update",
    ]);
  });
  it("keeps edits made during authorization and never replays an uncertain card", async () => {
    const f = await fixture();
    await task(f);
    const original = f.call.getMockImplementation()!;
    let release!: (v: any) => void;
    f.call.mockImplementation(async (m, a) =>
      m === "conversations.info"
        ? new Promise((r) => (release = r))
        : original(m, a),
    );
    const flushing = f.bridge.flush();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.threads.get("th1").status = "idle";
    await f.bridge.event({ name: "thread.idle", threadId: "th1" });
    release({ ok: true, channel: internal });
    await flushing;
    expect(messages(f)[0][1].text).toContain("No answer shared");
    f.call.mockImplementation(async (m, a) =>
      m === "chat.update"
        ? Promise.reject(new Error("timeout"))
        : original(m, a),
    );
    const r = f.store.get("receipt", "task")!;
    f.store.put("receipt", r.id, { ...r, state: "running" });
    const b = f.store.list("binding")[0];
    f.store.put("binding", b.key, { ...b, active: r.id });
    await f.bridge.event({ name: "thread.failed", threadId: "th1" });
    await drain(f);
    expect(f.store.get("delivery", "status:task")?.state).toBe("uncertain");
    const count = messages(f).length;
    await drain(f);
    expect(messages(f)).toHaveLength(count);
  });
  it("gives authorized owners actionable rejection feedback and ignores outsiders", async () => {
    const f = await fixture();
    await task(f, "", "empty");
    await drain(f);
    expect(messages(f)[0][1].text).toContain(
      "Choose a Project, harness and model",
    );
    expect(JSON.stringify(messages(f)[0][1].blocks)).toContain("launch_here");
    await f.receive(body("do it", "outsider", stamp(), "U654321"));
    expect(f.store.get("receipt", "outsider")).toBeUndefined();
    delete f.bridge.config.routes[0].model;
    await task(f, "do it", "no-model", `${Math.floor(now / 1000)}.000002`);
    await drain(f);
    expect(f.store.get("delivery", "status:no-model")?.text).toContain(
      "Choose a model",
    );
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("surfaces offline execution machines and waiting interactions", async () => {
    const f = await fixture();
    (f.zcc.sdk as any).hosts.list.mockResolvedValue([
      { id: "h1", name: "Mac", status: "disconnected" },
    ]);
    await task(f);
    expect(f.store.get("delivery", "status:task")?.text).toContain(
      "machine is offline",
    );
    (f.zcc.sdk as any).hosts.list.mockResolvedValue([
      { id: "h1", name: "Mac", status: "connected" },
    ]);
    await task(f, "read this", "next");
    f.threads.get("th1").hasPendingInteraction = true;
    now += 11000;
    await f.bridge.tick();
    expect(f.store.list("binding")[0].needsAttention).toBe(true);
    expect(f.store.get("delivery", "status:next")?.text).toContain(
      "Needs attention in Zana",
    );
    f.threads.get("th1").hasPendingInteraction = false;
    now += 11000;
    await f.bridge.tick();
    expect(f.store.list("binding")[0].needsAttention).toBe(false);
  });
  it("fails an answer honestly without claiming delivery", async () => {
    const f = await fixture();
    f.bridge.config.routes[0].summaries = true;
    await task(f);
    await drain(f);
    await f.bridge.publish("th1", "p1", "answer");
    f.threads.get("th1").status = "idle";
    await f.bridge.event({ name: "thread.idle", threadId: "th1" });
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (m, a) =>
      m === "chat.postMessage"
        ? { ok: false, error: "not_in_channel" }
        : original(m, a),
    );
    await drain(f);
    expect(f.store.get("delivery", "status:task")?.text).toContain(
      "delivery needs attention",
    );
  });
});
describe("Slack card controls", () => {
  function action(
    f: ReturnType<typeof setup>,
    command = "mute",
    user = "U123456",
    ts = stamp(),
  ) {
    const d = f.store.get("delivery", "status:task")!;
    return {
      type: "block_actions",
      api_app_id: identity.app,
      team: { id: identity.team },
      user: { id: user },
      channel: { id: d.channel },
      container: { channel_id: d.channel, message_ts: d.ts },
      actions: [{ action_id: `bridge_${command}`, value: d.id, action_ts: ts }],
    };
  }
  it("validates owner, card, app and destination; deduplicates controls before acting", async () => {
    const f = await fixture();
    await task(f);
    await drain(f);
    const key = f.store.list("binding")[0].key;
    for (const p of [
      action(f, "mute", "U654321"),
      { ...action(f), api_app_id: "A654321" },
      {
        ...action(f),
        container: {
          channel_id: route.channel,
          message_ts: "1000000000.000001",
        },
      },
      { ...action(f), actions: [] },
    ])
      await f.receive(p as any);
    await f.bridge.tick();
    expect(f.store.get("binding", key)?.paused).toBeUndefined();
    const p = action(f);
    await f.receive(p as any);
    await f.receive(p as any);
    await f.bridge.tick();
    expect(f.store.get("binding", key)?.paused).toBe(true);
    expect(
      f.store.list("receipt").filter((r) => r.id.startsWith("action:")),
    ).toHaveLength(1);
    expect(f.stop).not.toHaveBeenCalled();
    await f.receive(action(f, "unmute") as any);
    await f.bridge.tick();
    expect(f.store.get("binding", key)?.paused).toBe(false);
    await f.receive(action(f, "stop") as any);
    await f.bridge.tick();
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.store.get("binding", key)?.state).toBe("stopped");
    expect(f.store.get("delivery", "status:task")?.text).toContain(
      "Agent stopped",
    );
  });
  it("revalidates channel sharing before applying a button", async () => {
    const f = await fixture();
    await task(f);
    await drain(f);
    const p = action(f, "stop");
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (m, a) =>
      m === "conversations.info"
        ? { ok: true, channel: { ...internal, is_ext_shared: true } }
        : original(m, a),
    );
    await f.receive(p as any);
    await f.bridge.tick();
    await drain(f);
    expect(f.stop).not.toHaveBeenCalled();
    expect(messages(f).filter(([m]) => m === "chat.postMessage")).toHaveLength(
      1,
    );
  });
});
describe("Guided connection", () => {
  it("lists only joined internal channels with bounded pagination and tests a saved destination", async () => {
    const f = await fixture(),
      original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (m, a) =>
      m === "conversations.list"
        ? {
            ok: true,
            channels: [
              internal,
              { ...internal, id: "C654321", is_member: false },
              { ...internal, id: "C654322", is_shared: true },
            ],
            response_metadata: { next_cursor: a?.cursor ? "" : "next" },
          }
        : original(m, a),
    );
    expect(await f.bridge.channels()).toEqual([
      { id: route.channel, name: route.name },
      { id: route.channel, name: route.name },
    ]);
    await f.bridge.testChannel(route.channel);
    await drain(f);
    expect(messages(f)[0][1].text).toContain("Mention @Zana");
    expect(messages(f)[0][1].thread_ts).toBeUndefined();
    await expect(f.bridge.testChannel("C999999")).rejects.toThrow();
    await f.bridge.disconnect();
    await expect(f.bridge.channels()).rejects.toThrow("Connect");
  });
  it("reports a channel discovery failure without widening channel authorization", async () => {
    const f = await fixture();
    f.call.mockResolvedValue({ ok: false });
    await expect(f.bridge.channels()).rejects.toThrow("Enter the channel ID");
  });
});
