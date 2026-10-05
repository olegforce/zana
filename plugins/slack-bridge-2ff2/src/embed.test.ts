import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  setup,
  identity,
  route,
  stamp,
  internal,
  body,
} from "../test/helpers.js";
import { embedOrigin, EMBED_TTL } from "./embed.js";
import type { Binding, Delivery } from "./model.js";

const fixtures: ReturnType<typeof setup>[] = [];
const origin = "https://tasks.example.com";
async function freePort() {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
async function fixture() {
  const f = setup();
  fixtures.push(f);
  await f.connect();
  const port = await freePort();
  await f.bridge.embeds.configure(origin, port);
  const b: Binding = {
    key: "task",
    team: identity.team,
    app: identity.app,
    channel: route.channel,
    root: stamp(),
    projectId: "p1",
    hostId: "h1",
    providerId: "codex",
    threadId: "private-thread",
    state: "idle",
    title: '<script>alert("secret")</script>',
    updated: Date.now(),
  };
  f.store.put("binding", b.key, b);
  const meta = f.bridge.embeds.metadata(b.key) as any;
  const entity = meta.entities[0];
  const details = (extra: Record<string, unknown> = {}) => ({
    type: "event_callback",
    team_id: identity.team,
    api_app_id: identity.app,
    event: {
      type: "entity_details_requested",
      user: "U123456",
      trigger_id: randomUUID(),
      external_ref: entity.external_ref,
      entity_url: entity.url,
      ...extra,
    },
  });
  const base = `http://127.0.0.1:${port}`;
  async function grant(extra: Record<string, unknown> = {}) {
    const ack = vi.fn(async () => {});
    await f.bridge.receive(details(extra), ack);
    const call = f.call.mock.calls
      .filter((c) => c[0] === "entity.presentDetails")
      .at(-1)!;
    const url = call?.[1]?.metadata?.entity_payload.attributes.full_size_preview
      .preview_url as string;
    return { url, local: url?.replace(origin, base), ack, args: call?.[1] };
  }
  function answer(overrides: Partial<Delivery> = {}) {
    const d: Delivery = {
      id: randomUUID(),
      key: b.key,
      channel: b.channel,
      root: b.root,
      origin: "operator",
      text: "Approved <b>answer</b>",
      state: "sent",
      created: Date.now(),
      next: 0,
      attempts: 1,
      note: "",
      ts: stamp(),
      ...overrides,
    };
    f.store.put("delivery", d.id, d);
  }
  return { ...f, b, base, port, entity, details, grant, answer };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) await f.close();
});

describe("task website authentication and HTTP boundary", () => {
  it("limits concurrent Slack authorization and stops old access after archive/reactivation", async () => {
    const f = await fixture();
    const g = await f.grant();
    await f.bridge.event({ name: "thread.archived", threadId: f.b.threadId });
    await f.bridge.event({ name: "thread.active", threadId: f.b.threadId });
    expect((await fetch(g.local)).status).toBe(403);
    const previous = f.call.getMockImplementation()!;
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    f.call.mockImplementation(async (m, a) => {
      if (m === "users.info") await hold;
      return previous(m, a);
    });
    const first = f.bridge.receive(f.details(), async () => {});
    const second = f.bridge.receive(f.details(), async () => {});
    await new Promise((r) => setImmediate(r));
    const calls = f.call.mock.calls.length;
    const thirdAck = vi.fn(async () => {});
    await f.bridge.receive(f.details(), thirdAck);
    expect(thirdAck).toHaveBeenCalledOnce();
    expect(f.call.mock.calls).toHaveLength(calls);
    release();
    await Promise.all([first, second]);
  });
  it("does not repeat a timed-out Work Object post or fall back after its route is revoked", async () => {
    for (const reason of ["timeout", "removed"]) {
      const f = await fixture();
      await f.receive(body("check status", "EvBoundary"));
      await f.bridge.tick();
      const previous = f.call.getMockImplementation()!;
      let posts = 0;
      f.call.mockImplementation(async (m, a) => {
        if (["chat.postMessage", "chat.update"].includes(m)) {
          posts++;
          if (reason === "timeout") throw new Error("timeout");
          f.bridge.removeRoute(route.channel);
          return { ok: false, error: "feature_not_enabled" };
        }
        return previous(m, a);
      });
      await f.bridge.flush();
      expect(posts).toBe(1);
      expect(f.store.get("delivery", "status:EvBoundary")?.state).toBe(
        reason === "timeout" ? "uncertain" : "failed",
      );
    }
  });
  it("starts a real loopback listener and serves only a minimal task projection after Slack owner authorization", async () => {
    const f = await fixture();
    f.answer();
    const { local, url, ack, args } = await f.grant();
    expect(ack).toHaveBeenCalledOnce();
    expect(args.metadata.entity_type).toBe("slack#/entities/file");
    expect(url).toMatch(/^https:\/\/tasks.example.com\/view\//);
    expect(
      f.entity.entity_payload.attributes.full_size_preview.preview_url,
    ).toBeUndefined();
    const res = await fetch(local, {
      headers: { Accept: "application/json", Origin: "null" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    const json = await res.json();
    expect(json).toMatchObject({
      title: f.b.title,
      answer: "Approved <b>answer</b>",
      state: "Ready",
      channel: route.name,
    });
    expect(Object.keys(json).sort()).toEqual(
      [
        "answer",
        "answerAt",
        "attention",
        "channel",
        "conversation",
        "expires",
        "observed",
        "state",
        "title",
        "updated",
      ].sort(),
    );
    expect(JSON.stringify(json)).not.toContain("private-thread");
    const html = await fetch(local);
    const text = await html.text();
    expect(text).toContain("&lt;script&gt;");
    expect(text).toContain("Approved &lt;b&gt;answer&lt;/b&gt;");
    expect(text).not.toContain('<script>alert("secret")');
    expect(html.headers.get("Content-Security-Policy")).toContain(
      "https://*.slack-mcps.com",
    );
    expect(html.headers.get("Content-Security-Policy")).toContain(
      "default-src 'none'",
    );
    expect(html.headers.get("Cache-Control")).toContain("no-store");
    expect(html.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(html.headers.get("X-Frame-Options")).toBeNull();
    expect(html.headers.get("Set-Cookie")).toBeNull();
    expect(JSON.stringify(await f.bridge.snapshot())).not.toContain(
      new URL(url).searchParams.get("key"),
    );
    expect(f.bridge.embeds.lastPresented).toBeGreaterThan(0);
  });
  it("never serves queued/uncertain answers and honors answer sharing plus task revocation on every read", async () => {
    const f = await fixture();
    f.answer({ origin: "agent", text: "Agent answer" });
    f.answer({ state: "uncertain", text: "Unconfirmed secret" });
    const g = await f.grant();
    const read = () =>
      fetch(g.local, { headers: { Accept: "application/json" } });
    expect((await (await read()).json()).answer).toBe("");
    f.bridge.config.routes[0] = { ...route, summaries: true };
    expect((await read()).status).toBe(403);
    const g2 = await f.grant();
    expect(
      (
        await (
          await fetch(g2.local, { headers: { Accept: "application/json" } })
        ).json()
      ).answer,
    ).toBe("Agent answer");
    const b = f.store.get("binding", f.b.key)!;
    f.store.put("binding", b.key, { ...b, needsAttention: true });
    expect(
      (
        await (
          await fetch(g2.local, { headers: { Accept: "application/json" } })
        ).json()
      ).state,
    ).toBe("Needs your input");
    f.store.put("binding", b.key, { ...b, state: "deleted" });
    expect((await fetch(g2.local)).status).toBe(403);
    f.store.put("binding", b.key, b);
    const g3 = await f.grant();
    await f.bridge.disconnect();
    expect((await fetch(g3.local)).status).toBe(403);
    await f.connect();
    expect((await fetch(g3.local)).status).toBe(403);
  });
  it("rejects missing, altered, cross-task and expired capabilities without leaking a title", async () => {
    const f = await fixture(),
      g = await f.grant();
    for (const url of [
      g.local.split("?")[0],
      g.local + "&key=second",
      g.local + "&extra=x",
      g.local.replace(/key=./, "key=!"),
      g.local.replace(/key=.{43}/, "key=" + "a".repeat(43)),
      g.local.replace(f.entity.external_ref.id, randomUUID()),
    ]) {
      const r = await fetch(url);
      expect(r.status).toBe(403);
      expect(await r.text()).not.toContain(f.b.title);
    }
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + EMBED_TTL + 1);
    expect((await fetch(g.local)).status).toBe(410);
    expect((await fetch(g.local)).status).toBe(403);
  });
  it("keeps unknown paths, product API, methods and redirects off the listener", async () => {
    const f = await fixture();
    expect(await (await fetch(f.base + "/health")).json()).toEqual({
      ok: true,
      service: "zana-task-embed",
    });
    const demo = await (await fetch(f.base + "/demo")).text();
    expect(demo).toContain("Sample task · no live data");
    expect(demo).not.toContain(f.b.title);
    const canonical = await (
      await fetch(f.entity.url.replace(origin, f.base))
    ).text();
    expect(canonical).toContain("Open this task");
    expect(canonical).not.toContain(f.b.title);
    for (const path of [
      "/api/v1/threads",
      "/etc/passwd",
      "/view/invalid",
      "/health?token=x",
      "/demo?key=x",
    ])
      expect((await fetch(f.base + path)).status).toBe(404);
    expect((await fetch(f.base + "/health", { method: "POST" })).status).toBe(
      405,
    );
    expect((await fetch(f.base + "//evil.example/path")).status).toBe(400);
    expect((await fetch(f.base + "/" + "x".repeat(1025))).status).toBe(400);
    const codes: number[] = [];
    for (let n = 0; n < 65; n++)
      codes.push((await fetch(f.base + "/health")).status);
    expect(codes).toContain(429);
    await f.bridge.embeds.configure("", f.port);
    await expect(fetch(f.base + "/health")).rejects.toThrow();
  });
  it("rejects wrong owner, task, URL and live Slack access; ACK precedes all API calls", async () => {
    const f = await fixture();
    for (const extra of [
      { user: "U654321" },
      { external_ref: { id: randomUUID(), type: "zana_task" } },
      { external_ref: { id: f.entity.external_ref.id, type: "wrong" } },
      { entity_url: "https://evil.example/task" },
    ]) {
      const result = await f.grant(extra);
      expect(result.url).toBeUndefined();
      expect(result.args.error.status).toBe("restricted");
    }
    for (const patch of [{ team_id: "T654321" }, { api_app_id: "A654321" }]) {
      const n = f.call.mock.calls.length;
      const ack = vi.fn(async () => {});
      await f.bridge.receive({ ...f.details(), ...patch }, ack);
      expect(ack).toHaveBeenCalledOnce();
      expect(f.call.mock.calls).toHaveLength(n);
    }
    const previous = f.call.getMockImplementation()!;
    const ack = vi.fn(async () => {});
    f.call.mockImplementation(async (method, args) => {
      expect(ack).toHaveBeenCalledOnce();
      if (method === "conversations.info")
        return { ok: true, channel: { ...internal, is_ext_shared: true } };
      return previous(method, args);
    });
    await f.bridge.receive(f.details(), ack);
    expect(f.call.mock.calls.at(-1)?.[1].error.status).toBe("restricted");
    f.call.mockImplementation(async (method, args) =>
      method === "users.info"
        ? { ok: true, user: { id: "U654321" } }
        : previous(method, args),
    );
    expect((await f.grant()).args.error.status).toBe("restricted");
  });
  it("bounds duplicate and concurrent details events, and discards a grant when Slack rejects the details", async () => {
    const f = await fixture();
    const event = f.details();
    await f.bridge.receive(event, async () => {});
    const n = f.call.mock.calls.filter(
      (c) => c[0] === "entity.presentDetails",
    ).length;
    await f.bridge.receive(event, async () => {});
    expect(
      f.call.mock.calls.filter((c) => c[0] === "entity.presentDetails"),
    ).toHaveLength(n);
    const prior = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (method, args) =>
      method === "entity.presentDetails" ? { ok: false } : prior(method, args),
    );
    const failed = await f.grant();
    expect(f.bridge.embeds.error).toContain("could not be opened");
    expect((await fetch(failed.local)).status).toBe(403);
    f.call.mockImplementation(async (method, args) => {
      if (method === "users.info") {
        await f.bridge.disconnect();
      }
      return prior(method, args);
    });
    f.call.mockClear();
    await f.grant();
    expect(
      f.call.mock.calls.some((c) => c[0] === "entity.presentDetails"),
    ).toBe(false);
  });
  it("revokes on mapping edits, mute/unmute and owner reset; does not advertise archived tasks", async () => {
    const f = await fixture();
    let g = await f.grant();
    f.bridge.mute(f.b.key, true);
    f.bridge.mute(f.b.key, false);
    expect((await fetch(g.local)).status).toBe(403);
    g = await f.grant();
    f.bridge.removeRoute(route.channel);
    expect((await fetch(g.local)).status).toBe(403);
    expect(f.bridge.embeds.metadata(f.b.key)).toBeUndefined();
    f.bridge.config.routes = [route];
    g = await f.grant();
    await f.bridge.resetOwner();
    expect((await fetch(g.local)).status).toBe(403);
    expect(f.bridge.embeds.metadata("missing")).toBeUndefined();
  });
  it("validates configuration, recovers a busy port and reloads only persisted setup", async () => {
    const f = await fixture();
    expect(embedOrigin(" https://Tasks.Example.com/ ")).toBe(origin);
    for (const bad of [
      undefined,
      "",
      "garbage",
      "http://tasks.example.com",
      "https://127.0.0.1",
      "https://[::1]",
      "https://localhost",
      "https://host.local",
      "https://foo.slack.com",
      "https://tasks.example.com/a",
      "https://u:p@tasks.example.com",
      "https://tasks.example.com?x",
      "https://tasks.example.com#x",
      "https://tasks.example.com:8780",
      "x".repeat(251),
    ])
      expect(() => embedOrigin(bad)).toThrow();
    for (const port of [8780, 8781, 0, 65536, 2.2, "8792"])
      await expect(f.bridge.embeds.configure(origin, port)).rejects.toThrow();
    const preview = await f.bridge.embeds.preview();
    expect(preview.url).toBe(f.base + "/demo");
    const g = await f.grant();
    await f.bridge.embeds.init();
    expect((await fetch(g.local)).status).toBe(403);
    const occupied = createServer();
    await new Promise<void>((r) => occupied.listen(0, "127.0.0.1", r));
    const busy = (occupied.address() as { port: number }).port;
    try {
      await expect(f.bridge.embeds.configure(origin, busy)).rejects.toThrow(
        "unused local port",
      );
    } finally {
      await new Promise<void>((r) => occupied.close(() => r()));
    }
    await f.bridge.embeds.configure(origin, f.port);
    await f.bridge.embeds.dispose();
    await expect(f.bridge.embeds.configure(origin, f.port)).rejects.toThrow();
    await expect(f.bridge.embeds.preview()).rejects.toThrow();
  });
  it("attaches Work Objects to ordinary status delivery and falls back only after definitive metadata rejection", async () => {
    const f = await fixture();
    await f.receive(body("review this", "EvEmbed"));
    await f.bridge.tick();
    const status = f.store.get("delivery", "status:EvEmbed")!;
    // The normal pipeline owns the message and its idempotency; embeds add metadata only.
    f.store.put("delivery", status.id, { ...status, next: 0 });
    const previous = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (method, args) => {
      if (["chat.postMessage", "chat.update"].includes(method) && args.metadata)
        throw Object.assign(new Error("rejected"), {
          code: "slack_webapi_platform_error",
          data: { error: "invalid_metadata" },
        });
      return previous(method, args);
    });
    await f.bridge.flush();
    expect(f.call.mock.calls.some((c) => c[1]?.metadata?.entities)).toBe(true);
    expect(f.store.get("delivery", status.id)?.state).toBe("sent");
    expect(f.bridge.embeds.metadataError).toContain(
      "Ordinary status messages still work",
    );
    expect(f.bridge.embeds.metadata(f.b.key)).toBeUndefined();
  });
});

it("revokes preview grants after access changes and hides previously shared answers", async () => {
  const f = await fixture();
  f.answer();
  const first = await f.grant();
  expect((await fetch(first.local)).status).toBe(200);
  f.bridge.config.slackAccess = { answers: false };
  expect((await fetch(first.local)).status).toBe(403);
  const second = await f.grant();
  const text = await (await fetch(second.local)).text();
  expect(text).not.toContain("Approved");
  f.bridge.config.slackAccess.status = false;
  expect((await fetch(second.local)).status).toBe(403);
  expect(f.bridge.embeds.metadata(f.b.key)).toBeUndefined();
});

describe("hosted custom panels", () => {
  it("uses Connect without a listener, scopes fragment grants, and clears access on expiry or policy changes", async () => {
    const f = await fixture();
    const base =
      "https://example.com/api/slack/tasks/00000000-0000-4000-8000-000000000001";
    const embeds = f.bridge.embeds;
    (embeds as any).deps.hostedBase = () => base;
    await embeds.configureHosted(true);
    expect(embeds.snapshot()).toMatchObject({
      viaConnect: true,
      listening: true,
      origin: "https://example.com",
    });
    await embeds.init();
    const entity = (embeds.metadata("task") as any).entities[0],
      entityId = entity.external_ref.id;
    const details = {
      ...f.details(),
      event: {
        ...f.details().event,
        external_ref: entity.external_ref,
        entity_url: entity.url,
      },
    };
    await f.bridge.receive(details, async () => {});
    const args = f.call.mock.calls
      .filter((c) => c[0] === "entity.presentDetails")
      .at(-1)![1];
    const preview = new URL(
      args.metadata.entity_payload.attributes.full_size_preview.preview_url,
    );
    expect(preview.search).toBe("");
    expect(preview.hash).toMatch(/^#key=/);
    const key = new URLSearchParams(preview.hash.slice(1)).get("key");
    const read = (patch = {}) =>
      embeds.hostedRead({ action: "data", entityId, key, ...patch });
    expect(read().status).toBe(200);
    const page = embeds.hostedRead({ action: "page", entityId });
    expect(page.status).toBe(200);
    expect(page.body).toContain("Opening your task");
    expect(page.body).not.toContain("alert(&quot;secret&quot;)");
    expect(page.headers["Content-Security-Policy"]).toContain(
      "connect-src https://example.com",
    );
    expect(read({ key: "bad" }).status).toBe(403);
    expect(read({ key: "x".repeat(43) }).status).toBe(403);
    expect(read({ entityId: randomUUID() }).status).toBe(403);
    expect(read({ entityId: "invalid" }).status).toBe(403);
    expect(read({ action: "exec" }).status).toBe(403);
    f.answer();
    f.bridge.config.routes[0].summaries = true; // policy changes invalidate the grant
    expect(read().status).toBe(403);
    await f.bridge.receive(
      { ...details, event: { ...details.event, trigger_id: randomUUID() } },
      async () => {},
    );
    const second = f.call.mock.calls
      .filter((c) => c[0] === "entity.presentDetails")
      .at(-1)![1];
    const secondKey = new URLSearchParams(
      new URL(
        second.metadata.entity_payload.attributes.full_size_preview.preview_url,
      ).hash.slice(1),
    ).get("key");
    expect(read({ key: secondKey }).body).toContain("answer");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + EMBED_TTL + 1);
    expect(read({ key: secondKey }).status).toBe(410);
    vi.restoreAllMocks();
    await embeds.configureHosted(false);
    expect(read().status).toBe(403);
    (embeds as any).deps.hostedBase = () => undefined;
    await expect(embeds.configureHosted(true)).rejects.toThrow("Connect");
    await embeds.dispose();
    await expect(embeds.configureHosted(false)).rejects.toThrow("changing");
  });
});

it("relinking cannot mint a preview for a task from the revoked connection", async () => {
  const f = await fixture();
  expect((await f.grant()).url).toBeDefined();
  await f.bridge.resetOwner();
  await f.connect();
  f.bridge.config.owner = "U123456";
  f.bridge.config.routes = [route];
  expect(f.bridge.embeds.metadata(f.b.key)).toBeUndefined();
  expect((await f.grant()).args.error.status).toBe("restricted");
});

it("projects only confirmed authorized rich results and revokes grants when the rich setting changes", async () => {
  const f = await fixture();
  const report = {
    title: "Private report",
    sections: [
      { type: "text" as const, title: "Finding", text: "Bounded finding" },
    ],
  };
  f.bridge.config.richResultsEnabled = true;
  f.answer({ state: "queued", result: report });
  const read = async (url: string) =>
    (await fetch(url, { headers: { Accept: "application/json" } })).json();
  let g = await f.grant();
  expect((await read(g.local)).result).toBeUndefined();
  f.answer({ result: report });
  expect((await read(g.local)).result).toEqual(report);
  f.bridge.config.richResultsEnabled = false;
  expect((await fetch(g.local)).status).toBe(403);
  g = await f.grant();
  expect((await read(g.local)).result).toBeUndefined();
  expect((await read(g.local)).answer).toContain("Approved");
  f.bridge.config.richResultsEnabled = true;
  f.bridge.config.slackAccess = { answers: false };
  g = await f.grant();
  expect((await read(g.local)).result).toBeUndefined();
  f.bridge.config.slackAccess.answers = true;
  // Agent results obey channel summary consent, unlike a manually composed operator answer.
  for (const d of f.store.list("delivery"))
    f.store.put("delivery", d.id, { ...d, origin: "agent", state: "sent" });
  g = await f.grant();
  expect((await read(g.local)).result).toBeUndefined();
  f.bridge.config.routes[0].summaries = true;
  g = await f.grant();
  expect((await read(g.local)).result).toEqual(report);
});
