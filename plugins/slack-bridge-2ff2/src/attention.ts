import { object, type Binding } from "./model.js";
// Only retain opaque identifiers and sequence numbers; never share prompt/tool payloads.
export function applyAttentionEvents(
  b: Binding,
  events: { seq: number; type: string; payload: unknown }[],
): void {
  const pending = new Set(b.pendingInteractions || []);
  for (const e of events.slice(0, 500).sort((a, c) => a.seq - c.seq)) {
    if (!Number.isSafeInteger(e.seq) || e.seq <= (b.attentionCursor || 0))
      continue;
    b.attentionCursor = e.seq;
    const p = object(e.payload),
      item = object(p.item);
    let id: unknown,
      waiting = false;
    if (
      [
        "system/userQuestion/lifecycle",
        "system/permissionGrant/lifecycle",
      ].includes(e.type)
    ) {
      id = p.interactionId;
      waiting = ["pending", "resolving"].includes(p.status);
    } else if (
      e.type === "system/operation" &&
      p.operation === "plugin_interaction"
    ) {
      id = p.operationId;
      waiting = ["pending", "resolving"].includes(p.status);
    } else if (["item/started", "item/completed"].includes(e.type)) {
      id = item.id;
      waiting = item.approvalStatus === "waiting_for_approval";
    }
    if (typeof id !== "string" || !id || id.length > 150) continue;
    if (waiting && pending.size < 100) pending.add(id);
    else if (!waiting) pending.delete(id);
  }
  b.pendingInteractions = [...pending];
}
