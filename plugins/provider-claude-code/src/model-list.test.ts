import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { buildClaudeCodeModels } from "./model-list.js";

const discovered: ModelInfo[] = [
  { value: "default", resolvedModel: "claude-opus-5-5[1m]", displayName: "Default", description: "Recommended" },
  { value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]", displayName: "Opus", description: "Alias" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "Alias" },
  {
    value: "claude-future-6",
    resolvedModel: "claude-future-6",
    displayName: "Future 6",
    description: "New model",
    supportedEffortLevels: ["low", "xhigh"],
  },
];

describe("buildClaudeCodeModels", () => {
  it("uses only SDK-discovered concrete models and keeps aliases selected-only", () => {
    const result = buildClaudeCodeModels(discovered);
    expect(result.models.map((row) => row.model)).toEqual([
      "claude-opus-5-5[1m]",
      "claude-sonnet-5",
      "claude-future-6",
    ]);
    expect(result.models.filter((row) => row.isDefault).map((row) => row.model))
      .toEqual(["claude-opus-5-5[1m]"]);
    expect(result.selectedOnlyModels.map((row) => row.model)).toEqual(["opus[1m]", "sonnet"]);
    expect(result.models.at(-1)?.supportedReasoningEfforts.map((row) => row.reasoningEffort))
      .toEqual(["low", "xhigh", "ultracode"]);
  });

  it("returns an empty catalog when the SDK reports none", () => {
    expect(buildClaudeCodeModels([])).toEqual({ models: [], selectedOnlyModels: [] });
  });

  it("chooses the first discovered concrete model when no default is reported", () => {
    const result = buildClaudeCodeModels([{
      value: "claude-future-6",
      displayName: "Future 6",
      description: "New model",
    }]);
    expect(result.models[0]).toEqual(expect.objectContaining({ model: "claude-future-6", isDefault: true }));
  });
});
