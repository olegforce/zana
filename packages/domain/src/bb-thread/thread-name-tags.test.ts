import { describe, expect, it } from "vitest";
import { fromProviderExternalThreadName, toProviderExternalThreadName, normalizeProviderThreadNameEvent } from "./thread-name-tags.js";
import { threadScope } from "./thread-event-scope.js";

describe("provider thread names", () => {
  it.each(["Architecture", "[zcc] Literal", "[bb] Literal", ""])("round trips %j with one ZCC tag", title => {
    const external = toProviderExternalThreadName(title);
    expect(external).toBe(`[zcc] ${title}`);
    expect(fromProviderExternalThreadName(external)).toBe(title);
  });
  it.each([["[bb] Old session", "Old session"], ["[bb] [bb] Literal", "[bb] Literal"], ["[other] Name", "[other] Name"], ["[zcc]No space", "[zcc]No space"]])("reads existing name %j", (external, title) => {
    expect(fromProviderExternalThreadName(external)).toBe(title);
  });
  it("normalizes provider rename events without mutating their identity", () => {
    const event = { type: "thread/name/updated" as const, threadId: "t", providerThreadId: "p", scope: threadScope(), threadName: "[bb] Existing" };
    expect(normalizeProviderThreadNameEvent(event)).toEqual({ ...event, threadName: "Existing" });
    expect(event.threadName).toBe("[bb] Existing");
    const identity = { type: "thread/identity" as const, threadId: "t", providerThreadId: "p", scope: threadScope() };
    expect(normalizeProviderThreadNameEvent(identity)).toBe(identity);
  });
});
