import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { body, identity, route, setup, stamp } from "../test/helpers.js";
import { parseThreadReply } from "./thread-replies.js";

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
  await f.receive(body("Help me", "initial"));
  await f.bridge.tick();
  await new Promise((r) => setImmediate(r));
  f.threads.get("th1").status = "idle";
  await f.bridge.event({ name: "thread.idle", threadId: "th1" });
  now += 1000;
  return f;
}
function reply(
  f: ReturnType<typeof setup>,
  text = "Remind me of my study plan",
  id = "reply",
) {
  return {
    type: "event_callback",
    event_id: id,
    team_id: identity.team,
    api_app_id: identity.app,
    event: {
      type: "message",
      user: "U123456",
      channel: route.channel,
      thread_ts: f.store.list("binding")[0].root,
      ts: stamp(),
      text,
    },
  };
}
it("continues the original agent without another mention and deduplicates retries", async () => {
  const f = await fixture(),
    event = reply(f);
  expect(f.store.list("binding")[0].user).toBe("U123456");
  expect(
    parseThreadReply(event, f.bridge.config, (k) => f.store.get("binding", k))
      ?.text,
  ).toBe(event.event.text);
  await f.receive(event);
  await f.receive(event);
  await f.bridge.tick();
  await new Promise((r) => setImmediate(r));
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.send.mock.calls[0][0].threadId).toBe("th1");
  expect(JSON.stringify(f.send.mock.calls)).toContain(event.event.text);
  expect(f.spawn).toHaveBeenCalledTimes(1);
});
it("decodes Slack entities and supports legacy owner-bound records", async () => {
  const f = await fixture(),
    b = f.store.list("binding")[0];
  f.store.put("binding", b.key, { ...b, user: undefined });
  expect(
    parseThreadReply(reply(f, "a &amp; b &lt; c"), f.bridge.config, (k) =>
      f.store.get("binding", k),
    )?.text,
  ).toBe("a & b < c");
});
it.each([
  ["other member", { user: "U234567" }],
  ["bot", { bot_id: "B123456" }],
  ["edit", { subtype: "message_changed" }],
  ["hidden", { hidden: true }],
  ["top-level", { thread_ts: undefined }],
  ["unknown thread", { thread_ts: "1790000000.123456" }],
  ["bad member", { user: "bad" }],
  ["DM", { channel: "D123456" }],
  ["bad timestamp", { ts: "bad" }],
  ["empty", { text: " " }],
  ["too long", { text: "x".repeat(12001) }],
  ["mention duplicate", { text: `<@${identity.bot}> Continue` }],
])(
  "ignores %s without creating a receipt or launching work",
  async (_name, patch) => {
    const f = await fixture(),
      event = reply(f);
    await f.receive({ ...event, event: { ...event.event, ...patch } } as any);
    expect(f.store.get("receipt", "reply")).toBeUndefined();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.spawn).toHaveBeenCalledTimes(1);
  },
);
it.each([
  ["wrong team", { team_id: "T987654" }],
  ["wrong app", { api_app_id: "A987654" }],
  ["wrong wrapper", { type: "other" }],
  ["missing event id", { event_id: "" }],
  ["invalid event id", { event_id: 1 }],
  ["long event id", { event_id: "x".repeat(101) }],
])("rejects %s", async (_name, patch) => {
  const f = await fixture();
  expect(
    parseThreadReply({ ...reply(f), ...patch }, f.bridge.config, (k) =>
      f.store.get("binding", k),
    ),
  ).toBeNull();
});
it.each([
  "disabled",
  "no identity",
  "no owner",
  "wrong epoch",
  "other launcher",
  "archived",
  "deleted",
  "revoked route",
  "stale",
  "root message",
])("ignores %s bindings/messages", async (condition) => {
  const f = await fixture(),
    b = f.store.list("binding")[0],
    event = reply(f);
  if (condition === "disabled") f.bridge.config.enabled = false;
  if (condition === "no identity") f.bridge.config.identity = undefined;
  if (condition === "no owner") f.bridge.config.owner = undefined;
  if (condition === "wrong epoch")
    f.store.put("binding", b.key, { ...b, ownerEpoch: "old" });
  if (condition === "other launcher")
    f.store.put("binding", b.key, { ...b, user: "U234567" });
  if (["archived", "deleted"].includes(condition))
    f.store.put("binding", b.key, { ...b, state: condition });
  if (condition === "revoked route") f.bridge.config.routes = [];
  if (condition === "stale") now += 301000;
  if (condition === "root message") event.event.ts = event.event.thread_ts;
  await f.receive(event);
  expect(f.store.get("receipt", "reply")).toBeUndefined();
});
it("uses app_mention exactly once when Slack sends both event types", async () => {
  const f = await fixture();
  const event = reply(f, `<@${identity.bot}> Continue`, "message-copy");
  await f.receive(event);
  await f.receive({
    ...event,
    event_id: "mention-copy",
    event: { ...event.event, type: "app_mention" },
  });
  await f.bridge.tick();
  await new Promise((r) => setImmediate(r));
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.store.get("receipt", "message-copy")).toBeUndefined();
});
it("respects follow-up permissions and checks revocation again after queueing", async () => {
  const f = await fixture();
  f.bridge.config.slackAccess = { followups: false };
  await f.receive(reply(f));
  await f.bridge.tick();
  expect(f.send).not.toHaveBeenCalled();
  f.bridge.config.slackAccess.followups = true;
  await f.receive(reply(f, "Continue", "later"));
  f.bridge.config.routes = [];
  await f.bridge.tick();
  expect(f.send).not.toHaveBeenCalled();
});
it("accepts a plain stop command only from the launcher", async () => {
  const f = await fixture();
  const b = f.store.list("binding")[0];
  f.store.put("binding", b.key, { ...b, active: "initial", state: "running" });
  f.threads.get("th1").status = "running";
  const event = reply(f, "stop");
  await f.receive({ ...event, event: { ...event.event, user: "U234567" } });
  await f.bridge.tick();
  expect(f.stop).not.toHaveBeenCalled();
  await f.receive(event);
  await f.bridge.tick();
  expect(f.stop).toHaveBeenCalledTimes(1);
});
