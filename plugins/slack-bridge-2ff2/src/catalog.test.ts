import { afterEach, expect, it, vi } from "vitest";
afterEach(() => {
  vi.doUnmock("node:fs");
  vi.resetModules();
});
it("rejects an oversized packaged catalog", async () => {
  vi.resetModules();
  vi.doMock("node:fs", () => ({ readFileSync: () => " ".repeat(128001) }));
  await expect(import("./catalog.js")).rejects.toThrow("too large");
});
it("loads the authored catalog without process JSON-import caching", async () => {
  vi.resetModules();
  vi.doMock("node:fs", () => ({
    readFileSync: () =>
      JSON.stringify({ features: [{ id: "fresh" }], tools: [], commands: [] }),
  }));
  expect((await import("./catalog.js")).default.features[0].id).toBe("fresh");
});
