import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setup, body } from "../test/helpers.js";

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
async function drain(f: ReturnType<typeof setup>) {
  now += 2000;
  await f.bridge.flush();
}
async function fixture() {
  const f = setup();
  fixtures.push(f);
  await f.connect();
  f.bridge.config.routes[0].summaries = true;
  await f.receive(body("Analyse the architecture", "task"));
  await f.bridge.tick();
  await new Promise((r) => setImmediate(r));
  await drain(f);
  return f;
}
const writes = (f: ReturnType<typeof setup>) =>
  f.call.mock.calls.filter(([m]) =>
    ["chat.postMessage", "chat.update"].includes(m),
  );

it.each(["active", "running", "starting", "stopping"])(
  "ignores an idle callback while the host is %s, without completion chatter or extra posts",
  async (status) => {
    const f = await fixture(),
      before = f.store.get("delivery", "status:task");
    f.threads.get("th1").status = status;
    await f.bridge.event({ name: "thread.idle", threadId: "th1" });
    await drain(f);
    expect(f.store.get("receipt", "task")?.state).toBe("running");
    expect(f.store.get("delivery", "status:task")).toEqual(before);
    expect(writes(f)).toHaveLength(1);
  },
);
it.each(["offline", "missing"])(
  "keeps working until reconciliation when idle lookup is %s",
  async (state) => {
    const f = await fixture();
    (f.zcc.sdk.threads.get as any)[
      state === "offline" ? "mockRejectedValue" : "mockResolvedValue"
    ](state === "offline" ? new Error("offline") : null);
    await f.bridge.event({ name: "thread.idle", threadId: "th1" });
    expect(f.store.get("receipt", "task")?.state).toBe("running");
  },
);
it("repairs a missed continuation event during polling without posting another status", async () => {
  const f = await fixture(),
    original = f.store.get("delivery", "status:task")!;
  f.threads.get("th1").status = "idle";
  await f.bridge.event({ name: "thread.idle", threadId: "th1" });
  await drain(f);
  // Simulates the active callback being missed while the plugin was reloading.
  f.threads.get("th1").status = "active";
  now += 11000;
  await f.bridge.tick();
  await drain(f);
  expect(f.store.get("receipt", "task")?.state).toBe("running");
  expect(f.store.get("delivery", original.id)).toMatchObject({
    text: "⚙️ Working…",
    ts: original.ts,
  });
  expect(writes(f).filter(([m]) => m === "chat.postMessage")).toHaveLength(1);
});
it("revives an unanswered automatic continuation by updating the original status, then removes it after the answer", async () => {
  const f = await fixture(),
    before = f.store.get("delivery", "status:task")!;
  f.threads.get("th1").status = "idle";
  await f.bridge.event({ name: "thread.idle", threadId: "th1" });
  await drain(f);
  expect(f.store.get("delivery", before.id)?.text).toMatch(
    /^⚠️ No answer shared/,
  );
  f.threads.get("th1").status = "active";
  await f.bridge.event({ name: "thread.active", threadId: "th1" });
  await drain(f);
  expect(f.store.get("delivery", before.id)).toMatchObject({
    ts: before.ts,
    text: "⚙️ Working…",
  });
  expect(f.store.list("binding")[0].active).toBe("task");
  expect(f.store.get("receipt", "task")).toMatchObject({ state: "running" });
  await f.bridge.event({ name: "thread.active", threadId: "th1" });
  await drain(f);
  expect(writes(f)).toHaveLength(3);
  await f.bridge.publish(
    "th1",
    "p1",
    "**Architecture ready.**\n\n```python\nwork()\n```",
  );
  f.threads.get("th1").status = "idle";
  await f.bridge.event({ name: "thread.idle", threadId: "th1" });
  await drain(f);
  await drain(f);
  await drain(f);
  const answer = f.store.get("delivery", "answer:task")!;
  expect(answer.state).toBe("sent");
  expect(f.store.get("delivery", before.id)?.state).toBe("removed");
  expect(writes(f).filter(([m]) => m === "chat.postMessage")).toHaveLength(2);
  expect(
    writes(f).find(([, a]) => a.text === answer.text)?.[1].blocks,
  ).toMatchObject([{ type: "rich_text" }]);
});
it.each(["confirmed", "failed", "stopped", "still-idle", "revoked", "muted"])(
  "does not revive %s work on a late active signal",
  async (condition) => {
    const f = await fixture();
    f.threads.get("th1").status = "idle";
    await f.bridge.event({ name: "thread.idle", threadId: "th1" });
    await drain(f);
    if (condition === "confirmed") {
      await f.bridge.publish("th1", "p1", "Done");
      await drain(f);
      await drain(f);
      expect(f.store.get("delivery", "answer:task")?.state).toBe("sent");
    }
    const b = f.store.list("binding")[0];
    if (["failed", "stopped"].includes(condition))
      f.store.put("receipt", "task", {
        ...f.store.get("receipt", "task")!,
        outcome: condition as "failed" | "stopped",
      });
    if (condition !== "still-idle") f.threads.get("th1").status = "active";
    if (condition === "revoked") f.bridge.config.routes = [];
    if (condition === "muted")
      f.store.put("binding", b.key, { ...b, paused: true });
    const writeCount = writes(f).length;
    await f.bridge.event({ name: "thread.active", threadId: "th1" });
    expect(f.store.list("binding")[0].active).toBe(
      condition === "muted" ? "task" : undefined,
    );
    if (condition === "muted") {
      await drain(f);
      expect(writes(f)).toHaveLength(writeCount);
    }
  },
);
it.each(["idle", "active"] as const)(
  "rechecks ownership and newer requests after an asynchronous %s lookup",
  async (event) => {
    const f = await fixture();
    if (event === "active") {
      f.threads.get("th1").status = "idle";
      await f.bridge.event({ name: "thread.idle", threadId: "th1" });
    }
    let resolve!: (v: unknown) => void;
    (f.zcc.sdk.threads.get as any).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const processing = f.bridge.event({
      name: `thread.${event}`,
      threadId: "th1",
    });
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    f.bridge.config.owner = "U234567";
    resolve({ status: event === "idle" ? "idle" : "active" });
    await processing;
    expect(f.store.get("receipt", "task")?.state).toBe(
      event === "idle" ? "running" : "settled",
    );
  },
);
it.each(["confirmed", "stopped", "failed"])(
  "does not revive a continuation that becomes %s during the host lookup",
  async (outcome) => {
    const f = await fixture();
    f.threads.get("th1").status = "idle";
    await f.bridge.event({ name: "thread.idle", threadId: "th1" });
    let resolve!: (v: unknown) => void;
    (f.zcc.sdk.threads.get as any).mockImplementationOnce(
      () => new Promise((r) => { resolve = r; }),
    );
    const processing = f.bridge.event({ name: "thread.active", threadId: "th1" });
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    if (outcome === "confirmed") {
      await f.bridge.publish("th1", "p1", "Done");
      await drain(f);
      await drain(f);
      expect(f.store.get("delivery", "answer:task")?.state).toBe("sent");
    } else {
      f.store.put("receipt", "task", {
        ...f.store.get("receipt", "task")!,
        outcome: outcome as "stopped" | "failed",
      });
    }
    resolve({ status: "active" });
    await processing;
    expect(f.store.list("binding")[0].active).toBeUndefined();
    expect(f.store.get("receipt", "task")?.state).toBe("settled");
  },
);
it.each(["invalid_blocks", "feature_not_enabled", "transport"])(
  "handles a Markdown delivery %s without duplicate or ambiguous retries",
  async (rejection) => {
    const f = await fixture(),
      previous = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (m, a) => {
      if (
        m === "chat.postMessage" &&
        a.blocks?.some((b: any) => b.type === "rich_text")
      ) {
        if (rejection === "transport") throw new Error("socket lost");
        throw {
          code: "slack_webapi_platform_error",
          data: { error: rejection },
        };
      }
      return previous(m, a);
    });
    f.call.mockClear();
    await f.bridge.publish("th1", "p1", "**Formatted**");
    await drain(f);
    expect(f.store.get("delivery", "answer:task")?.state).toBe(
      rejection === "transport" ? "uncertain" : "sent",
    );
    expect(writes(f)).toHaveLength(rejection === "transport" ? 1 : 2);
    await drain(f);
    expect(writes(f)).toHaveLength(rejection === "transport" ? 1 : 2);
  },
);
