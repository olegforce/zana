import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { openConnectDatabase } from "../connect/database.mjs";
import { createRegistry } from "../connect/registry.mjs";
import { createSlackService } from "./service.mjs";
import { createScopedSlack, slackClient } from "./api.mjs";
import {
  envelope,
  hash,
  rateLimiter,
  readBody,
  verifiedSlack,
} from "./security.mjs";

const identity = { team: "T123456", app: "A123456", bot: "U999999" };
const secret = "private-session-key";
const signing = "private-signing-key";
const internal = {
  id: "C123456",
  is_member: true,
  is_archived: false,
  is_shared: false,
  is_ext_shared: false,
  is_org_shared: false,
};
let db: any,
  connect: any,
  service: any,
  dispatch: any,
  call: any,
  clock: number;
beforeEach(async () => {
  clock = Date.now();
  db = await openConnectDatabase(":memory:", { production: false });
  await db.migrate();
  await db.query("CREATE TABLE users(id TEXT PRIMARY KEY,github_login TEXT)");
  await db.query(
    "CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id TEXT,expires_at BIGINT)",
  );
  for (const name of ["alice", "bob"]) {
    await db.query("INSERT INTO users VALUES($1,$1)", [name]);
    await db.query("INSERT INTO sessions VALUES($1,$1,$2)", [
      name,
      clock + 3600_000,
    ]);
  }
  connect = createRegistry(db, {
    domain: "connect.example.com",
    accountUrl: "https://example.com",
  });
  call = vi.fn(async (method: string, args: any) => {
    if (method === "users.info")
      return { ok: true, user: { id: args.user, real_name: "Test member" } };
    if (method === "users.conversations")
      return { ok: true, channels: [{ id: "C123456" }] };
    if (method === "conversations.list")
      return { ok: true, channels: [internal, { ...internal, id: "C987654" }] };
    if (method === "conversations.info") return { ok: true, channel: internal };
    if (method === "conversations.create")
      return { ok: true, channel: { id: "G123456", name: args.name } };
    if (method === "conversations.invite")
      return { ok: true, channel: { id: args.channel } };
    if (method === "conversations.rename")
      return { ok: true, channel: { id: args.channel, name: args.name } };
    return {
      ok: true,
      ts: "1790620000.000001",
      view: { id: args?.user_id ? `V${args.user_id}` : "V123456" },
    };
  });
  dispatch = vi.fn(async (args: any) => ({
    status: 200,
    body:
      JSON.parse(args.payload.body).kind === "probe"
        ? { linkId: args.payload.linkId }
        : { accepted: true, response: {} },
  }));
  service = await createSlackService({
    db,
    connect,
    dispatchPlugin: dispatch,
    pluginId: "test-plugin",
    sessionSecret: secret,
    signingSecret: signing,
    identity,
    call,
    now: () => clock,
    intervalMs: 100_000,
  });
});
it("admits verified owner DMs, legacy starts and modern stop events without widening channel browsing", async () => {
  const a = await link(), original = call.getMockImplementation();
  call.mockImplementation(async (m: string, args: any) => m === "conversations.info" && args.channel === "D123456" ? { ok: true, channel: { id: "D123456", user: "U123456", is_im: true } } : original(m, args));
  const root = `${Math.floor(clock / 1000)}.000001`;
  const dm = { ...event(), event_id: "EvDM", event: { type: "message", channel: "D123456", user: "U123456", text: "Review my Project", ts: root } };
  expect((await ingress(dm)).status).toBe(200); await service.drain();
  const scoped = createScopedSlack({ call, registry: service.registry, identity, origin: "https://example.com" });
  expect(await scoped.proxy(a.link, "agents.sessions.setStatus", { channel_id: "D123456", thread_ts: root, status: "processing", initiator_user_id: "U123456", title: "Review" })).toHaveProperty("ok", true);
  expect((await scoped.proxy(a.link, "conversations.list", {})).channels.every((c: any) => !c.id.startsWith("D"))).toBe(true);
  expect((await ingress({ ...dm, event_id: "stop", event: { type: "agent_session_stopped", channel: "D123456", user: "U123456", thread_ts: root, event_ts: root } })).status).toBe(200);
  expect((await ingress({ ...dm, event_id: "start", event: { type: "assistant_thread_started", assistant_thread: { user_id: "U123456", channel_id: "D123456", thread_ts: root }, event_ts: root } })).status).toBe(200);
  await expect(scoped.proxy(a.link, "agents.sessions.setStatus", { channel_id: "D123456", thread_ts: root, status: "processing", initiator_user_id: "U234567" })).rejects.toThrow("invalid_status");
  await expect(scoped.proxy(a.link, "assistant.threads.setSuggestedPrompts", { channel_id: "D123456", thread_ts: root, prompts: [{ title: "Review", message: "Review project" }] })).resolves.toHaveProperty("ok", true);
  await expect(scoped.proxy(a.link, "assistant.threads.setStatus", { channel_id: "D123456", thread_ts: root, status: "" })).resolves.toHaveProperty("ok", true);
  await expect(scoped.proxy(a.link, "assistant.threads.setStatus", { channel_id: "D123456", thread_ts: root, status: 1 })).rejects.toThrow("invalid_status");
  await expect(scoped.proxy(a.link, "assistant.threads.setSuggestedPrompts", { channel_id: "D123456", thread_ts: root, prompts: [{}] })).rejects.toThrow("invalid_prompts");
  await expect(scoped.proxy(a.link, "agents.sessions.setStatus", { channel_id: "D123456", thread_ts: "bad", status: "active" })).rejects.toThrow("invalid_timestamp");
  await expect(scoped.proxy(a.link, "conversations.info", { channel: "D987654" })).rejects.toThrow();
  call.mockImplementation(async (m: string, args: any) => m === "conversations.info" && args.channel === "D123456" ? { ok: true, channel: { id: "D123456", user: "U234567", is_im: true } } : original(m, args));
  expect((await ingress({ ...dm, event_id: "forged" })).status).toBe(403);
  await expect(scoped.proxy(a.link, "conversations.info", { channel: "D123456" })).rejects.toThrow("channel_not_owned");
});
it("scopes Canvas creation to an owned conversation and owner access to a delivered private Canvas", async () => {
  const a = await link(), original = call.getMockImplementation();
  await service.registry.bind(a.link, "C123456", "1790620000.000001");
  const scoped = createScopedSlack({ call, registry: service.registry, identity, origin: "https://example.com" });
  call.mockImplementation(async (m: string, args: any) => m === "canvases.create" ? { ok: true, canvas_id: "F123456" } : m === "conversations.info" && args.channel === "D123456" ? { ok: true, channel: { id: "D123456", user: "U123456", is_im: true } } : original(m, args));
  const args = { conversation_channel: "C123456", conversation_ts: "1790620000.000001", channel_id: "C123456", title: "Review", document_content: { type: "markdown", markdown: "Shared answer" } };
  expect(await scoped.proxy(a.link, "canvases.create", args)).toHaveProperty("canvas_id", "F123456");
  expect(call).toHaveBeenCalledWith("canvases.create", { channel_id: "C123456", title: "Review", document_content: args.document_content });
  const grant = { canvas_id: "F123456", access_level: "read", user_ids: ["U123456"] };
  await expect(scoped.proxy(a.link, "canvases.access.set", grant)).rejects.toThrow();
  await expect(scoped.proxy(a.link, "canvases.create", { ...args, channel_id: "C987654" })).rejects.toThrow("invalid_canvas");
  await expect(scoped.proxy(a.link, "canvases.create", { ...args, document_content: { type: "html", markdown: "bad" } })).rejects.toThrow("invalid_canvas");
  await expect(scoped.proxy(a.link, "canvases.create", { ...args, conversation_ts: "bad" })).rejects.toThrow("invalid_timestamp");
  await service.registry.remember(a.link, `${a.link.id}:D123456`, "agent-dm"); await service.registry.bind(a.link, "D123456", args.conversation_ts);
  const postsBefore = call.mock.calls.filter(([method]: any[]) => method === "chat.postMessage").length;
  await expect(scoped.proxy(a.link, "chat.postMessage", { channel: "D123456", thread_ts: args.conversation_ts, text: "Canvas: https://app.slack.com/docs/T123456/F987654" })).rejects.toThrow();
  expect(call.mock.calls.filter(([method]: any[]) => method === "chat.postMessage")).toHaveLength(postsBefore);
  await scoped.proxy(a.link, "chat.postMessage", { channel: "D123456", thread_ts: args.conversation_ts, text: "Canvas: https://app.slack.com/docs/T123456/F123456" });
  await expect(scoped.proxy(a.link, "canvases.access.set", grant)).resolves.toHaveProperty("ok", true);
  for (const bad of [{ ...grant, access_level: "write" }, { ...grant, user_ids: ["U234567"] }, { ...grant, channel_ids: ["C123456"] }, { ...grant, canvas_id: "F987654" }]) await expect(scoped.proxy(a.link, "canvases.access.set", bad)).rejects.toThrow();
  await expect(scoped.proxy(a.link, "canvases.create", { ...args, conversation_channel: "D123456" })).rejects.toThrow("invalid_canvas");
  await expect(scoped.proxy(a.link, "canvases.edit", { canvas_id: "F123456" })).rejects.toThrow("method_not_allowed");
});
it("rejects a channel lookup whose Slack response names a different channel", async () => {
  const a = await link(), original = call.getMockImplementation();
  const scoped = createScopedSlack({ call, registry: service.registry, identity, origin: "https://example.com" });
  call.mockImplementation(async (method: string, args: any) => method === "conversations.info" ? { ok: true, channel: { ...internal, id: "C987654" } } : original(method, args));
  await expect(scoped.proxy(a.link, "chat.postMessage", { channel: "C123456", text: "Test" })).rejects.toThrow("channel_not_allowed");
  expect(call.mock.calls.some(([method]: any[]) => method === "chat.postMessage")).toBe(false);
});
afterEach(async () => {
  await service.close();
  await db.close();
});
async function server(owner: string) {
  const code = await connect.startEnrollment(`${owner}'s laptop`);
  await connect.approveEnrollment(owner, code.userCode, true);
  return connect.pollEnrollment(code.deviceCode);
}
const cookie = (id: string) =>
  `zcc_session=${id}.${createHmac("sha256", secret).update(id).digest("base64url")}`;
async function api(
  path: string,
  input?: any,
  credential?: string,
  account = "alice",
  extra = {},
) {
  return service.dispatch(
    new Request(`https://example.com/api/connect/slack/${path}`, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(credential
          ? { authorization: `Bearer ${credential}` }
          : { cookie: cookie(account), origin: "https://example.com" }),
        ...extra,
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    }),
  );
}
async function link(owner = "alice", user = "U123456") {
  const computer = await server(owner);
  const code = await service.registry.start(user);
  const approved = await (
    await api(
      "approve",
      { code, serverId: computer.serverId, approved: true },
      undefined,
      owner,
    )
  ).json();
  const grant = await (
    await api("redeem", { code: approved.activationCode })
  ).json();
  expect((await api("activate", {}, grant.credential)).status).toBe(200);
  return {
    ...grant,
    serverId: computer.serverId,
    link: await service.registry.owner(user),
  };
}
it('adds only the linked owner’s machines to Home, preserves controls and needs no channel posts', async () => {
  const a = await link(), other = await server('alice'), outsider = await server('bob');
  await db.query('UPDATE connect_servers SET name=$1 WHERE id=$2', ['Other computer', other.serverId]);
  await db.query('UPDATE connect_servers SET name=$1 WHERE id=$2', ['BOB PRIVATE COMPUTER', outsider.serverId]);
  await connect.markSeen(a.serverId);
  call.mockClear();
  const view = { type: 'home', callback_id: 'zana_home_v1', private_metadata: 'private-token', blocks: [{ type: 'header', text: { type: 'plain_text', text: 'Your agents' } }, { type: 'divider' }, { type: 'actions', elements: [{ type: 'button', action_id: 'home_stop', text: { type: 'plain_text', text: 'Stop' } }] }] };
  expect((await api('call', { method: 'views.publish', args: { user_id: a.owner, view } }, a.credential)).status).toBe(200);
  const published = call.mock.calls.find(([method]: any) => method === 'views.publish')![1].view;
  expect(published).toMatchObject({ callback_id: view.callback_id, private_metadata: view.private_metadata });
  const text = JSON.stringify(published);
  expect(text).toContain("alice's laptop · 🟢 Online · Linked to Slack");
  expect(text).toContain('Other computer · ⚪ Offline');
  expect(text).toContain('home_stop');
  expect(text).not.toContain('BOB PRIVATE COMPUTER');
  expect(text).not.toContain(a.credential);
  expect(call.mock.calls.map(([method]: any) => method)).toEqual(['views.publish']);
  expect((await api('call', { method: 'views.publish', args: { user_id: 'U234567', view } }, a.credential)).status).toBe(403);
  expect((await ingress({ type: 'block_actions', team: { id: identity.team }, api_app_id: identity.app, user: { id: a.owner }, actions: [{ action_id: 'connect_manage_machines' }] })).status).toBe(200);
  expect(call).toHaveBeenCalledTimes(1);
  await service.registry.revoke(a.link.id, 'alice');
  expect((await api('call', { method: 'views.publish', args: { user_id: a.owner, view } }, a.credential)).status).toBe(401);
});
it('shows account machines when the linked computer is offline and refresh recovers through the owner Home path', async () => {
  const a = await link();
  const original = dispatch.getMockImplementation()!;
  dispatch.mockRejectedValue(new Error('computer_offline'));
  const home = { type: 'event_callback', team_id: identity.team, api_app_id: identity.app, event_id: 'EvHomeMachines', event: { type: 'app_home_opened', user: a.owner, tab: 'home' } };
  await ingress(home); await service.drain();
  let published = call.mock.calls.filter(([method]: any) => method === 'views.publish').at(-1)![1].view;
  expect(JSON.stringify(published)).toContain("alice's laptop · ⚪ Offline · Linked to Slack");
  expect(JSON.stringify(published)).toContain('connect_home_refresh');
  const refresh = { type: 'block_actions', team: { id: identity.team }, api_app_id: identity.app, user: { id: a.owner }, view: { ...published, id: 'VOFFLINE' }, actions: [{ action_id: 'connect_home_refresh' }] };
  await ingress(refresh); await service.drain();
  expect(call.mock.calls.filter(([method]: any) => method === 'views.publish')).toHaveLength(2);
  dispatch.mockImplementation(original);
  const recovered = { ...refresh, actions: [{ action_id: 'connect_home_refresh', action_ts: 'new' }] };
  await ingress(recovered); await service.drain();
  expect(JSON.parse(dispatch.mock.calls.at(-1)![0].payload.body).payload).toMatchObject({ type: 'event_callback', event: { type: 'app_home_opened', user: a.owner } });
  expect(call.mock.calls.filter(([method]: any) => method.startsWith('chat.'))).toHaveLength(0);
  // Existing plugin Refresh also replaces a stale dashboard when it goes offline.
  await service.registry.remember(a.link, 'VHOME', 'view');
  dispatch.mockRejectedValue(new Error('computer_offline'));
  await ingress({ ...refresh, view: { type: 'home', id: 'VHOME' }, actions: [{ action_id: 'home_refresh' }] });
  published = call.mock.calls.filter(([method]: any) => method === 'views.publish').at(-1)![1].view;
  expect(JSON.stringify(published)).toContain('Machines');
  expect((await ingress({ ...refresh, team: { id: 'T987654' } })).status).toBe(403);
});
it('does not expose account machines if the link is revoked while a Home request is being delivered', async () => {
  const a = await link();
  dispatch.mockImplementation(async () => {
    await service.registry.revoke(a.link.id, 'alice');
    throw new Error('computer_offline');
  });
  const inventory = vi.spyOn(connect, 'listServers');
  await ingress({ type: 'event_callback', team_id: identity.team, api_app_id: identity.app, event_id: 'EvRevokedHome', event: { type: 'app_home_opened', user: a.owner, tab: 'home' } });
  await service.drain();
  const view = call.mock.calls.filter(([method]: any) => method === 'views.publish').at(-1)![1].view;
  expect(JSON.stringify(view)).not.toContain("alice's laptop");
  expect(inventory).not.toHaveBeenCalled();
});
it.each(["Acme Engineering", undefined])("enriches only the matching workspace with its known name (%s) and keeps account lists private", async teamName => {
  const current = await link();
  const previous = await link("alice", "U234567");
  await link("bob", "U345678");
  await db.query("UPDATE slack_links SET team_id=$1 WHERE id=$2", ["T987654", previous.link.id]);
  await service.close();
  service = await createSlackService({ db, connect, dispatchPlugin: dispatch, pluginId: "test-plugin", sessionSecret: secret, signingSecret: signing, identity: { ...identity, teamName }, call, now: () => clock, intervalMs: 100_000 });
  call.mockClear();
  const response = await api("links");
  expect(response.status).toBe(200);
  const { links } = await response.json();
  expect(links).toHaveLength(2);
  expect(links.find((row: any) => row.id === current.link.id)).toMatchObject({ team_id: identity.team, team_name: teamName ?? null });
  expect(links.find((row: any) => row.id === previous.link.id)).toMatchObject({ team_id: "T987654", team_name: null });
  expect((await api("links", undefined, undefined, "unknown")).status).toBe(401);
  expect(call).not.toHaveBeenCalled();
});
function event(user = "U123456", id = "Ev1", root?: string) {
  return {
    type: "event_callback",
    event_id: id,
    team_id: identity.team,
    api_app_id: identity.app,
    event: {
      type: "app_mention",
      user,
      channel: "C123456",
      ts: `${Math.floor(clock / 1000)}.000001`,
      text: "<@U999999> run hello",
      ...(root ? { thread_ts: root } : {}),
    },
  };
}
async function ingress(payload: any, signature = true, form = false) {
  const raw = form
    ? new URLSearchParams({ payload: JSON.stringify(payload) }).toString()
    : JSON.stringify(payload);
  const time = String(Math.floor(clock / 1000));
  return service.dispatch(
    new Request("https://example.com/api/slack/events", {
      method: "POST",
      headers: {
        "content-type": form
          ? "application/x-www-form-urlencoded"
          : "application/json",
        "x-slack-request-timestamp": time,
        "x-slack-signature": signature
          ? `v0=${createHmac("sha256", signing).update(`v0:${time}:${raw}`).digest("hex")}`
          : "bad",
      },
      body: raw,
    }),
  );
}
it("requires verified Slack, existing account ownership and a successful probe of the chosen computer", async () => {
  expect((await ingress(event(), false)).status).toBe(401);
  expect(
    await (
      await ingress({ type: "url_verification", challenge: "challenge" })
    ).json(),
  ).toEqual({ challenge: "challenge" });
  expect((await ingress({ ...event(), team_id: "T987654" })).status).toBe(403);
  const alice = await server("alice"),
    bob = await server("bob");
  const code = await service.registry.start("U123456");
  expect((await api(`info?code=${code}`)).status).toBe(200);
  expect(
    (await api("approve", { code, serverId: bob.serverId, approved: true }))
      .status,
  ).toBe(403);
  expect(
    (await api("approve", { code, serverId: alice.serverId })).status,
  ).toBe(400);
  const approved = await (
    await api("approve", { code, serverId: alice.serverId, approved: true })
  ).json();
  expect(
    (await api("approve", { code, serverId: alice.serverId, approved: true }))
      .status,
  ).toBe(410);
  const grant = await (
    await api("redeem", { code: approved.activationCode })
  ).json();
  expect((await api("status", {}, grant.credential)).status).toBe(401);
  dispatch.mockResolvedValueOnce({ status: 404, body: {} });
  expect((await api("activate", {}, grant.credential)).status).toBe(409);
  expect((await api("activate", {}, grant.credential)).status).toBe(200);
  expect(dispatch.mock.calls.at(-1)[0]).toMatchObject({
    accountId: "alice",
    serverId: alice.serverId,
    pluginId: "test-plugin",
  });
  const signed = dispatch.mock.calls.at(-1)[0].payload;
  const { signature, ...message } = signed;
  expect(signature).toBe(
    createHmac("sha256", grant.credential.split(".")[1])
      .update(JSON.stringify(message))
      .digest("hex"),
  );
  expect((await api("activate", {}, grant.credential)).status).toBe(200);
  expect((await api("redeem", { code: approved.activationCode })).status).toBe(
    410,
  );
  expect((await api("links")).status).toBe(200);
  expect(
    (await api("revoke", { id: grant.linkId }, undefined, "bob")).status,
  ).toBe(404);
  expect((await api("status", {}, `${grant.linkId}.wrong`)).status).toBe(401);
});
it("shows the owned computer during connection approval without revealing another owner's target", async () => {
  const a = await server("alice");
  await connect.claimAddress("alice", a.serverId, "alice-zana");
  const computer = (await connect.listServers("alice"))[0];
  const code = await service.registry.start("U123456", computer.address);
  const response = await api(`info?code=${encodeURIComponent(code)}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ serverId: a.serverId, userId: "U123456" });
  expect((await api(`info?code=${encodeURIComponent(code)}`, undefined, undefined, "bob")).status).toBe(403);
});
it("routes plain channel replies only to the existing thread's launcher and deduplicates them", async () => {
  const a = await link(); await link("bob", "U234567");
  const first = event(); await ingress(first); await service.drain();
  clock += 1000; dispatch.mockClear();
  const reply = { ...first, event_id: "EvPlain", event: { ...first.event, type: "message", thread_ts: first.event.ts, ts: `${Math.floor(clock / 1000)}.000002`, text: "My study plan?" } };
  expect((await ingress(reply)).status).toBe(200); await service.drain();
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch.mock.calls[0][0].serverId).toBe(a.serverId);
  expect(JSON.parse(dispatch.mock.calls[0][0].payload.body).payload.event.text).toBe("My study plan?");
  await ingress(reply); await service.drain(); expect(dispatch).toHaveBeenCalledTimes(1);
  await ingress({ ...reply, event_id: "EvForeign", event: { ...reply.event, user: "U234567" } }); await service.drain();
  await ingress({ ...reply, event_id: "EvUnlinked", event: { ...reply.event, user: "U345678" } }); await service.drain();
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect((await db.query("SELECT * FROM slack_conversations"))).toHaveLength(1);
  expect((await db.query("SELECT * FROM slack_requests"))).toHaveLength(2);
});
it("ignores ambient channel messages, invalid replies and mention duplicates before storing or forwarding", async () => {
  await link(); const first = event(); await ingress(first); await service.drain();
  clock += 1000; dispatch.mockClear();
  const reply = { ...first, event_id: "EvPlain", event: { ...first.event, type: "message", thread_ts: first.event.ts, ts: `${Math.floor(clock / 1000)}.000002`, text: "Continue" } };
  const patches = [
    { thread_ts: undefined }, { thread_ts: "bad" }, { thread_ts: "1790000000.123456" },
    { ts: first.event.ts }, { ts: "bad" }, { ts: "1790000000.123456" },
    { hidden: true }, { subtype: "message_changed" }, { bot_id: "B123456" },
    { text: " " }, { text: 1 }, { text: "x".repeat(12001) },
    { text: `<@${identity.bot}> Continue` },
  ];
  for (const [i, patch] of patches.entries()) {
    expect((await ingress({ ...reply, event_id: `ignored-${i}`, event: { ...reply.event, ...patch } })).status).toBe(200);
  }
  await service.drain(); expect(dispatch).not.toHaveBeenCalled();
  expect((await db.query("SELECT * FROM slack_requests"))).toHaveLength(1);
  expect((await db.query("SELECT * FROM slack_conversations"))).toHaveLength(1);
});
it.each(["is_shared", "is_ext_shared", "is_org_shared", "is_archived", "is_im", "is_mpim", "not member", "wrong id", "unknown flags", "api error"])("rejects channel replies when the destination is %s", async condition => {
  await link(); const first = event(); await ingress(first); await service.drain();
  clock += 1000; dispatch.mockClear();
  const channel: any = { ...internal };
  if (condition.startsWith("is_")) channel[condition] = true;
  if (condition === "not member") channel.is_member = false;
  if (condition === "wrong id") channel.id = "C987654";
  if (condition === "unknown flags") delete channel.is_shared;
  call.mockResolvedValue({ ok: condition !== "api error", channel });
  expect((await ingress({ ...first, event_id: "EvPlain", event: { ...first.event, type: "message", thread_ts: first.event.ts, ts: `${Math.floor(clock / 1000)}.000002`, text: "Continue" } })).status).toBe(200);
  await service.drain(); expect(dispatch).not.toHaveBeenCalled();
});
it("routes two owners to their own laptops, deduplicates retries and rejects cross-user thread controls", async () => {
  const a = await link(),
    b = await link("bob", "U234567");
  dispatch.mockClear();
  const first = event();
  expect((await ingress(first)).status).toBe(200);
  await service.drain();
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch.mock.calls[0][0].serverId).toBe(a.serverId);
  await ingress(first);
  await service.drain();
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect((await ingress(event("U234567", "Ev2", first.event.ts))).status).toBe(
    403,
  );
  clock += 1000;
  await ingress(event("U234567", "Ev3"));
  await service.drain();
  expect(dispatch.mock.calls.at(-1)[0].serverId).toBe(b.serverId);
  expect(
    (await db.query("SELECT state FROM slack_requests")).map(
      (r: any) => r.state,
    ),
  ).toEqual(["delivered", "delivered"]);
  await api("unlink", {}, a.credential);
  expect(
    (await api("call", { method: "auth.test" }, a.credential)).status,
  ).toBe(401);
  expect((await api("status", {}, b.credential)).status).toBe(200);
});
it("distinguishes definitely offline from uncertain execution and never replays either", async () => {
  await link();
  dispatch.mockClear();
  dispatch.mockRejectedValueOnce(new Error("computer_offline"));
  const first = event();
  await ingress(first);
  await service.drain();
  expect((await db.query("SELECT state FROM slack_requests"))[0].state).toBe(
    "not-started",
  );
  clock += 1000;
  dispatch.mockRejectedValueOnce(new Error("lost response"));
  const second = event("U123456", "Ev2");
  await ingress(second);
  await service.drain();
  expect(
    await db.query("SELECT * FROM slack_requests WHERE state='needs-review'"),
  ).toHaveLength(1);
  await ingress(second);
  await service.drain();
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(
    call.mock.calls.some(
      (c: any) =>
        c[0] === "chat.postEphemeral" && c[1].text.includes("unconfirmed"),
    ),
  ).toBe(true);
  clock += 1000;
  dispatch.mockResolvedValueOnce({
    status: 504,
    body: { accepted: false, notStarted: false },
  });
  await ingress(event("U123456", "Ev3"));
  await service.drain();
  expect(
    await db.query("SELECT * FROM slack_requests WHERE state='needs-review'"),
  ).toHaveLength(2);
});
it("preserves modal acknowledgements, binds triggers and blocks foreign views", async () => {
  const a = await link();
  await service.registry.remember(a.link, "V123456", "view");
  const payload = {
    type: "view_submission",
    team: { id: identity.team },
    user: { id: "U123456" },
    api_app_id: identity.app,
    trigger_id: "trigger",
    view: { id: "V123456" },
  };
  dispatch.mockResolvedValueOnce({
    status: 200,
    body: {
      accepted: true,
      response: { response_action: "errors", errors: { task: "Required" } },
    },
  });
  expect(await (await ingress(payload, true, true)).json()).toMatchObject({
    response_action: "errors",
  });
  expect(await (await ingress(payload, true, true)).json()).toMatchObject({
    response_action: "errors",
  });
  expect((await ingress({ ...payload, view: { id: "VOTHER" } })).status).toBe(
    403,
  );
  dispatch.mockRejectedValueOnce(new Error("lost response"));
  expect(
    await (await ingress({ ...payload, trigger_id: "next" })).json(),
  ).toMatchObject({
    response_action: "update",
    view: { title: { text: "Check Zana" } },
  });
});
it("scopes Slack APIs to the owner, membership, owned messages, threads and views", async () => {
  const a = await link();
  const proxy = createScopedSlack({
    call,
    registry: service.registry,
    identity,
  });
  expect(await proxy.proxy(a.link, "auth.test", {})).toMatchObject({
    user_id: identity.bot,
  });
  expect(
    await proxy.proxy(a.link, "users.info", { user: "U123456" }),
  ).toHaveProperty("user");
  expect(
    (await proxy.proxy(a.link, "conversations.list", {})).channels,
  ).toHaveLength(1);
  for (const [method, args] of [
    ["users.info", { user: "U234567" }],
    ["conversations.info", { channel: "C987654" }],
    ["conversations.create", { name: "general", is_private: true }],
    [
      "conversations.create",
      { name: "zana-project-123456", is_private: false },
    ],
    ["conversations.invite", { channel: "G123456", users: "U234567" }],
    ["conversations.rename", { channel: "G123456", name: "general" }],
    [
      "conversations.rename",
      { channel: "G987654", name: "team-zana-project" },
    ],
    ["files.upload", {}],
    ["views.publish", { user_id: "U234567" }],
    ["views.open", { trigger_id: "foreign", view: { type: "modal" } }],
    ["chat.update", { channel: "C123456", ts: "1790620000.000001" }],
    [
      "chat.getPermalink",
      { channel: "C123456", message_ts: "1790620000.000001" },
    ],
  ])
    await expect(proxy.proxy(a.link, method, args)).rejects.toThrow();
  const created = await proxy.proxy(a.link, "conversations.create", {
    name: "zana-project-123456",
    is_private: true,
  });
  expect(created).toEqual({
    ok: true,
    channel: { id: "G123456", name: "zana-project-123456" },
  });
  await proxy.proxy(a.link, "conversations.invite", {
    channel: "G123456",
    users: "U123456",
  });
  expect(call).toHaveBeenCalledWith("conversations.create", {
    name: "zana-project-123456",
    is_private: true,
  });
  const prefixed = await proxy.proxy(a.link, "conversations.create", {
    name: "team-one-zana-website-app",
    is_private: true,
  });
  expect(prefixed).toMatchObject({ ok: true, channel: { id: "G123456" } });
  expect(call).toHaveBeenCalledWith("conversations.invite", {
    channel: "G123456",
    users: "U123456",
  });
  await proxy.proxy(a.link, "conversations.rename", {
    channel: "G123456",
    name: "team-zana-project",
  });
  expect(call).toHaveBeenCalledWith("conversations.rename", {
    channel: "G123456",
    name: "team-zana-project",
  });
  vi.spyOn(service.registry, "count").mockResolvedValueOnce(250);
  await expect(
    proxy.proxy(a.link, "conversations.create", {
      name: "zana-over-limit-654321",
      is_private: true,
    }),
  ).rejects.toThrow("project_channel_limit");
  const message = await proxy.proxy(a.link, "chat.postMessage", {
    channel: "C123456",
    text: "hello",
  });
  await proxy.proxy(a.link, "chat.update", {
    channel: "C123456",
    ts: message.ts,
    text: "done",
  });
  await proxy.proxy(a.link, "chat.postMessage", {
    channel: "C123456",
    thread_ts: message.ts,
    text: "reply",
  });
  await proxy.proxy(a.link, "chat.getPermalink", {
    channel: "C123456",
    message_ts: message.ts,
  });
  await proxy.proxy(a.link, "views.publish", {
    user_id: "U123456",
    view: { type: "home" },
  });
  await service.registry.remember(a.link, "trigger", "trigger", 3000);
  await proxy.proxy(a.link, "views.open", {
    trigger_id: "trigger",
    view: { type: "modal" },
  });
  await proxy.proxy(a.link, "views.update", {
    view_id: "V123456",
    view: { type: "modal" },
    hash: "hash",
  });
  await proxy.proxy(a.link, "views.push", {
    trigger_id: "trigger",
    view: { type: "modal" },
  });
  clock += 4000;
  await expect(
    proxy.proxy(a.link, "views.open", {
      trigger_id: "trigger",
      view: { type: "modal" },
    }),
  ).rejects.toThrow();
});
it("onboards privately, rejects expired/replaced grants and fails closed after computer revocation", async () => {
  await ingress({
    ...event(),
    event: { type: "app_home_opened", tab: "home", user: "U123456" },
  });
  await vi.waitFor(() =>
    expect(
      call.mock.calls.some(
        (c: any) =>
          c[0] === "views.publish" &&
          c[1].view.blocks.at(-1).type === "actions",
      ),
    ).toBe(true),
  );
  const a = await link();
  const old = a.credential;
  const code = await service.registry.start("U123456");
  const bob = await server("bob");
  expect(
    (
      await api(
        "approve",
        { code, serverId: bob.serverId, approved: true },
        undefined,
        "bob",
      )
    ).status,
  ).toBe(409);
  const replacement = await link();
  expect((await api("status", {}, old)).status).toBe(401);
  await connect.revoke("alice", "server", replacement.serverId);
  expect((await api("status", {}, replacement.credential)).status).toBe(401);
  clock += 700_000;
  expect((await api(`info?code=${code}`)).status).toBe(410);
  await service.registry.prune();
});

it("offers private domain setup through the native slash command before and after linking", async () => {
  const payload = {
    team_id: identity.team,
    api_app_id: identity.app,
    user_id: "U123456",
    command: "/zana",
    text: "connect alice-work.connect.example.com",
  };
  const response = await (await ingress(payload, true, true)).json();
  expect(response.response_type).toBe("ephemeral");
  expect(response.blocks[0].text.text).toContain(
    "alice-work.connect.example.com",
  );
  const code = new URL(response.blocks[1].elements[0].url).searchParams.get(
    "slack",
  );
  expect(await service.registry.info(code)).toMatchObject({
    domain: "alice-work",
    slack_user: "U123456",
  });
  expect(dispatch).not.toHaveBeenCalled();
  expect(call).not.toHaveBeenCalled();
  await link();
  dispatch.mockClear();
  expect(
    (await (await ingress({ ...payload, text: "connect" }, true, true)).json())
      .blocks[1].elements[0].url,
  ).toContain("/connect/?slack=");
  expect(dispatch).not.toHaveBeenCalled();
  expect(
    (
      await (
        await ingress(
          { ...payload, text: "connect https://evil.example" },
          true,
          true,
        )
      ).json()
    ).text,
  ).toContain("Use /zana connect");
  expect(
    await (
      await ingress(
        {
          type: "block_actions",
          team: { id: identity.team },
          user: { id: "U123456" },
          api_app_id: identity.app,
          actions: [{ action_id: "connect_account" }],
        },
        true,
        true,
      )
    ).json(),
  ).toEqual({});
  expect(dispatch).not.toHaveBeenCalled();
});

it("keeps the Home connect action visible instead of racing a second Home publication", async () => {
  await ingress({
    ...event(),
    event: { type: "app_home_opened", tab: "home", user: "U123456" },
  });
  await vi.waitFor(() =>
    expect(call).toHaveBeenCalledWith("views.publish", expect.anything()),
  );
  await service.close();
  expect(
    call.mock.calls.filter(([method]: any) => method === "views.publish"),
  ).toHaveLength(1);
  expect(call.mock.calls[0][1].view.blocks.at(-1).elements[0].text.text).toBe(
    "Connect my computer",
  );
});
it("bounds and validates the HTTP surface, cookies, origins, bodies and signatures", async () => {
  expect((await api("links", undefined, undefined, "unknown")).status).toBe(
    401,
  );
  expect(
    (
      await api("revoke", {}, undefined, "alice", {
        origin: "https://evil.example",
      })
    ).status,
  ).toBe(403);
  expect((await api("nonesuch")).status).toBe(404);
  expect((await api("redeem", { code: "bad" })).status).toBe(400);
  expect((await api("info?code=bad")).status).toBe(400);
  expect(
    (
      await service.dispatch(
        new Request("https://other.example/api/connect/slack/links"),
      )
    ).status,
  ).toBe(503);
  await expect(
    readBody(
      new Request("https://example.com", {
        method: "POST",
        body: "a".repeat(300_000),
      }),
    ),
  ).rejects.toThrow("body_too_large");
  expect(verifiedSlack(Buffer.from(""), new Headers(), signing)).toBe(false);
  expect(envelope({ id: "id" }, secret, {}).signature).toHaveLength(64);
  const limited = rateLimiter(() => clock);
  limited("one", 1);
  expect(() => limited("one", 1)).toThrow();
  clock += 60_000;
  expect(() => limited("one", 1)).not.toThrow();
});
it("bounds direct Slack responses and never retries an ambiguous write", async () => {
  const fetcher = vi.fn(async () => Response.json({ ok: true }));
  const client = slackClient("private", fetcher);
  await client("chat.postMessage", { text: "hi" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "error" });
  await client("users.conversations", {
    user: "U123456",
    types: "private_channel",
    exclude_archived: true,
    limit: 200,
  });
  expect(fetcher.mock.calls[1][1]).toMatchObject({
    headers: expect.objectContaining({
      "content-type": "application/x-www-form-urlencoded",
    }),
    body: "user=U123456&types=private_channel&exclude_archived=true&limit=200",
  });
  await client("conversations.info", { channel: "C123456" });
  expect(fetcher.mock.calls[2][1]).toMatchObject({
    headers: expect.objectContaining({
      "content-type": "application/x-www-form-urlencoded",
    }),
    body: "channel=C123456",
  });
  await expect(client("../bad")).rejects.toThrow();
  await expect(
    client("chat.postMessage", { text: "x".repeat(300_000) }),
  ).rejects.toThrow();
  fetcher.mockResolvedValueOnce(new Response("error", { status: 429 }));
  await expect(client("auth.test")).rejects.toThrow("slack_rate_limited");
  fetcher.mockResolvedValueOnce(new Response("x".repeat(300_000)));
  await expect(client("auth.test")).rejects.toThrow("slack_response_too_large");
  fetcher.mockResolvedValueOnce(
    Response.json({ ok: false, error: "invalid_auth" }),
  );
  expect(await client("auth.test")).toEqual({
    ok: false,
    error: "invalid_auth",
  });
});

it('confines generated image uploads and reuse to the owning conversation', async () => {
  const alice = await link(), bob = await link('bob', 'U234567');
  const root = '1791050000.000001';
  await service.registry.bind(alice.link, internal.id, root);
  const original = call.getMockImplementation();
  call.mockImplementation(async (method: string, args: any) => method === 'files.uploadDiagram' ? { ok: true, file_id: 'F987654' } : original(method, args));
  const scoped = createScopedSlack({ call, registry: service.registry, identity });
  const args = { channel: internal.id, thread_ts: root, png: Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex').toString('base64') };
  await expect(scoped.proxy(bob.link, 'files.uploadDiagram', args)).rejects.toThrow('conversation_not_owned');
  await expect(scoped.proxy(alice.link, 'files.uploadDiagram', { ...args, thread_ts: 'bad' })).rejects.toThrow('invalid_timestamp');
  await expect(scoped.proxy(alice.link, 'files.uploadDiagram', { ...args, png: 'bad' })).rejects.toThrow('invalid_diagram');
  expect(await scoped.proxy(alice.link, 'files.uploadDiagram', args)).toMatchObject({ ok: true, file_id: 'F987654' });
  expect(call.mock.calls.find(([m]: any) => m === 'files.uploadDiagram')[1]).toEqual({ png: args.png });
  const image = { type: 'image', slack_file: { id: 'F987654' }, alt_text: 'Diagram' };
  await expect(scoped.proxy(alice.link, 'chat.postMessage', { channel: internal.id, thread_ts: root, text: 'Architecture', blocks: [image] })).resolves.toHaveProperty('ok', true);
  await expect(scoped.proxy(alice.link, 'chat.update', { channel: internal.id, conversation_ts: root, ts: '1790620000.000001', text: 'Updated', blocks: [image] })).resolves.toHaveProperty('ok', true);
  await expect(scoped.proxy(alice.link, 'chat.postMessage', { channel: internal.id, thread_ts: root, text: 'Unknown file', blocks: [{ ...image, slack_file: { id: 'FOTHER1' } }] })).rejects.toThrow('object_not_owned');
  await expect(scoped.proxy(alice.link, 'chat.postMessage', { channel: internal.id, thread_ts: root, text: 'URL', blocks: [{ ...image, image_url: 'https://evil.example' }] })).rejects.toThrow('invalid_diagram_image');
  await expect(scoped.proxy(alice.link, 'chat.postMessage', { channel: internal.id, thread_ts: root, text: 'Nested foreign file', blocks: [{ type: 'section', accessory: { ...image, slack_file: { id: 'FOTHER1' } } }] })).rejects.toThrow('object_not_owned');
  await expect(scoped.proxy(alice.link, 'chat.postMessage', { channel: internal.id, thread_ts: root, text: 'Invalid blocks', blocks: {} })).rejects.toThrow('invalid_blocks');
  await expect(scoped.proxy(alice.link, 'chat.postMessage', { channel: internal.id, thread_ts: root, text: 'Too many blocks', blocks: Array.from({ length: 51 }, () => ({})) })).rejects.toThrow('invalid_blocks');
  let deep: any = {};
  for (let n = 0; n < 21; n++) deep = { child: deep };
  await expect(scoped.proxy(alice.link, 'chat.postMessage', { channel: internal.id, thread_ts: root, text: 'Too deep', blocks: [deep] })).rejects.toThrow('invalid_blocks');
  await expect(scoped.proxy(alice.link, 'chat.postMessage', { channel: internal.id, thread_ts: root, text: 'Too many nodes', blocks: [{ elements: Array.from({ length: 2001 }, () => ({})) }] })).rejects.toThrow('invalid_blocks');
  const otherRoot = '1791050000.000002';
  await service.registry.bind(alice.link, internal.id, otherRoot);
  await expect(scoped.proxy(alice.link, 'chat.postMessage', { channel: internal.id, thread_ts: otherRoot, text: 'Other conversation', blocks: [image] })).rejects.toThrow('object_not_owned');
  await expect(scoped.proxy(alice.link, 'canvases.create', { conversation_channel: internal.id, conversation_ts: root, channel_id: internal.id, title: 'Architecture', document_content: { type: 'markdown', markdown: '![Diagram](https://test.slack.com/files/U999999/F987654/diagram.png)' } })).resolves.toHaveProperty('ok', true);
  await expect(scoped.proxy(alice.link, 'canvases.create', { conversation_channel: internal.id, conversation_ts: otherRoot, channel_id: internal.id, title: 'Architecture', document_content: { type: 'markdown', markdown: '![Diagram](https://test.slack.com/files/U999999/F987654/diagram.png)' } })).rejects.toThrow('object_not_owned');
  await expect(scoped.proxy(alice.link, 'files.completeUploadExternal', { files: [{ id: 'F987654' }] })).rejects.toThrow('method_not_allowed');
  vi.spyOn(service.registry, 'count').mockResolvedValue(500);
  await expect(scoped.proxy(alice.link, 'files.uploadDiagram', args)).rejects.toThrow('diagram_limit');
});

it('deletes only a bot message recorded for the linked owner and strips untrusted arguments', async () => {
  const alice = await link(), bob = await link('bob', 'U234567');
  const scoped = createScopedSlack({ call, registry: service.registry, identity });
  const ts = '1790620000.000001';
  await service.registry.remember(alice.link, `C123456:${ts}`, 'message');
  expect(await scoped.proxy(alice.link, 'chat.delete', { channel: 'C123456', ts, as_user: true, text: 'ignored' })).toHaveProperty('ok', true);
  expect(call).toHaveBeenCalledWith('chat.delete', { channel: 'C123456', ts });
  await expect(scoped.proxy(bob.link, 'chat.delete', { channel: 'C123456', ts })).rejects.toThrow();
  await expect(scoped.proxy(alice.link, 'chat.delete', { channel: 'C123456', ts: '1790620000.000002' })).rejects.toThrow();
  for (const value of [undefined, 'bad', 1790620000, `${ts}:foreign`])
    await expect(scoped.proxy(alice.link, 'chat.delete', { channel: 'C123456', ts: value })).rejects.toThrow('invalid_timestamp');
  await expect(scoped.proxy(alice.link, 'chat.delete', { channel: 'C987654', ts })).rejects.toThrow();
  expect(call.mock.calls.filter(([m]: any[]) => m === 'chat.delete')).toHaveLength(1);
});

it('clears preview metadata only on an owned message update, leaving content untouched', async () => {
  const alice = await link(), bob = await link('bob', 'U234567');
  const scoped = createScopedSlack({ call, registry: service.registry, identity, origin: 'https://example.com' });
  const ts = '1790620000.000001';
  await service.registry.remember(alice.link, `C123456:${ts}`, 'message');
  const clear = { channel: 'C123456', ts, metadata: {}, attachments: [] };
  expect(await scoped.proxy(alice.link, 'chat.update', clear)).toHaveProperty('ok', true);
  const args = call.mock.calls.at(-1)[1];
  expect(args.metadata).toEqual({}); expect(args.text).toBeUndefined(); expect(args.blocks).toBeUndefined();
  expect(args.attachments).toEqual([]);
  await expect(scoped.proxy(bob.link, 'chat.update', clear)).rejects.toThrow();
  await expect(scoped.proxy(alice.link, 'chat.update', { ...clear, ts: '1790620000.000002' })).rejects.toThrow();
  await expect(scoped.proxy(alice.link, 'chat.postMessage', clear)).rejects.toThrow('invalid_attachments');
  await expect(scoped.proxy(alice.link, 'chat.postMessage', { ...clear, attachments: undefined })).rejects.toThrow('invalid_metadata');
  for (const attachments of [null, {}, [{}]]) await expect(scoped.proxy(alice.link, 'chat.update', { ...clear, attachments })).rejects.toThrow('invalid_attachments');
  for (const metadata of [null, [], { unknown: true }, { entities: [] }]) await expect(scoped.proxy(alice.link, 'chat.update', { ...clear, metadata })).rejects.toThrow('invalid_metadata');
  expect(call.mock.calls.filter(([m]: any[]) => m === 'chat.update')).toHaveLength(1);
});

it('routes custom panels through the owned entity and signed connection, without cookies or query credentials', async () => {
  const alice = await link(), bob = await link('bob', 'U234567');
  const id = '00000000-0000-4000-8000-000000000042';
  const base = `https://example.com/api/slack/tasks/${alice.link.id}`;
  const entity: any = { url: `${base}/tasks/${id}`, external_ref: { id, type: 'zana_task' }, entity_type: 'slack#/entities/file', entity_payload: { attributes: { title: { text: 'Test task' }, metadata_last_modified: 1, full_size_preview: { is_supported: true, mime_type: 'application/vnd.slack-embed' } }, fields: {} } };
  const sendCard = (metadata: any, credential = alice.credential) => api('call', { method: 'chat.postMessage', args: { channel: 'C123456', text: 'Task', metadata } }, credential);
  expect((await sendCard({ entities: [entity] })).status).toBe(200);
  expect(call.mock.calls.at(-1)?.[1].metadata.entities[0]).toMatchObject(entity);
  expect((await sendCard({ entities: [entity, entity] })).status).toBe(400);
  expect((await sendCard({ entities: [{ ...entity, url: 'https://evil.example/task' }] })).status).toBe(400);
  const bobEntity = { ...entity, url: `https://example.com/api/slack/tasks/${bob.link.id}/tasks/${id}` };
  expect((await sendCard({ entities: [bobEntity] }, bob.credential)).status).toBe(403);
  const details = { ...event(), event_id: 'EvPanel1', event: { type: 'entity_details_requested', user: 'U123456', external_ref: entity.external_ref, entity_url: entity.url, trigger_id: 'preview-trigger' } };
  expect((await ingress(details)).status).toBe(200); await service.drain();
  expect(JSON.parse(dispatch.mock.calls.at(-1)[0].payload.body).payload.event.type).toBe('entity_details_requested');
  const present = (args: any) => api('call', { method: 'entity.presentDetails', args }, alice.credential);
  entity.entity_payload.attributes.full_size_preview.preview_url = `${base}/view/${id}#key=${'k'.repeat(43)}`;
  expect((await present({ trigger_id: 'preview-trigger', metadata: entity })).status).toBe(200);
  expect((await present({ trigger_id: 'invented', metadata: entity })).status).toBe(403);
  expect((await present({ trigger_id: 'preview-trigger', error: { status: 'restricted' } })).status).toBe(200);
  expect((await ingress({ ...details, event_id: 'EvOther', event: { ...details.event, user: 'U234567' } })).status).toBe(400);
  expect((await sendCard({ entities: [entity] })).status).toBe(400); // A public card cannot carry the private grant.
  const page = (path: string, init: RequestInit = {}) => service.dispatch(new Request(`${base}/${path}`, init));
  dispatch.mockImplementation(async ({ payload }: any) => ({ status: 200, body: { accepted: true, response: { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'" }, body: JSON.parse(payload.body).action === 'page' ? '<h1>Opening task</h1>' : 'Private task' } } }));
  const html = await page(`view/${id}`);
  expect(html.status).toBe(200); expect(html.headers.get('cache-control')).toBe('no-store, private');
  expect(await html.text()).not.toContain('Private task');
  expect(html.headers.get('content-security-policy')).toContain("sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox;");
  expect(html.headers.get('content-security-policy')).toContain(`connect-src ${base}/data/${id};`);
  expect(html.headers.get('content-security-policy')).toContain(", default-src 'none'");
  expect((await page(`data/${id}`)).status).toBe(403);
  expect((await page(`data/${id}?key=${'k'.repeat(43)}`)).status).toBe(404);
  const data = await page(`data/${id}`, { headers: { authorization: `Bearer ${'k'.repeat(43)}`, origin: 'null' } });
  expect(await data.text()).toBe('Private task'); expect(data.headers.get('access-control-allow-origin')).toBe('*'); expect(data.headers.has('access-control-allow-credentials')).toBe(false);
  const forwarded = JSON.parse(dispatch.mock.calls.at(-1)[0].payload.body);
  expect(forwarded).toMatchObject({ kind: 'embed', action: 'data', entityId: id, user: 'U123456', key: 'k'.repeat(43) });
  expect((await page(`data/${id}`, { method: 'OPTIONS' })).status).toBe(204);
  expect((await page(`view/${id}`, { method: 'POST' })).status).toBe(405);
  expect((await page(`tasks/${id}`)).status).toBe(200);
  dispatch.mockResolvedValueOnce({ status: 503 }); expect((await page(`view/${id}`)).status).toBe(503);
  dispatch.mockResolvedValueOnce({ status: 200, body: { accepted: true, response: { status: 200, body: 'x'.repeat(65537) } } }); expect((await page(`view/${id}`)).status).toBe(503);
  dispatch.mockResolvedValueOnce({ status: 200, body: { accepted: true, response: { status: 200, body: 'ok', headers: {} } } }); expect((await page(`view/${id}`)).status).toBe(503);
  await service.registry.revoke(alice.link.id, 'alice');
  expect((await page(`view/${id}`)).status).toBe(403);
});

it("admits slash launches in only the linked owner's verified Zana DM", async () => {
  const a = await link(), original = call.getMockImplementation();
  const payload = {team_id: identity.team, api_app_id: identity.app, user_id: "U123456", command: "/zana", text: "run", channel_id: "D123456", trigger_id: "dm-trigger"};
  call.mockImplementation(async (m: string,args: any) => m === "conversations.info" && args.channel === "D123456" ? {ok: true, channel: {id: "D123456", user: "U123456", is_im: true}} : original(m,args));
  expect((await ingress(payload)).status).toBe(200);
  const scoped = createScopedSlack({call, registry: service.registry, identity, origin: "https://example.com"});
  expect(await scoped.proxy(a.link,"conversations.info",{channel: "D123456"})).toHaveProperty("ok",true);
  call.mockImplementation(async (m: string,args: any) => m === "conversations.info" ? {ok: true, channel: {id: args.channel, user: "U234567", is_im: true}} : original(m,args));
  expect((await ingress({...payload,trigger_id:"foreign"})).status).toBe(403);
  call.mockImplementation(async (m: string,args: any) => m === "conversations.info" ? {ok: true, channel: {id: args.channel, user: "U123456", is_im: true,is_mpim:true}} : original(m,args));
  expect((await ingress({...payload,trigger_id:"group"})).status).toBe(403);
});
it("forwards signed model suggestions only from a link-owned modal and returns its options", async () => {
  const a = await link(); await service.registry.remember(a.link,"VMODELS","view");
  const payload = {type:"block_suggestion",team:{id:identity.team},api_app_id:identity.app,user:{id:"U123456"},view:{id:"VMODELS"},action_id:"launch_model",block_id:"model_p1_codex",value:"gpt"};
  dispatch.mockResolvedValue({status:200,body:{accepted:true,response:{options:[{text:{type:"plain_text",text:"GPT"},value:"gpt"}]}}});
  expect(await (await ingress(payload)).json()).toEqual({options:[{text:{type:"plain_text",text:"GPT"},value:"gpt"}]});
  expect((await ingress({...payload,view:{id:"VFOREIGN"}})).status).toBe(403);
});


it("admits a fresh owner mention in an ordinary existing thread without taking over another owner's conversation", async () => {
  const alice=await link(), bob=await link("bob","U234567");
  dispatch.mockClear();
  const root="1790000000.123456";
  const mention=event("U123456","EvOrdinaryThread",root);
  expect((await ingress(mention)).status).toBe(200);
  await service.drain();
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch.mock.calls[0][0].serverId).toBe(alice.serverId);
  await expect(service.registry.conversation(alice.link,"C123456",root)).resolves.toBeUndefined();
  await ingress(mention); await service.drain();
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect((await ingress(event("U234567","EvForeignThread",root))).status).toBe(403);
  await expect(service.registry.conversation(bob.link,"C123456",root)).rejects.toThrow("conversation_not_owned");
  expect(dispatch).toHaveBeenCalledTimes(1);
  for(const invalid of ["invalid",null,123,"", "1790000000.123456extra"]) {
    const bad=event("U123456",`EvInvalid${String(invalid)}`); (bad.event as any).thread_ts=invalid;
    expect((await ingress(bad)).status).toBe(200);
  }
  await service.drain();
  expect(dispatch).toHaveBeenCalledTimes(1);
});
