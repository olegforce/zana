import { object, type Binding, type Receipt } from "./model.js";

export const STATUS_EMOJI = {
  queued: "⏳",
  working: "⚙️",
  thinking: "🧠",
  stopping: "⏳",
  stopped: "⏹️",
  completed: "✅",
  attention: "⚠️",
  failed: "❌",
  muted: "🔇",
} as const;
export type StatusKind = keyof typeof STATUS_EMOJI;
export const FORMATTING_NOTICE = "🎨 Formatting in process…";
export const statusText = (kind: StatusKind, text: string) =>
  `${STATUS_EMOJI[kind]} ${text}`;
export const activeStatusKind = (b: Binding): StatusKind =>
  b.stopping
    ? "stopping"
    : b.needsAttention
      ? "attention"
      : b.activity === "thinking"
        ? "thinking"
        : "working";

export function statusKind(r: Receipt, b?: Binding): StatusKind {
  if (["rejected", "needs-review"].includes(r.state)) return "attention";
  if (b?.state === "failed") return "failed";
  if (r.state === "cancelled" || b?.state === "stopped") return "stopped";
  if (["mute", "pause"].includes(r.text)) return "muted";
  if (r.state === "settled") return "completed";
  return r.state === "running" || b?.active === r.id
    ? b
      ? activeStatusKind(b)
      : "working"
    : "queued";
}

export const activeStatusText = (b: Binding) =>
  b.stopping
    ? "Stop requested · Waiting for Zana to confirm."
    : b.needsAttention
      ? "Needs attention in Zana · A permission or question is waiting. Open this conversation in Zana for Slack on your computer."
      : b.activity === "thinking"
        ? "Thinking…"
        : "Working…";

/** Coarse phase only: retain sequence/opaque item id, never reasoning or tool text. */
export function applyActivityEvents(
  b: Binding,
  events: { seq: number; type: string; payload: unknown }[],
): void {
  for (const e of events.slice(0, 500).sort((a, c) => a.seq - c.seq)) {
    if (!Number.isSafeInteger(e.seq) || e.seq <= (b.activityCursor || 0))
      continue;
    b.activityCursor = e.seq;
    const outer = object(e.payload),
      p = object(outer.event || outer);
    const item = object(p.item);
    const id =
      e.type === "item/started" || e.type === "item/completed"
        ? item.id
        : p.itemId;
    const validId = typeof id === "string" && !!id && id.length <= 150;
    if (["turn/started", "turn/completed", "turn/failed"].includes(e.type)) {
      b.activity = "working";
      b.activityItemId = undefined;
    } else if (
      validId &&
      ((e.type === "item/started" && item.type === "reasoning") ||
        [
          "item/reasoning/textDelta",
          "item/reasoning/summaryTextDelta",
        ].includes(e.type))
    ) {
      b.activity = "thinking";
      b.activityItemId = id;
    } else if (
      validId &&
      ((e.type === "item/started" &&
        [
          "agentMessage",
          "commandExecution",
          "fileChange",
          "mcpToolCall",
          "dynamicToolCall",
          "webSearch",
        ].includes(item.type)) ||
        e.type === "item/agentMessage/delta" ||
        (e.type === "item/completed" &&
          item.type === "reasoning" &&
          id === b.activityItemId))
    ) {
      b.activity = "working";
      b.activityItemId = undefined;
    }
  }
}
