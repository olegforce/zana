import { afterEach, expect, it, vi } from "vitest";
import { setup, body, internal } from "../test/helpers.js";
import type { Delivery } from "./model.js";

const fixtures: ReturnType<typeof setup>[] = [];
async function fixture() {
  const f = setup();
  fixtures.push(f);
  await f.connect();
  await f.receive(body("review this", "EvInline"));
  await f.bridge.tick();
  const d = f.store.get("delivery", "status:EvInline")!;
  f.store.put("delivery", d.id, { ...d, next: 0 });
  await f.bridge.flush();
  f.call.mockClear();
  return { ...f, d: f.store.get("delivery", d.id)! };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) await f.close();
});

it("shares rich content inline without a task attachment when previews are off", async () => {
  const f = await fixture();
  f.bridge.config.richResultsEnabled = true;
  const b = f.store.list("binding")[0];
  await f.bridge.publish(b.threadId, b.projectId, "Inline report", true, {
    title: "Review",
    sections: [
      {
        type: "table",
        title: "Results",
        columns: ["Area", "Result"],
        rows: [["Demo", "Pass"]],
      },
    ],
  });
  (f.bridge as any).channelNext.clear();
  await f.bridge.flush();
  const post = f.call.mock.calls.find(([m]) => m === "chat.postMessage")![1];
  expect(post.metadata).toBeUndefined();
  expect(post.blocks.some((b: any) => b.type === "table")).toBe(true);
  expect(post.text).toBe("Inline report");
});
it("clears retained task metadata on a status refresh and preserves the status blocks", async () => {
  const f = await fixture();
  f.store.put("delivery", f.d.id, { ...f.d, state: "queued", next: 0 });
  (f.bridge as any).channelNext.clear();
  await f.bridge.flush();
  expect(f.call).toHaveBeenCalledWith(
    "chat.update",
    expect.objectContaining({
      ts: f.d.ts,
      metadata: {},
      attachments: [],
      text: f.d.text,
      blocks: expect.any(Array),
    }),
  );
  expect(f.store.get("delivery", f.d.id)?.state).toBe("sent");
});
it("keeps status refresh working on an older gateway that rejects clearing metadata", async () => {
  const f = await fixture(),
    previous = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (m, a) =>
    m === "chat.update" && a.metadata
      ? { ok: false, error: "invalid_metadata" }
      : previous(m, a),
  );
  f.store.put("delivery", f.d.id, { ...f.d, state: "queued", next: 0 });
  (f.bridge as any).channelNext.clear();
  await f.bridge.flush();
  const updates = f.call.mock.calls.filter(([m]) => m === "chat.update");
  expect(updates).toHaveLength(2);
  expect(updates[1][1].metadata).toBeUndefined();
  expect(f.bridge.embeds.metadataError).toBe("");
  expect(f.store.get("delivery", f.d.id)?.state).toBe("sent");
});
it("removes a confirmed preview while retaining its content in the same message", async () => {
  const f = await fixture();
  expect(await f.bridge.removeTaskPreview(f.d.id)).toEqual({
    state: "removed",
  });
  expect(f.call).toHaveBeenCalledWith(
    "chat.update",
    expect.objectContaining({
      channel: f.d.channel,
      ts: f.d.ts,
      metadata: {},
      text: f.d.text,
      blocks: [
        { type: "section", text: { type: "plain_text", text: f.d.text } },
      ],
      unfurl_links: false,
      unfurl_media: false,
    }),
  );
  expect(f.call.mock.calls.some(([m]) => m === "chat.postMessage")).toBe(false);
  expect(f.store.get("delivery", f.d.id)).toEqual(f.d);
});
it("delivers and refreshes status as text without inline controls or machine footers", async () => {
  const f = await fixture();
  f.store.put("delivery", f.d.id, { ...f.d, state: "queued", next: 0 });
  (f.bridge as any).channelNext.clear();
  await f.bridge.flush();
  const update = f.call.mock.calls.find(([m]) => m === "chat.update")![1];
  expect(update.blocks).toEqual([
    { type: "section", text: { type: "plain_text", text: f.d.text } },
  ]);
  expect(JSON.stringify(update)).not.toMatch(
    /bridge_(mute|unmute|stop|open)|Runs on your configured/,
  );
});
it("retains every rich section when removing an existing report preview", async () => {
  const f = await fixture();
  const result = {
    title: "Shared report",
    sections: [
      {
        type: "code" as const,
        title: "Code",
        text: 'if (count < 3 && count > 0) return "a & b";',
      },
      {
        type: "table" as const,
        title: "Results",
        columns: ["Area", "Result"],
        rows: [["Demo", "Pass"]],
      },
    ],
  };
  f.store.put("delivery", f.d.id, { ...f.d, card: false, result });
  expect(await f.bridge.removeTaskPreview(f.d.id)).toEqual({
    state: "removed",
  });
  const args = f.call.mock.calls.find(([m]) => m === "chat.update")![1];
  expect(args.blocks.some((b: any) => b.type === "table")).toBe(true);
  expect(JSON.stringify(args.blocks)).toContain("count < 3 && count > 0");
  expect(args.metadata).toEqual({});
  expect(args.attachments).toEqual([]);
});
it.each([
  { state: "queued" },
  { ts: "bad" },
  { card: false },
  { key: "unknown" },
  { channel: "C987654" },
  { root: "1790620000.000042" },
])("rejects unconfirmed or mismatched preview removal: %j", async (change) => {
  const f = await fixture();
  f.store.put("delivery", f.d.id, { ...f.d, ...change } as Delivery);
  await expect(f.bridge.removeTaskPreview(f.d.id)).rejects.toThrow(
    "confirmed task message",
  );
  expect(f.call).not.toHaveBeenCalled();
});
it("refuses cleanup while previews are enabled or Slack is disconnected", async () => {
  const f = await fixture();
  f.bridge.config.embed = { origin: "https://example.com", port: 9485 };
  await expect(f.bridge.removeTaskPreview(f.d.id)).rejects.toThrow(
    "turn task previews off",
  );
  f.bridge.config.embed = undefined;
  await f.bridge.disconnect();
  await expect(f.bridge.removeTaskPreview(f.d.id)).rejects.toThrow(
    "Connect Slack",
  );
});
it("rechecks conversation authorization and configuration before clearing metadata", async () => {
  const f = await fixture(),
    previous = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (m, a) =>
    m === "conversations.info"
      ? { channel: { ...internal, is_ext_shared: true } }
      : previous(m, a),
  );
  await expect(f.bridge.removeTaskPreview(f.d.id)).rejects.toThrow(
    "internal channel",
  );
  f.call.mockImplementation(async (m, a) => {
    if (m === "conversations.info")
      f.bridge.config.embed = { origin: "https://example.com", port: 9485 };
    return previous(m, a);
  });
  await expect(f.bridge.removeTaskPreview(f.d.id)).rejects.toThrow(
    "configuration changed",
  );
  expect(f.call.mock.calls.some(([m]) => m === "chat.update")).toBe(false);
});
it.each(["rejected", "incomplete", "transport"])(
  "reports %s removal without retrying or changing delivery state",
  async (failure) => {
    const f = await fixture(),
      previous = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (m, a) => {
      if (m !== "chat.update") return previous(m, a);
      if (failure === "transport") throw new Error("connection lost");
      return failure === "rejected"
        ? { ok: false, error: "invalid_metadata" }
        : { ok: true };
    });
    expect(await f.bridge.removeTaskPreview(f.d.id)).toEqual({
      state: failure === "rejected" ? "failed" : "uncertain",
      ...(failure === "rejected" ? { error: "invalid_metadata" } : {}),
    });
    expect(f.call.mock.calls.filter(([m]) => m === "chat.update")).toHaveLength(
      1,
    );
    expect(f.store.get("delivery", f.d.id)).toEqual(f.d);
  },
);
