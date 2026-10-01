import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { experimental_createBridgeJsonRpcTestHarness as createHarness } from "@zana-ai/zcc-plugin-sdk/provider-bridge/testing";
import { experimental_killAllChildrenForTests, handleLine } from "./bridge.js";

const threadId = "default-model-regression";
const policy = { permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null };
let harness: ReturnType<typeof createHarness>;
let workspace: string;
let requestLog: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "zcc-codex-default-"));
  requestLog = join(workspace, "requests.jsonl");
  const script = join(workspace, "script.json");
  writeFileSync(script, JSON.stringify({ requestLogPath: requestLog }));
  vi.stubEnv("BB_CODEX_BRIDGE_APP_SERVER_COMMAND", process.execPath);
  vi.stubEnv("BB_CODEX_BRIDGE_APP_SERVER_ARGS", JSON.stringify([
    fileURLToPath(new URL("./fake-codex-app-server.mjs", import.meta.url)), script,
  ]));
  harness = createHarness(handleLine);
});

afterEach(async () => {
  harness.sendRequest(99, "thread/stop", { threadId, providerThreadId: "cleanup", intent: "release", activeTurnId: null });
  await harness.waitForResponse(99);
  experimental_killAllChildrenForTests();
  harness.restore();
  vi.unstubAllEnvs();
  rmSync(workspace, { recursive: true, force: true });
});

for (const method of ["thread/start", "thread/resume", "thread/fork"] as const) {
  it.each(["default", "configured-model-id"])(`${method} and its turn translate model %s at the native boundary`, async model => {
    const options = { ...policy, model };
    harness.sendRequest(1, method, {
      threadId, cwd: workspace, instructionMode: "append", options,
      ...(method === "thread/resume" ? { providerThreadId: "existing-thread" } : {}),
      ...(method === "thread/fork" ? { sourceProviderThreadId: "existing-thread" } : {}),
    });
    const started = await harness.waitForResponse(1);
    expect(started.error).toBeUndefined();
    const providerThreadId = (started.result as { providerThreadId: string }).providerThreadId;
    harness.sendRequest(2, "turn/start", {
      threadId, providerThreadId, clientRequestId: "creq_23456789ab", options,
      input: [{ type: "text", text: "Hello", mentions: [] }],
    });
    expect((await harness.waitForResponse(2)).error).toBeUndefined();
    const requests = readFileSync(requestLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
    for (const nativeMethod of [method, "turn/start"]) {
      const params = requests.find(row => row.method === nativeMethod)?.params;
      expect(params).toBeDefined();
      if (model === "default") expect(params).not.toHaveProperty("model");
      else expect(params.model).toBe(model);
    }
  });
}
