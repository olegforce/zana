import { expect, it } from "vitest";
import {
  activeStatusKind,
  activeStatusText,
  applyActivityEvents,
  statusKind,
  statusText,
} from "./status-view.js";
import type { Binding, Receipt } from "./model.js";
const binding = (patch: Partial<Binding> = {}) =>
  ({ state: "running", active: "r", ...patch }) as Binding;
const receipt = (patch: Partial<Receipt> = {}) =>
  ({ id: "r", text: "Do x", state: "running", ...patch }) as Receipt;

it.each([
  ["received", "queued", "⏳"],
  ["queued", "queued", "⏳"],
  ["running", "working", "⚙️"],
  ["settled", "completed", "✅"],
  ["cancelled", "stopped", "⏹️"],
  ["needs-review", "attention", "⚠️"],
  ["rejected", "attention", "⚠️"],
] as const)("shows the truthful %s request marker", (state, kind, emoji) => {
  expect(statusKind(receipt({ state }))).toBe(kind);
  expect(statusText(kind, "Status")).toBe(`${emoji} Status`);
});
it("keeps stopped, failed, attention and stopping states ahead of a cached thinking phase", () => {
  expect(statusKind(receipt(), binding({ activity: "thinking" }))).toBe(
    "thinking",
  );
  expect(
    statusKind(receipt(), binding({ activity: "thinking", state: "failed" })),
  ).toBe("failed");
  expect(
    statusKind(receipt(), binding({ activity: "thinking", state: "stopped" })),
  ).toBe("stopped");
  expect(
    activeStatusKind(binding({ activity: "thinking", needsAttention: true })),
  ).toBe("attention");
  expect(
    activeStatusKind(binding({ activity: "thinking", stopping: true })),
  ).toBe("stopping");
  expect(
    activeStatusKind(binding({ needsAttention: true, stopping: true })),
  ).toBe("stopping");
  expect(statusKind(receipt({ text: "mute" }))).toBe("muted");
  expect(statusKind(receipt({ text: "pause" }))).toBe("muted");
  expect(statusText("failed", "Error")).toBe("❌ Error");
  expect(activeStatusText(binding({ stopping: true }))).toContain(
    "Stop requested",
  );
  expect(activeStatusText(binding({ needsAttention: true }))).toContain(
    "Needs attention",
  );
  expect(activeStatusText(binding())).toBe("Working…");
});
it("derives thinking from real item signals, sorts sequences, ignores stale/foreign completions and never retains content", () => {
  const b = binding();
  applyActivityEvents(b, [
    {
      seq: 2,
      type: "item/reasoning/textDelta",
      payload: { itemId: "thought", delta: "PRIVATE_REASONING" },
    },
    {
      seq: 1,
      type: "item/started",
      payload: {
        event: { item: { id: "thought", type: "reasoning", text: "SECRET" } },
      },
    },
    {
      seq: NaN,
      type: "item/completed",
      payload: { item: { id: "thought", type: "reasoning" } },
    },
    {
      seq: 3,
      type: "item/completed",
      payload: { item: { id: "other", type: "reasoning" } },
    },
  ]);
  expect(b.activity).toBe("thinking");
  expect(b.activityItemId).toBe("thought");
  expect(activeStatusText(b)).toBe("Thinking…");
  expect(JSON.stringify(b)).not.toMatch(/PRIVATE|SECRET/);
  applyActivityEvents(b, [
    { seq: 2, type: "turn/completed", payload: {} },
    {
      seq: 4,
      type: "item/completed",
      payload: { item: { id: "thought", type: "reasoning" } },
    },
  ]);
  expect(b.activity).toBe("working");
  expect(b.activityItemId).toBeUndefined();
});
it.each([
  "agentMessage",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "webSearch",
])("switches thinking to working on a real %s item", (type) => {
  const b = binding({ activity: "thinking", activityItemId: "thought" });
  applyActivityEvents(b, [
    {
      seq: 1,
      type: "item/started",
      payload: { item: { type, id: "work", command: "PRIVATE" } },
    },
  ]);
  expect(b.activity).toBe("working");
  expect(JSON.stringify(b)).not.toContain("PRIVATE");
});
it.each([
  "turn/started",
  "turn/completed",
  "turn/failed",
  "item/agentMessage/delta",
])("resets a reasoning phase on %s", (type) => {
  const b = binding({ activity: "thinking", activityItemId: "thought" });
  applyActivityEvents(b, [{ seq: 1, type, payload: { itemId: "answer" } }]);
  expect(b.activity).toBe("working");
  expect(b.activityItemId).toBeUndefined();
});
it("handles summary deltas while ignoring missing/oversized ids, unknown item types and malformed payloads", () => {
  const b = binding();
  applyActivityEvents(b, [
    {
      seq: 1,
      type: "item/reasoning/summaryTextDelta",
      payload: { itemId: "thought" },
    },
  ]);
  expect(b.activity).toBe("thinking");
  applyActivityEvents(b, [
    { seq: 2, type: "item/started", payload: null },
    {
      seq: 3,
      type: "item/started",
      payload: { item: { id: "x".repeat(151), type: "reasoning" } },
    },
    {
      seq: 4,
      type: "item/started",
      payload: { item: { id: "x", type: "unknown" } },
    },
    {
      seq: 5,
      type: "item/completed",
      payload: { item: { id: "x", type: "agentMessage" } },
    },
  ]);
  expect(b.activity).toBe("thinking");
  expect(b.activityCursor).toBe(5);
});
it("bounds activity reads and does not pretend another receipt is thinking", () => {
  const b = binding();
  applyActivityEvents(
    b,
    Array.from({ length: 510 }, (_, i) => ({
      seq: i + 1,
      type: "turn/started",
      payload: {},
    })),
  );
  expect(b.activityCursor).toBe(500);
  expect(
    statusKind(
      receipt({ id: "other", state: "received" }),
      binding({ activity: "thinking" }),
    ),
  ).toBe("queued");
});
