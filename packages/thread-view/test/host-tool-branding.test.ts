import { describe, expect, it } from "vitest";
import { createTimelineEventFactory } from "./timeline-test-harness.js";
import { decodeThreadEventRow } from "../src/event-decode.js";
import { parseToolCallLifecycleEvent } from "../src/exec-lifecycle.js";
import { parseAgentMessageEnvelope } from "../src/agent-message-envelope.js";

describe("host tool display", () => {
  it.each(["bb", "zcc", "external", undefined])("renders server %j without changing stored events", server => {
    const factory = createTimelineEventFactory({ threadId: "t" });
    for (const row of [factory.toolCallStarted({ itemId: "call", tool: "inbox_push", arguments: { comments: "Ready" } }), factory.toolCallCompleted({ itemId: "call", tool: "inbox_push", result: "Saved" })]) {
      if (row.data.item.type !== "toolCall") throw new Error("Expected tool event");
      row.data.item.server = server;
      const { event, meta } = decodeThreadEventRow(row);
      const display = parseToolCallLifecycleEvent(event, meta);
      expect(display).toMatchObject({ call: { callId: "call", toolName: `${server ? `${server === "bb" ? "zcc" : server}:` : ""}inbox_push` } });
      expect(row.data.item.server).toBe(server);
    }
  });
  it.each(["zcc", "bb"])("reads %s message envelopes", name => {
    const prefix = `[${name} message from thread:sender; reply later]\n\n`;
    expect(parseAgentMessageEnvelope(prefix + "Hello")).toEqual({ senderThreadId: "sender", bodyStart: prefix.length });
    expect(parseAgentMessageEnvelope(`untrusted ${prefix}`)).toBeNull();
  });
});
