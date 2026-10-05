import { expect, it } from "vitest";
import { applyAttentionEvents } from "./attention.js";
import type { Binding } from "./model.js";
it("follows permission/question lifecycles, ignores unrelated payloads, and never stores their contents", () => {
  const b = {} as Binding;
  applyAttentionEvents(b, [
    {
      seq: 1,
      type: "system/userQuestion/lifecycle",
      payload: {
        interactionId: "q",
        status: "pending",
        payload: "private question",
      },
    },
    {
      seq: 2,
      type: "system/permissionGrant/lifecycle",
      payload: { interactionId: "p", status: "resolving" },
    },
    {
      seq: 3,
      type: "system/operation",
      payload: {
        operationId: "o",
        operation: "plugin_interaction",
        status: "pending",
      },
    },
    {
      seq: 4,
      type: "item/started",
      payload: { item: { id: "i", approvalStatus: "waiting_for_approval" } },
    },
    { seq: 5, type: "system/other", payload: { id: "unknown" } },
    { seq: 6, type: "system/userQuestion/lifecycle", payload: null },
  ]);
  expect(b.pendingInteractions).toEqual(["q", "p", "o", "i"]);
  expect(JSON.stringify(b)).not.toContain("private");
  applyAttentionEvents(b, [
    {
      seq: 1,
      type: "system/userQuestion/lifecycle",
      payload: { interactionId: "stale", status: "pending" },
    },
    {
      seq: 7,
      type: "system/userQuestion/lifecycle",
      payload: { interactionId: "q", status: "resolved" },
    },
    {
      seq: 8,
      type: "system/permissionGrant/lifecycle",
      payload: { interactionId: "p", status: "interrupted" },
    },
    {
      seq: 9,
      type: "system/operation",
      payload: {
        operationId: "o",
        operation: "plugin_interaction",
        status: "resolved",
      },
    },
    {
      seq: 10,
      type: "item/completed",
      payload: { item: { id: "i", approvalStatus: null } },
    },
  ]);
  expect(b.pendingInteractions).toEqual([]);
});

it("builds credential-free local links and omits invalid or remote destinations", async () => {
  const { localThreadLink } = await import("./host.js");
  const original = process.env.ZCC_SERVER_URL;
  try {
    delete process.env.ZCC_SERVER_URL;
    expect(localThreadLink("a/b")).toBe("http://127.0.0.1:8780/threads/a%2Fb");
    process.env.ZCC_SERVER_URL = "http://user:secret@localhost:8781/";
    expect(localThreadLink("t")).toBe("http://localhost:8781/threads/t");
    for (const value of [
      "https://remote.example",
      "bad url",
      "file://localhost/",
    ]) {
      process.env.ZCC_SERVER_URL = value;
      expect(localThreadLink("t")).toBeUndefined();
    }
  } finally {
    if (original === undefined) delete process.env.ZCC_SERVER_URL;
    else process.env.ZCC_SERVER_URL = original;
  }
});
