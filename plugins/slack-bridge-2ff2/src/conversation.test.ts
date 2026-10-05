import { expect, it } from "vitest";
import { parseDecision, decide } from "./conversation.js";
it.each([
  '{"kind":"answer","text":"Hi"}',
  '{"kind":"clarify","text":"Which Project?","intent":"task"}',
  '{"kind":"launch","projectId":"p1"}',
  '{"kind":"inbox_search","unreadOnly":true}',
  '{"kind":"inbox_read","entryId":"report","documentIndex":1}',
])("accepts bounded typed decisions %s", (value) =>
  expect(parseDecision(value)).toHaveProperty("kind"),
);
it.each([
  "null",
  "{}",
  "[]",
  '{"kind":"exec"}',
  '{"kind":"launch"}',
  '{"kind":"answer","text":""}',
  '{"kind":"inbox_read"}',
  '{"kind":"answer","text":"ok","path":"/etc"}',
  '{"kind":"inbox_search","unreadOnly":"yes"}',
  '{"kind":"inbox_read","entryId":"x","documentIndex":-1}',
  '{"kind":"clarify","text":"which?","intent":"exec"}',
  JSON.stringify({ kind: "answer", text: "a".repeat(3501) }),
  JSON.stringify({ kind: "launch", projectId: 7 }),
])("rejects invalid decision %s", (value) =>
  expect(() => parseDecision(value)).toThrow(),
);
it("rejects an unavailable assistant and cancellation after completion", async () => {
  await expect(
    decide({} as any, {}, new AbortController().signal),
  ).rejects.toThrow(/Update/);
  const c = new AbortController();
  await expect(
    decide(
      {
        assistant: {
          complete: async () => {
            c.abort();
            return { text: '{"kind":"answer","text":"late"}' };
          },
        },
      } as any,
      {},
      c.signal,
    ),
  ).rejects.toThrow();
});
