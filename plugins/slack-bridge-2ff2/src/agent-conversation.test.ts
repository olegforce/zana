import { afterEach, expect, it, vi } from "vitest";
import { setup, identity, route, stamp } from "../test/helpers.js";
import { conversationKey } from "./model.js";
let s: ReturnType<typeof setup>;
const dm = { id: "D123456", user: "U123456", is_im: true, is_archived: false };
const root = stamp();
const key = () => conversationKey({ ...identity, channel: dm.id, root });
const event = (text: string, id = text, type = "message", extra = {}) => ({
  type: "event_callback",
  event_id: id,
  team_id: identity.team,
  api_app_id: identity.app,
  event: {
    type,
    user: dm.user,
    channel: dm.id,
    ts: stamp(),
    thread_ts: root,
    text,
    ...extra,
  },
});
afterEach(async () => {
  if (s) await s.close();
  s = undefined as any;
});
async function start() {
  s = setup();
  const call = s.call.getMockImplementation()!;
  s.call.mockImplementation(async (m, a) =>
    m === "conversations.info" && a.channel === dm.id
      ? { ok: true, channel: dm }
      : call(m, a),
  );
  s.bridge.config.agentChatEnabled = true;
  s.bridge.config.inboxEnabled = true;
  await s.connect();
  return (s.zcc as any).sdk;
}
async function pump() {
  await s.bridge.chat.tick();
  await s.bridge.chat.tick();
  await s.bridge.chat.drain();
  await s.bridge.tick();
}
const complete = (sdk: any, ...decisions: unknown[]) => {
  for (const d of decisions)
    sdk.assistant.complete.mockResolvedValueOnce({ text: JSON.stringify(d) });
};
it("infers a connected Project without a picker and deduplicates Slack retries", async () => {
  const sdk = await start();
  complete(sdk, { kind: "launch", projectId: route.projectId });
  await s.receive(event("Review Project", "one"));
  await s.receive(event("Review Project", "one"));
  await pump();
  expect(s.spawn).toHaveBeenCalledTimes(1);
  expect(s.spawn).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: route.projectId,
      model: route.model,
      prompt: "Review Project",
    }),
  );
  expect(
    JSON.stringify(s.call.mock.calls.filter(([m]) => m === "chat.postMessage")),
  ).not.toContain("static_select");
  const b = s.store.get("binding", key())!;
  s.threads.get(b.threadId).status = "idle";
  await s.bridge.event({ name: "thread.idle", threadId: b.threadId });
  complete(sdk, { kind: "launch", projectId: route.projectId });
  await s.receive(event("Continue", "follow"));
  await pump();
  expect(s.spawn).toHaveBeenCalledTimes(1);
  expect(s.send).toHaveBeenCalledTimes(1);
});
it("asks for ambiguity then dispatches the original request with the user clarification", async () => {
  const sdk = await start();
  complete(sdk, {
    kind: "clarify",
    text: "Which Project should I review?",
    intent: "task",
  });
  await s.receive(event("Review changes", "first"));
  await pump();
  expect(s.spawn).not.toHaveBeenCalled();
  expect(s.store.get("agentChat", key())?.pending?.text).toBe("Review changes");
  complete(sdk, { kind: "launch", projectId: route.projectId });
  await s.receive(event("Project", "answer"));
  await pump();
  expect(s.spawn).toHaveBeenCalledWith(
    expect.objectContaining({
      prompt: "Review changes\n\nUser clarification: Project",
    }),
  );
});
it("searches unread reports across registered Projects and reads/summarizes without launching", async () => {
  const sdk = await start();
  sdk.projects.list.mockResolvedValue([
    { id: "p1", name: "Project" },
    { id: "p2", name: "Other" },
  ]);
  sdk.inbox.search = vi.fn(async () => ({
    entries: [
      {
        id: "r1",
        projectId: "p2",
        projectName: "Other",
        subject: "Review report",
        ts: Date.now(),
        comments: "Findings",
        documents: 1,
        unread: true,
      },
    ],
    hasMore: false,
  }));
  sdk.inbox.read = vi.fn(async () => ({
    id: "r1",
    projectId: "p2",
    projectName: "Other",
    subject: "Review report",
    content: "Concrete findings",
    truncated: false,
  }));
  complete(
    sdk,
    { kind: "inbox_search", unreadOnly: true },
    { kind: "inbox_read", entryId: "r1" },
    { kind: "answer", text: "Review report (Other): Concrete findings." },
  );
  await s.receive(event("Summarize my unread reports", "reports"));
  await pump();
  expect(sdk.inbox.search).toHaveBeenCalledWith(
    expect.objectContaining({
      projectIds: ["p1", "p2"],
      unreadOnly: true,
      reportsOnly: true,
      limit: 10,
    }),
  );
  expect(sdk.inbox.read).toHaveBeenCalledWith(
    expect.objectContaining({ entryId: "r1", projectIds: ["p1", "p2"] }),
  );
  expect(s.spawn).not.toHaveBeenCalled();
  expect(s.store.get("chatTurn", "reports")?.state).toBe("sent");
  expect(s.call).toHaveBeenCalledWith(
    "chat.postMessage",
    expect.objectContaining({
      channel: dm.id,
      text: "Review report (Other): Concrete findings.",
    }),
  );
  s.bridge.config.inboxEnabled = false;
  complete(sdk, { kind: "answer", text: "Report access is disabled." });
  await s.receive(event("What did that say?", "revoked"));
  await pump();
  const context = JSON.parse(
    sdk.assistant.complete.mock.calls.at(-1)[0].prompt,
  );
  expect(context.selectedReport).toBeUndefined();
  expect(JSON.stringify(context)).not.toContain("Concrete findings");
});
it("denies inbox reads without a grant, rejects invented report IDs and unconnected Projects", async () => {
  const sdk = await start();
  sdk.inbox.search = vi.fn();
  sdk.inbox.read = vi.fn();
  s.bridge.config.inboxEnabled = false;
  complete(sdk, { kind: "inbox_search" });
  await s.receive(event("Reports", "disabled"));
  await pump();
  expect(sdk.inbox.search).not.toHaveBeenCalled();
  s.bridge.config.inboxEnabled = true;
  complete(sdk, { kind: "inbox_read", entryId: "invented" });
  await s.receive(event("Read this", "invented"));
  await pump();
  expect(sdk.inbox.read).not.toHaveBeenCalled();
  complete(sdk, { kind: "launch", projectId: "not-connected" });
  await s.receive(event("Work there", "invalid"));
  await pump();
  expect(s.spawn).not.toHaveBeenCalled();
});
it("native Stop cancels inference before launch", async () => {
  const sdk = await start();
  let entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  sdk.assistant.complete.mockImplementationOnce(
    ({ signal }: any) =>
      new Promise((_r, reject) => {
        entered();
        signal.addEventListener("abort", () => reject(new Error("abort")), {
          once: true,
        });
      }),
  );
  await s.receive(event("Slow task", "slow"));
  await s.bridge.chat.tick();
  await s.bridge.chat.tick();
  await started;
  await s.receive(event("", "stop", "agent_session_stopped"));
  await s.bridge.chat.drain();
  expect(s.spawn).not.toHaveBeenCalled();
  expect(s.store.get("chatTurn", "slow")?.note).toBe("Stopped");
});
it("owner and report-grant revocation during inference prevent reads and publication", async () => {
  const sdk = await start();
  sdk.inbox.search = vi.fn();
  sdk.assistant.complete.mockImplementationOnce(async () => {
    s.bridge.config.inboxEnabled = false;
    return { text: '{"kind":"inbox_search"}' };
  });
  await s.receive(event("Reports", "grant"));
  await pump();
  expect(sdk.inbox.search).not.toHaveBeenCalled();
  sdk.assistant.complete.mockImplementationOnce(async () => {
    s.bridge.config.ownerEpoch = "changed";
    return { text: '{"kind":"launch","projectId":"p1"}' };
  });
  await s.receive(event("Review", "owner"));
  await pump();
  expect(s.spawn).not.toHaveBeenCalled();
  expect(s.store.get("chatTurn", "owner")?.state).toBe("failed");
});
it("marks ambiguous delivery uncertain and never retries it", async () => {
  const sdk = await start();
  complete(sdk, { kind: "answer", text: "Hello" });
  await s.receive(event("Hello", "uncertain"));
  await s.bridge.chat.tick();
  const original = s.call.getMockImplementation()!;
  s.call.mockImplementation(async (m, a) =>
    m === "chat.postMessage" ? {} : original(m, a),
  );
  await s.bridge.chat.tick();
  await s.bridge.chat.drain();
  expect(s.store.get("chatTurn", "uncertain")?.state).toBe("uncertain");
  await s.receive(event("Hello", "uncertain"));
  await pump();
  expect(sdk.assistant.complete).toHaveBeenCalledTimes(1);
});
it("bounds four inference steps and preserves an inbox fallback when the model keeps searching", async () => {
  const sdk = await start();
  sdk.inbox.search = vi.fn(async () => ({ entries: [], hasMore: false }));
  for (let i = 0; i < 4; i++) complete(sdk, { kind: "inbox_search" });
  await s.receive(event("Reports", "budget"));
  await pump();
  expect(sdk.assistant.complete).toHaveBeenCalledTimes(4);
  expect(s.store.get("chatTurn", "budget")?.text).toBe(
    "No reports matched in this page.",
  );
});

it("rechecks connected routes after inference before accepting a launch", async () => {
  const sdk = await start();
  sdk.assistant.complete.mockImplementationOnce(async () => {
    s.bridge.config.routes = [];
    return { text: '{"kind":"launch","projectId":"p1"}' };
  });
  await s.receive(event("Review Project", "route-revoked"));
  await pump();
  expect(s.spawn).not.toHaveBeenCalled();
  expect(s.store.list("receipt")).toHaveLength(0);
});

it("retains bounded delivery history without permanently blocking new requests", async () => {
  const sdk = await start();
  for (let i = 0; i < 1000; i++)
    s.store.put("chatTurn", "old" + i, {
      id: "old" + i,
      key: "old",
      message: {} as any,
      state: "sent",
      next: 0,
    });
  complete(sdk, { kind: "answer", text: "Hello" });
  await s.receive(event("Hello", "capacity"));
  await pump();
  expect(s.store.count("chatTurn")).toBeLessThanOrEqual(900);
  expect(s.store.get("chatTurn", "capacity")?.state).toBe("sent");
});

it("keeps the report list useful when an attached document is unavailable", async () => {
  const sdk = await start();
  sdk.inbox.search = vi.fn(async () => ({
    entries: [
      {
        id: "r",
        projectId: "p1",
        projectName: "Project",
        subject: "Saved report",
        ts: Date.now(),
        comments: "",
        documents: 1,
        unread: true,
      },
    ],
    hasMore: false,
  }));
  sdk.inbox.read = vi.fn(async () => {
    throw new Error("unavailable document");
  });
  complete(sdk, { kind: "inbox_search" }, { kind: "inbox_read", entryId: "r" });
  await s.receive(event("Read reports", "missing-document"));
  await pump();
  expect(s.store.get("chatTurn", "missing-document")?.text).toContain(
    "Saved report",
  );
  expect(s.store.get("chatTurn", "missing-document")?.text).toContain(
    "report read",
  );
  expect(s.spawn).not.toHaveBeenCalled();
});

it("preserves explicit routing on older installed cores until the core is upgraded", async () => {
  const sdk = await start();
  sdk.assistant = undefined;
  expect(await s.bridge.snapshot()).toMatchObject({
    conversationalChatReady: false,
    reportInboxReady: false,
  });
  await s.receive(
    event("Task", "older", "message", {
      app_context: { team_id: identity.team, channel_id: route.channel },
    }),
  );
  await s.bridge.tick();
  expect(s.store.get("receipt", "older")).toBeDefined();
  expect(s.store.count("chatTurn")).toBe(0);
});
it("keeps the compatible Project override available for older cores", async () => {
  const sdk = await start();
  sdk.assistant = undefined;
  expect(await s.bridge.snapshot()).toMatchObject({
    conversationalChatReady: false,
    reportInboxReady: false,
  });
  await s.receive(event("Task", "older-unbound"));
  await s.bridge.chat.tick();
  expect(
    JSON.stringify(s.call.mock.calls.filter(([m]) => m === "chat.postMessage")),
  ).toContain("static_select");
  expect(s.store.get("agentChat", key())?.pending?.text).toBe("Task");
});

it("includes a large registered Project catalogue in personal report searches", async () => {
  const sdk = await start();
  sdk.projects.list.mockResolvedValue(
    Array.from({ length: 171 }, (_, i) => ({
      id: "p" + i,
      name: "Project " + i,
    })),
  );
  sdk.inbox.search = vi.fn(async () => ({ entries: [], hasMore: false }));
  complete(
    sdk,
    { kind: "inbox_search" },
    { kind: "answer", text: "No reports" },
  );
  await s.receive(event("My reports", "large-catalogue"));
  await pump();
  expect(sdk.inbox.search.mock.calls[0][0].projectIds).toHaveLength(171);
});
