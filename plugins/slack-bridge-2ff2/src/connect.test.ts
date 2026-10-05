import { afterEach, expect, it, vi } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { ConnectTransport } from "./connect.js";
import { setup, identity, body, route } from "../test/helpers.js";
import { Bridge } from "./bridge.js";
import { SlackbotJobs } from "./slackbot.js";

const resources: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of resources.splice(0)) await close();
});
const grant = {
  linkId: "00000000-0000-4000-8000-000000000001",
  credential: `00000000-0000-4000-8000-000000000001.${"k".repeat(43)}`,
  identity,
  owner: "U123456",
  computer: "My Mac",
};
const code = "c".repeat(43);
it("authenticates Slackbot tool envelopes and preserves durable admission across signed retries", async () => {
  const f = await fixture();
  await f.remote.link("https://example.com", code);
  const bridge = new Bridge(f.zcc, f.store, f.settings, () => f.slack, () => f.remote.connection());
  resources.unshift(() => bridge.dispose());
  const jobs = new SlackbotJobs(bridge);
  f.remote.setTools(input => jobs.handle(input));
  await bridge.connect();
  const payload = { kind: "tool", name: "zana_launch_job", team: identity.team, app: identity.app, user: grant.owner, requestId: "a".repeat(64), arguments: { project_id: route.projectId, channel_id: route.channel, task: "Test job", request_id: "request_001" } };
  expect(await f.remote.handle(signed({ ...payload, user: "U234567" }))).toMatchObject({ status: 403 });
  expect(await f.remote.handle(signed(payload))).toMatchObject({ json: { accepted: true, response: { state: "queued" } } });
  expect(await f.remote.handle(signed(payload))).toMatchObject({ json: { accepted: true, response: { state: "queued" } } });
  await bridge.home.tick(); await bridge.flush(); await bridge.home.tick(); await bridge.tick();
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(await f.remote.handle(signed({ ...payload, name: "zana_job_status", arguments: { job_id: payload.requestId } }))).toMatchObject({ json: { accepted: true, response: { state: "running" } } });
  await bridge.disconnect();
  expect(await f.remote.handle(signed(payload))).toMatchObject({ status: 503 });
});
function signed(payload: unknown, patch = {}) {
  const p = {
    v: 1,
    linkId: grant.linkId,
    timestamp: Date.now(),
    nonce: randomBytes(32).toString("base64url"),
    body: JSON.stringify(payload),
    ...patch,
  };
  return {
    ...p,
    signature: createHmac("sha256", grant.credential.slice(37))
      .update(JSON.stringify(p))
      .digest("hex"),
  };
}
async function fixture() {
  const f = setup();
  const fetcher = vi.fn(async (url: any, init: any) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/redeem/")) return Response.json(grant);
    if (path.endsWith("/call/")) {
      const input = JSON.parse(init.body);
      return Response.json(await f.call(input.method, input.args));
    }
    return Response.json({ active: true });
  });
  const remote = new ConnectTransport(f.zcc.storage, fetcher);
  resources.push(async () => {
    await remote.dispose();
    await f.close();
  });
  await remote.init();
  return { ...f, remote, fetcher };
}
it("locally activates, persists only private credentials and scopes API calls to the grant", async () => {
  const f = await fixture();
  expect(f.remote.snapshot()).toEqual({ linked: false });
  expect(await f.remote.connection()).toBeUndefined();
  await f.remote.link("https://example.com", code);
  expect(f.remote.snapshot()).toEqual({
    linked: true,
    origin: "https://example.com",
    owner: grant.owner,
    computer: grant.computer,
  });
  expect(JSON.stringify(f.remote.snapshot())).not.toContain(grant.credential);
  const c = (await f.remote.connection())!;
  const state = vi.fn();
  const receive = vi.fn(async (_body, ack) =>
    ack({ response_action: "clear" }),
  );
  await c.client.start(receive, state);
  expect(state).toHaveBeenCalledWith("Connected");
  expect(await c.client.call("auth.test")).toMatchObject({
    team_id: identity.team,
  });
  const probe = signed({ kind: "probe" });
  expect(await f.remote.handle(probe)).toMatchObject({
    json: { linkId: grant.linkId },
  });
  expect(
    await f.remote.handle(signed({ kind: "event", payload: body() })),
  ).toMatchObject({
    json: { accepted: true, response: { response_action: "clear" } },
  });
  expect(receive).toHaveBeenCalledTimes(1);
  const restarted = new ConnectTransport(f.zcc.storage, f.fetcher);
  await restarted.init();
  expect(restarted.snapshot().linked).toBe(true);
  expect(await restarted.handle(probe)).toMatchObject({ status: 409 });
  await restarted.dispose();
  await c.client.close();
  expect(() => c.client.call("auth.test")).toThrow("closed");
  expect(
    await f.remote.handle(signed({ kind: "event", payload: body() })),
  ).toMatchObject({ status: 503 });
  await f.remote.unlink();
  expect(f.remote.snapshot().linked).toBe(false);
});
it("rejects forged, expired, foreign-user, oversized and replayed invocations before any action", async () => {
  const f = await fixture();
  expect(await f.remote.handle({})).toMatchObject({ status: 401 });
  await f.remote.link("https://example.com", code);
  const c = (await f.remote.connection())!;
  const receive = vi.fn(async (_payload, ack) => ack());
  await c.client.start(receive, () => {});
  for (const input of [
    signed({}, { timestamp: Date.now() - 70_000 }),
    signed({}, { linkId: "other" }),
    { ...signed({}), signature: "0".repeat(64) },
    signed({}, { body: "x".repeat(300_000) }),
    signed({}, { nonce: "bad" }),
  ])
    expect(await f.remote.handle(input)).toMatchObject({ status: 401 });
  expect(
    await f.remote.handle(
      signed({
        kind: "event",
        payload: body("run", "ev", undefined, "U234567"),
      }),
    ),
  ).toMatchObject({ status: 403 });
  expect(await f.remote.handle(signed({}, { body: "not-json" }))).toMatchObject(
    { status: 400 },
  );
  const p = signed({ kind: "event", payload: body() });
  expect(await f.remote.handle(p)).toMatchObject({ json: { accepted: true } });
  expect(await f.remote.handle(p)).toMatchObject({
    status: 409,
    json: { notStarted: false },
  });
  expect(receive).toHaveBeenCalledTimes(1);
  await c.client.close();
});
it("uses the existing durable Bridge admission path and launches only once", async () => {
  const f = await fixture();
  await f.remote.link("https://example.com", code);
  const bridge = new Bridge(
    f.zcc,
    f.store,
    f.settings,
    () => f.slack,
    () => f.remote.connection(),
  );
  resources.unshift(() => bridge.dispose());
  await bridge.connect();
  expect(bridge.config.owner).toBe(grant.owner);
  expect(bridge.config.routes).toEqual([route]);
  const payload = body("run Say hello");
  delete (payload.event as any).thread_ts;
  await f.remote.handle(signed({ kind: "event", payload }));
  await bridge.tick();
  expect(f.spawn).toHaveBeenCalledTimes(1);
  await f.remote.handle(signed({ kind: "event", payload }));
  await bridge.tick();
  expect(f.spawn).toHaveBeenCalledTimes(1);
});
it("handles revoked credentials, unsafe origins, failed activation and uncertain ACKs without fallback", async () => {
  const f = await fixture();
  for (const origin of [
    "http://example.com",
    "https://user:pw@example.com",
    "https://example.com/path",
    "https://example.com?x=1",
  ])
    await expect(f.remote.link(origin, code)).rejects.toThrow();
  await expect(f.remote.link("https://example.com", "bad")).rejects.toThrow();
  f.fetcher.mockResolvedValueOnce(Response.json({ ...grant, owner: "bad" }));
  await expect(f.remote.link("https://example.com", code)).rejects.toThrow(
    "identity",
  );
  f.fetcher
    .mockResolvedValueOnce(Response.json(grant))
    .mockResolvedValueOnce(new Response("", { status: 503 }))
    .mockResolvedValueOnce(new Response("", { status: 401 }));
  await expect(f.remote.link("https://example.com", code)).rejects.toThrow();
  expect(f.remote.snapshot().linked).toBe(false);
  f.fetcher
    .mockResolvedValueOnce(Response.json(grant))
    .mockResolvedValueOnce(new Response("", { status: 503 }))
    .mockResolvedValueOnce(Response.json({ active: true }));
  await f.remote.link("https://example.com", code);
  expect(f.remote.snapshot().linked).toBe(true);
  f.fetcher.mockResolvedValueOnce(new Response("", { status: 401 }));
  await expect(f.remote.connection()).rejects.toThrow("revoked");
  const c = (await f.remote.connection())!;
  await c.client.start(
    async () => {
      throw new Error("after action");
    },
    () => {},
  );
  expect(
    await f.remote.handle(signed({ kind: "event", payload: body() })),
  ).toMatchObject({ status: 500, json: { notStarted: false } });
  vi.useFakeTimers();
  await c.client.start(
    async () => {},
    () => {},
  );
  const pending = f.remote.handle(signed({ kind: "event", payload: body() }));
  await vi.advanceTimersByTimeAsync(1500);
  expect(await pending).toMatchObject({
    status: 504,
    json: { notStarted: false },
  });
  await c.client.close();
});
it("bounds cloud responses and retains the local link when central revocation fails", async () => {
  const f = await fixture();
  await f.remote.link("https://example.com", code);
  f.fetcher.mockResolvedValueOnce(new Response("", { status: 503 }));
  await expect(f.remote.unlink()).rejects.toThrow();
  expect(f.remote.snapshot().linked).toBe(true);
  f.fetcher.mockResolvedValueOnce(new Response("x".repeat(300_000)));
  await expect(f.remote.connection()).rejects.toThrow("too large");
  f.fetcher.mockResolvedValueOnce(new Response("", { status: 410 }));
  await expect(f.remote.link("https://example.com", code)).rejects.toThrow(
    "expired",
  );
  f.fetcher.mockResolvedValueOnce(new Response("", { status: 401 }));
  await f.remote.unlink();
  expect(f.remote.snapshot().linked).toBe(false);
});

it('authenticates read-only panel requests independently of tool calls and rejects wrong owners and replays', async () => {
  const f = await fixture();
  expect(f.remote.embedBase()).toBeUndefined();
  await f.remote.link('https://example.com', code);
  expect(f.remote.embedBase()).toBe(`https://example.com/api/slack/tasks/${grant.linkId}`);
  const c = (await f.remote.connection())!; await c.client.start(async (_p, ack) => { await ack(); }, () => {});
  const payload = { kind: 'embed', team: identity.team, app: identity.app, user: grant.owner, action: 'page', entityId: 'task' };
  expect(await f.remote.handle(signed(payload))).toMatchObject({ status: 503 });
  const read = vi.fn(() => ({ status: 200, body: 'Public shell' })); f.remote.setEmbeds(read);
  const envelope = signed(payload);
  expect(await f.remote.handle(envelope)).toMatchObject({ json: { accepted: true, response: { body: 'Public shell' } } });
  expect(await f.remote.handle(envelope)).toMatchObject({ status: 409 });
  expect(await f.remote.handle(signed({ ...payload, user: 'U234567' }))).toMatchObject({ status: 403 });
  expect(read).toHaveBeenCalledTimes(1);
  await c.client.close(); expect(await f.remote.handle(signed(payload))).toMatchObject({ status: 503 });
});

it("allows bounded tools to finish beyond the Slack event acknowledgement deadline", async () => {
  const f = await fixture(); await f.remote.link("https://example.com", code);
  const c = (await f.remote.connection())!; await c.client.start(async () => {}, () => {});
  vi.useFakeTimers();
  const payload = { kind: "tool", team: identity.team, app: identity.app, user: grant.owner };
  f.remote.setTools(async () => { await new Promise(r => setTimeout(r, 8_000)); return { answer: "done" }; });
  let resolved = false;
  const result = f.remote.handle(signed(payload)).then(value => { resolved = true; return value; });
  await vi.advanceTimersByTimeAsync(1_800); expect(resolved).toBe(false);
  await vi.advanceTimersByTimeAsync(6_200);
  expect(await result).toMatchObject({ json: { accepted: true, response: { answer: "done" } } });
  const bounded = f.remote.handle(signed(payload));
  // A misbehaving handler is still bounded by the transport's own deadline.
  await vi.advanceTimersByTimeAsync(8_000); await bounded;
  f.remote.setTools(async () => { await new Promise(r => setTimeout(r, 10_000)); return {}; });
  const over = f.remote.handle(signed(payload));
  await vi.advanceTimersByTimeAsync(9_000);
  expect(await over).toMatchObject({ status: 504, json: { notStarted: false } });
  await vi.advanceTimersByTimeAsync(1_000);
  await c.client.close();
});
