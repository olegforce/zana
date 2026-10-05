import { describe, it, expect } from "vitest";
import { Store } from "./store.js";
import { dbAdapter, body } from "../test/helpers.js";
import {
  conversationKey,
  parseMention,
  internalChannel,
  string,
  object,
  plainSlack,
} from "./model.js";
import { identity, internal } from "../test/helpers.js";
describe("durable receipts", () => {
  it("migrates idempotently, recovers uncertain work, preserves duplicates, rolls back and prunes only terminal history", () => {
    const { adapter, db } = dbAdapter();
    const store = new Store(adapter);
    expect(store.config().enabled).toBe(false);
    const m = parseMention(body(), identity)!;
    const r = {
      ...m,
      key: conversationKey(m),
      created: Date.now(),
      state: "dispatching" as const,
      note: "",
    };
    expect(store.insert(r)).toBe(true);
    expect(store.insert(r)).toBe(false);
    store.put("delivery", "d1", {
      id: "d1",
      key: r.key,
      channel: r.channel,
      root: r.root,
      text: "reply",
      state: "sending",
      attempts: 1,
      created: 0,
      next: 0,
      note: "",
    });
    new Store(adapter).recover();
    expect(store.get("receipt", r.id)?.state).toBe("needs-review");
    expect(store.get("delivery", "d1")?.state).toBe("uncertain");
    expect(() =>
      store.transaction(() => {
        store.put("receipt", "abort", { ...r, id: "abort" });
        throw new Error("rollback");
      }),
    ).toThrow();
    expect(store.get("receipt", "abort")).toBeUndefined();
    store.put("receipt", "done", { ...r, id: "done", state: "settled" });
    store.put("delivery", "removed-status", {
      ...store.get("delivery", "d1")!,
      id: "removed-status",
      state: "removed",
      remove: true,
    });
    store.prune(Date.now() + 31 * 86400000);
    expect(store.get("delivery", "removed-status")).toBeUndefined();
    expect(store.get("receipt", "done")).toBeUndefined();
    expect(store.get("delivery", "d1")).toBeDefined();
    db.close();
  });
  it("bounds and validates message fields and markup", () => {
    expect(parseMention(null, identity)).toBeNull();
    expect(
      parseMention(
        { ...body(), event: { ...body().event, text: "hello" } },
        identity,
      ),
    ).toBeNull();
    expect(
      parseMention(
        { ...body(), event: { ...body().event, text: "x".repeat(270000) } },
        identity,
      ),
    ).toBeNull();
    expect(
      parseMention(
        { ...body(), event: { ...body().event, thread_ts: "bad" } },
        identity,
      ),
    ).toBeNull();
    expect(
      parseMention(
        { ...body(), event: { ...body().event, subtype: "changed" } },
        identity,
      ),
    ).toBeNull();
    expect(internalChannel(internal)).toBe(true);
    expect(internalChannel({ ...internal, is_ext_shared: undefined })).toBe(
      false,
    );
    expect(object(null)).toEqual({});
    expect(() => string(123)).toThrow();
    expect(() => string("abcd", 3)).toThrow();
    expect(plainSlack("<@all>&")).toBe("&lt;@all&gt;&amp;");
  });
});
