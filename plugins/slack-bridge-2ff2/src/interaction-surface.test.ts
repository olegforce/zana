import { expect, it, vi } from "vitest";
import { persistSlackSurface } from "./interaction-surface.js";
it("persists the generic surface and refuses an unsupported host or failed write", async () => {
  const updatePluginMetadata = vi.fn(async () => ({}));
  await persistSlackSurface({ sdk: { threads: { updatePluginMetadata } } } as any, "t1");
  expect(updatePluginMetadata).toHaveBeenCalledWith({ threadId: "t1", set: { interactionSurface: { kind: "remote", label: "Slack" } } });
  await expect(persistSlackSurface({ sdk: { threads: {} } } as any, "t1")).rejects.toThrow("Update Zana");
  updatePluginMetadata.mockRejectedValueOnce(Error("offline"));
  await expect(persistSlackSurface({ sdk: { threads: { updatePluginMetadata } } } as any, "t1")).rejects.toThrow("offline");
});
