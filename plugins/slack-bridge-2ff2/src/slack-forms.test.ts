import { afterEach, expect, it, vi } from "vitest";
import { canvasMarkdown, parseQuestions } from "./slack-forms.js";
import { sampleResult } from "./embed-view.js";
import { homeView } from "./home-view.js";
import { setup, identity, route, body, stamp } from "../test/helpers.js";
let s: ReturnType<typeof setup>;
afterEach(async () => {
  if (s) {
    await s.close();
    s = undefined as any;
  }
  vi.restoreAllMocks();
});
async function task() {
  s = setup();
  s.bridge.config.canvasEnabled = true;
  s.bridge.config.questionsEnabled = true;
  s.bridge.config.richResultsEnabled = true;
  s.bridge.config.routes = [{ ...route, summaries: true }];
  await s.connect();
  await s.receive(body("Review the project"));
  await s.bridge.tick();
  await new Promise((r) => setImmediate(r));
  return s.store.list("binding")[0];
}
function action(d: any, action_id: string) {
  return {
    type: "block_actions",
    team: { id: identity.team },
    api_app_id: identity.app,
    user: { id: "U123456" },
    container: { channel_id: d.channel, message_ts: d.ts },
    message: { thread_ts: d.root },
    trigger_id: "trigger",
    actions: [{ action_id, value: d.id, action_ts: stamp() }],
  };
}
const submit = (id: string, canvas = true, values = {}) => ({
  type: "view_submission",
  team: { id: identity.team },
  api_app_id: identity.app,
  user: { id: "U123456" },
  view: {
    id: "V654321",
    callback_id: canvas ? "zana_canvas_v1" : "zana_question_v1",
    private_metadata: id,
    state: { values },
  },
});
async function answer(b: any, result?: any) {
  await s.bridge.publish(
    b.threadId,
    b.projectId,
    "Review complete",
    false,
    result,
  );
  const d = s.store.get("delivery", `answer:${b.active}`)!;
  s.store.put("delivery", d.id, { ...d, state: "sent", ts: stamp() });
  return s.store.get("delivery", d.id)!;
}
async function exportDraft() {
  const b = await task(),
    d = await answer(b, sampleResult());
  await s.receive(action(d, "canvas_open") as any);
  return { b, d, r: s.store.list("canvas")[0] };
}
it("opens a bounded native question form and sends one durable follow-up with free-text precedence", async () => {
  const b = await task();
  const input = [
    { text: "How much detail?", options: ["Brief", "Detailed"] },
    { text: "Audience?", options: ["Team", "Everyone"] },
  ];
  const q = s.bridge.forms.ask(b.threadId, b.projectId, input);
  expect(s.bridge.forms.ask(b.threadId, b.projectId, input)).toMatchObject({
    id: q.id,
    state: "waiting",
  });
  const d = s.store.get("delivery", q.id)!;
  s.store.put("delivery", d.id, { ...d, state: "sent", ts: stamp() });
  expect(s.bridge.forms.deliveryBlocks(d)?.length).toBe(3);
  await s.receive(
    action(s.store.get("delivery", q.id), "question_open") as any,
  );
  expect(s.call).toHaveBeenCalledWith(
    "views.open",
    expect.objectContaining({
      view: expect.objectContaining({ callback_id: "zana_question_v1" }),
    }),
  );
  const p = submit(q.id, false, {
    q0: { choice: { selected_option: { value: "0" } } },
    free0: { text: { value: "Explain the tradeoffs" } },
    q1: { choice: { selected_option: { value: "1" } } },
  });
  const ack = await s.receive(p as any);
  expect(ack).toHaveBeenCalledWith({ response_action: "clear" });
  expect(s.store.get("question", q.id)?.answers).toEqual([
    "Explain the tradeoffs",
    "Everyone",
  ]);
  await s.receive(p as any);
  expect(
    s.store.list("receipt").filter((r) => r.id.startsWith("form:")),
  ).toHaveLength(1);
  s.threads.get(b.threadId).status = "idle";
  await s.bridge.event({ name: "thread.idle", threadId: b.threadId });
  await s.bridge.tick();
  expect(s.send).toHaveBeenCalledWith(
    expect.objectContaining({
      threadId: b.threadId,
      prompt: expect.stringContaining("Explain the tradeoffs"),
    }),
  );
});
it.each(["waiting", "cancelled"] as const)(
  "shows the correct ended-turn notice for a %s ordinary question",
  async (state) => {
    const b = await task();
    const q = s.bridge.forms.ask(b.threadId, b.projectId, [
      { text: "How much detail?", options: ["Brief", "Detailed"] },
    ]);
    s.store.put("question", q.id, { ...s.store.get("question", q.id)!, state });
    s.threads.get(b.threadId).status = "idle";
    await s.bridge.event({ name: "thread.idle", threadId: b.threadId });
    const note = s.store.get("receipt", b.active!)?.note;
    if (state === "waiting") {
      expect(note).toContain("Answer the questions here");
      expect(note).not.toContain("No answer shared");
    } else expect(note).toContain("No answer shared");
  },
);
it.each(
  [
    [],
    [{ text: "a", options: ["one"] }],
    [{ text: "a", options: ["same", "same"] }],
    [{ text: "", options: ["a", "b"] }],
    [{ text: "a", options: ["a", 1] }],
    [{ text: "a", options: ["a", "b"], permission: true }],
  ].map((input) => ({ input })),
)("rejects malformed ordinary questions $input", ({ input }) => {
  expect(() => parseQuestions(input)).toThrow();
});
it("requires explicit question consent, a current active binding and answer sharing", async () => {
  const b = await task();
  s.bridge.config.questionsEnabled = false;
  expect(() =>
    s.bridge.forms.ask(b.threadId, b.projectId, [
      { text: "a", options: ["a", "b"] },
    ]),
  ).toThrow();
  s.bridge.config.questionsEnabled = true;
  s.bridge.config.slackAccess = { answers: false };
  expect(() => s.bridge.forms.ask(b.threadId, b.projectId, [])).toThrow();
  s.bridge.config.slackAccess = {};
  s.store.put("binding", b.key, { ...b, active: undefined });
  expect(() => s.bridge.forms.ask(b.threadId, b.projectId, [])).toThrow();
});
it("escapes native input labels and choice text without changing the stored answers", async () => {
  const b = await task();
  const q = s.bridge.forms.ask(b.threadId, b.projectId, [
    { text: "Is 2 < 3 && 4 > 1?", options: ["<Yes & correct>", "No"] },
  ]);
  const d = s.store.get("delivery", q.id)!;
  s.store.put("delivery", d.id, { ...d, state: "sent", ts: stamp() });
  await s.receive(
    action(s.store.get("delivery", q.id), "question_open") as any,
  );
  const view = s.call.mock.calls.find(([method]) => method === "views.open")![1]
    .view;
  expect(view.blocks[1].label.text).toBe("Is 2 &lt; 3 &amp;&amp; 4 &gt; 1?");
  expect(view.blocks[1].element.options[0].text.text).toBe(
    "&lt;Yes &amp; correct&gt;",
  );
  expect(s.store.get("question", q.id)!.questions[0].options[0]).toBe(
    "<Yes & correct>",
  );
});
it("rejects questions when their follow-up path is disabled and cancels waiting forms after revocation", async () => {
  const b = await task();
  const input = [{ text: "Detail?", options: ["Brief", "Full"] }];
  s.bridge.config.slackAccess = { followups: false };
  expect(() => s.bridge.forms.ask(b.threadId, b.projectId, input)).toThrow();
  expect(s.store.list("question")).toHaveLength(0);
  s.bridge.config.slackAccess = {};
  const q = s.bridge.forms.ask(b.threadId, b.projectId, input);
  s.bridge.config.slackAccess = { followups: false };
  await s.bridge.forms.tick();
  expect(s.store.get("question", q.id)?.state).toBe("cancelled");
});
it("keeps answers retryable when the durable request queue is full", async () => {
  const b = await task();
  const q = s.bridge.forms.ask(b.threadId, b.projectId, [
    { text: "Detail?", options: ["Brief", "Full"] },
  ]);
  const d = s.store.get("delivery", q.id)!;
  s.store.put("delivery", d.id, { ...d, state: "sent", ts: stamp() });
  await s.receive(
    action(s.store.get("delivery", q.id), "question_open") as any,
  );
  const request = s.store.list("receipt")[0];
  for (let i = 0; i < 100; i++)
    s.store.put("receipt", `busy-${i}`, {
      ...request,
      id: `busy-${i}`,
      state: "queued",
    });
  const p = submit(q.id, false, {
    q0: { choice: { selected_option: { value: "0" } } },
  });
  expect(await s.receive(p as any)).toHaveBeenCalledWith(
    expect.objectContaining({ response_action: "errors" }),
  );
  expect(s.store.get("question", q.id)?.state).toBe("waiting");
  expect(
    s.store.list("receipt").filter((r) => r.id.startsWith("form:")),
  ).toHaveLength(0);
  for (let i = 0; i < 100; i++)
    s.store.put("receipt", `busy-${i}`, {
      ...request,
      id: `busy-${i}`,
      state: "settled",
    });
  expect(await s.receive(p as any)).toHaveBeenCalledWith({
    response_action: "clear",
  });
  expect(s.store.get("question", q.id)?.state).toBe("answered");
  expect(
    s.store.list("receipt").filter((r) => r.id.startsWith("form:")),
  ).toHaveLength(1);
});
it("keeps a form open for missing answers and cancels stale or revoked questions", async () => {
  const b = await task(),
    q = s.bridge.forms.ask(b.threadId, b.projectId, [
      { text: "Detail?", options: ["Brief", "Full"] },
    ]);
  const d = s.store.get("delivery", q.id)!;
  s.store.put("delivery", d.id, { ...d, state: "sent", ts: stamp() });
  await s.receive(
    action(s.store.get("delivery", q.id), "question_open") as any,
  );
  expect(await s.receive(submit(q.id, false) as any)).toHaveBeenCalledWith(
    expect.objectContaining({ response_action: "errors" }),
  );
  s.bridge.config.questionsEnabled = false;
  await s.bridge.forms.tick();
  expect(s.store.get("question", q.id)?.state).toBe("cancelled");
  expect(await s.receive(submit(q.id, false) as any)).toHaveBeenCalledWith({
    response_action: "clear",
  });
});
it("exports an immutable confirmed report only after native audience confirmation", async () => {
  const { b, d, r } = await exportDraft();
  const view = s.call.mock.calls.find(([m]) => m === "views.open")![1].view;
  expect(JSON.stringify(view)).toContain("members of #agent-work");
  expect(s.call).not.toHaveBeenCalledWith("canvases.create", expect.anything());
  const original = s.call.getMockImplementation()!;
  s.call.mockImplementation(async (m, a) =>
    m === "canvases.create"
      ? { ok: true, canvas_id: "F123456" }
      : original(m, a),
  );
  await s.receive(submit(r.id) as any);
  await s.receive(submit(r.id) as any);
  await s.bridge.forms.tick();
  expect(
    s.call.mock.calls.filter(([m]) => m === "canvases.create"),
  ).toHaveLength(1);
  expect(s.call).toHaveBeenCalledWith(
    "canvases.create",
    expect.objectContaining({
      channel_id: b.channel,
      conversation_ts: b.root,
      document_content: {
        type: "markdown",
        markdown: expect.stringContaining("Release review"),
      },
    }),
  );
  await s.bridge.forms.tick();
  const announcement = s.store
    .list("delivery")
    .find((d) => d.canvasId === r.id)!;
  expect(announcement.text).toContain(
    "https://app.slack.com/docs/T123456/F123456",
  );
  s.store.put("delivery", announcement.id, {
    ...announcement,
    state: "sent",
    ts: stamp(),
  });
  await s.bridge.forms.tick();
  expect(s.store.get("canvas", r.id)?.state).toBe("published");
  const links = s.store.canvasLinks(b.key);
  expect(links[0]).toMatchObject({
    key: b.key,
    route: { summaries: true },
    url: expect.stringContaining("F123456"),
  });
  expect(links[0]).not.toHaveProperty("markdown");
  expect(s.store.canvasLinks("other")).toEqual([]);
  expect(s.store.canvasLinks()).toHaveLength(1);
  expect(s.bridge.forms.deliveryBlocks(announcement)).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "actions" })]),
  );
  expect(s.bridge.forms.resultActions(announcement)).toEqual([]);
  const home = homeView({
    config: s.bridge.config,
    bindings: [b],
    deliveries: [d],
    launches: [],
    projects: [{ id: b.projectId, name: "Project" }],
    project: "",
    token: "home",
    canvases: s.store.list("canvas"),
  });
  expect(JSON.stringify(home)).toContain("Open Canvas");
  expect(JSON.stringify(home)).toContain("Open result");
  expect(s.store.sharedAnswer(b.key, true)?.id).toBe(d.id);
  await s.receive(action(d, "canvas_open") as any);
  expect(s.store.list("canvas")).toHaveLength(1);
  expect(JSON.stringify(s.call.mock.calls.at(-1))).toContain("Canvas snapshot");
});
it.each([
  "wrong-user",
  "forged-message",
  "expired",
  "wrong-view",
  "disabled",
  "edited-result",
  "rich-revoked",
  "model-changed",
])("rejects Canvas submissions after %s", async (mode) => {
  const { d, r } = await exportDraft();
  const p = submit(r.id);
  if (mode === "wrong-user") p.user.id = "U234567";
  if (mode === "wrong-view") p.view.id = "Vforged";
  if (mode === "expired") s.store.put("canvas", r.id, { ...r, expires: 0 });
  if (mode === "disabled") s.bridge.config.canvasEnabled = false;
  if (mode === "rich-revoked") s.bridge.config.richResultsEnabled = false;
  if (mode === "model-changed") s.bridge.config.routes[0].model = "different";
  if (mode === "edited-result")
    s.store.put("delivery", d.id, { ...d, revision: 99 });
  if (mode === "forged-message") {
    const forged = action(d, "canvas_open");
    forged.container.message_ts = "bad";
    const before = s.call.mock.calls.length;
    await s.receive(forged as any);
    expect(s.call.mock.calls.length).toBe(before);
    s.bridge.config.canvasEnabled = false;
  }
  await s.receive(p as any);
  await s.bridge.forms.tick();
  expect(
    s.call.mock.calls.filter(([m]) => m === "canvases.create"),
  ).toHaveLength(0);
});
it.each(["reject", "timeout", "malformed"])(
  "never retries ambiguous Canvas creation (%s)",
  async (mode) => {
    const { r, d, b } = await exportDraft();
    const original = s.call.getMockImplementation()!;
    s.call.mockImplementation(async (m, a) => {
      if (m === "canvases.create") {
        if (mode === "timeout") throw new Error("timeout");
        return mode === "reject"
          ? { ok: false, error: "missing_scope" }
          : { ok: true, canvas_id: "bad" };
      }
      return original(m, a);
    });
    await s.receive(submit(r.id) as any);
    await s.bridge.forms.tick();
    await s.bridge.forms.tick();
    expect(
      s.call.mock.calls.filter(([m]) => m === "canvases.create"),
    ).toHaveLength(1);
    expect(s.store.get("canvas", r.id)?.state).toBe(
      mode === "reject" ? "failed" : "uncertain",
    );
    const notices = s.store
      .list("delivery")
      .filter((x) => x.id.startsWith("canvas-notice:"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      key: b.key,
      channel: b.channel,
      root: b.root,
      canvasId: r.id,
    });
    expect(notices[0].text).toContain(
      mode === "reject" ? "could not be completed" : "not confirmed",
    );
    s.store.put("delivery", notices[0].id, {
      ...notices[0],
      state: "sent",
      ts: stamp(),
    });
    expect(s.store.sharedAnswer(b.key, true)?.id).toBe(d.id);
  },
);
it("gates queued exports again after authorization, and surfaces announcement uncertainty", async () => {
  const { r } = await exportDraft();
  await s.receive(submit(r.id) as any);
  const original = s.call.getMockImplementation()!;
  s.call.mockImplementation(async (m, a) => {
    if (m === "conversations.info") s.bridge.config.canvasEnabled = false;
    return original(m, a);
  });
  await s.bridge.forms.tick();
  expect(s.store.get("canvas", r.id)?.state).toBe("failed");
  s.bridge.config.canvasEnabled = true;
  s.call.mockImplementation(original);
  s.store.put("canvas", r.id, {
    ...r,
    state: "created",
    canvasId: "F123456",
    url: "https://app.slack.com/docs/T123456/F123456",
  });
  await s.bridge.forms.tick();
  const d = s.store.list("delivery").find((d) => d.canvasId)!;
  s.store.put("delivery", d.id, { ...d, state: "uncertain" });
  await s.bridge.forms.tick();
  expect(s.store.get("canvas", r.id)?.state).toBe("uncertain");
});
it.each(["success", "reject", "timeout"])(
  "private Canvas grants owner read access only after direct link delivery (%s)",
  async (mode) => {
    const b = await task();
    // Exercise the private export pipeline with the same frozen Project authorization.
    const routeSpy = vi.spyOn(s.bridge, "routeFor").mockReturnValue({
      ...route,
      summaries: true,
      channel: "D123456",
      sourceChannel: route.channel,
    });
    const privateBinding = {
      ...b,
      channel: "D123456",
      sourceChannel: route.channel,
    };
    s.store.put("binding", b.key, privateBinding);
    const authorize = vi
      .spyOn(s.bridge as any, "authorize")
      .mockResolvedValue(true);
    const d = await answer(privateBinding);
    const original = s.call.getMockImplementation()!;
    s.call.mockImplementation(async (m, a) => {
      if (m === "canvases.create") return { ok: true, canvas_id: "F123456" };
      if (m === "canvases.access.set") {
        if (mode === "timeout") throw new Error("timeout");
        return { ok: mode === "success", error: "missing_scope" };
      }
      return original(m, a);
    });
    await s.receive(action(d, "canvas_open") as any);
    const r = s.store.list("canvas")[0];
    expect(
      JSON.stringify(s.call.mock.calls.find(([m]) => m === "views.open")![1]),
    ).toContain("linked Slack owner");
    await s.receive(submit(r.id) as any);
    await s.bridge.forms.tick();
    expect(
      s.call.mock.calls.find(([m]) => m === "canvases.create")![1].channel_id,
    ).toBeUndefined();
    await s.bridge.forms.tick();
    await s.bridge.forms.tick();
    expect(
      s.call.mock.calls.filter(([m]) => m === "canvases.access.set"),
    ).toHaveLength(0);
    const announcement = s.store.list("delivery").find((d) => d.canvasId)!;
    s.store.put("delivery", announcement.id, {
      ...announcement,
      state: "sent",
      ts: stamp(),
    });
    await s.bridge.forms.tick();
    expect(s.call).toHaveBeenCalledWith("canvases.access.set", {
      canvas_id: "F123456",
      access_level: "read",
      user_ids: ["U123456"],
    });
    expect(s.store.get("canvas", r.id)?.state).toBe(
      mode === "success"
        ? "published"
        : mode === "reject"
          ? "failed"
          : "sharing",
    );
    routeSpy.mockRestore();
    authorize.mockRestore();
  },
);
it("serializes rich sections as inert bounded Markdown and refuses large exports", () => {
  expect(() =>
    parseQuestions([{ text: "Choose", options: ["a", " a "] }]),
  ).toThrow();
  const report = sampleResult();
  report.sections.push({
    type: "code",
    title: "Fences",
    text: "```\n<@U123456>\n```",
  });
  const markdown = canvasMarkdown("<@U123456> *literal*", report);
  expect(markdown).toContain("&lt;@U123456&gt;");
  expect(markdown).toContain("````");
  expect(markdown).toContain("[x]");
  expect(markdown).toContain("Milliseconds");
  expect(() => canvasMarkdown("x".repeat(24001))).toThrow("too large");
  expect(() => canvasMarkdown("é".repeat(13000))).toThrow("too large");
  expect(() => canvasMarkdown("🧪".repeat(6500))).toThrow("too large");
});
it("preserves code and diff excerpts verbatim inside safe Canvas fences", () => {
  const code = 'if (count < 3 && count > 0) console.log("<@U123456>");\n```';
  const diff = '- return "a & b";\n+ return "<tag>";';
  const markdown = canvasMarkdown("<@U123456>", {
    title: "Example",
    sections: [
      { type: "code", title: "Code", text: code },
      { type: "diff", title: "Diff", text: diff },
    ],
  });
  expect(markdown).toContain(`\n\`\`\`\`\n${code}\n\`\`\`\`\n`);
  expect(markdown).toContain(`\n\`\`\`\n${diff}\n\`\`\`\n`);
  expect(markdown.startsWith("&lt;@U123456&gt;")).toBe(true);
});
it("recovers interrupted exports and welcomes without replaying writes", async () => {
  const { r } = await exportDraft();
  s.store.put("canvas", r.id, { ...r, state: "creating" });
  s.store.recover();
  expect(s.store.get("canvas", r.id)?.state).toBe("uncertain");
  const old = { ...r, id: "old", state: "published" as const };
  s.store.put("canvas", old.id, old);
  s.db.prepare("UPDATE bridge_records SET updated=0 WHERE id='old'").run();
  s.store.prune();
  expect(s.store.get("canvas", "old")).toBeUndefined();
});
it("retains the confirmed answer when a later question is posted and shows ordinary questions in Home", async () => {
  const b = await task(),
    d = await answer(b);
  const q = s.bridge.forms.ask(b.threadId, b.projectId, [
    { text: "More detail?", options: ["Yes", "No"] },
  ]);
  const question = s.store.get("delivery", q.id)!;
  s.store.put("delivery", q.id, { ...question, state: "sent", ts: stamp() });
  expect(s.store.sharedAnswer(b.key, true)?.id).toBe(d.id);
  const home = homeView({
    config: s.bridge.config,
    bindings: [b],
    deliveries: [d],
    launches: [],
    projects: [],
    project: "",
    token: "home",
    questions: s.store.list("question"),
  });
  expect(JSON.stringify(home)).toContain(
    "Question waiting in this Slack conversation",
  );
});
