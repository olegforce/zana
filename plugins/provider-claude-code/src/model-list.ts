import {
  HIGH_REASONING_EFFORT,
  LOW_REASONING_EFFORT,
  MAX_REASONING_EFFORT,
  MEDIUM_REASONING_EFFORT,
  ULTRACODE_REASONING_EFFORT,
  XHIGH_REASONING_EFFORT,
  type AvailableModel,
  type ModelReasoningEffort,
} from "@zana-ai/zcc-plugin-sdk/provider-bridge";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";

function efforts(modelInfo: ModelInfo): ModelReasoningEffort[] {
  const rows = modelInfo.supportedEffortLevels?.length
    ? modelInfo.supportedEffortLevels.flatMap((level) => {
        switch (level) {
          case "low": return [LOW_REASONING_EFFORT];
          case "medium": return [MEDIUM_REASONING_EFFORT];
          case "high": return [HIGH_REASONING_EFFORT];
          case "xhigh": return [XHIGH_REASONING_EFFORT, ULTRACODE_REASONING_EFFORT];
          case "max": return [MAX_REASONING_EFFORT];
        }
      })
    : [LOW_REASONING_EFFORT, MEDIUM_REASONING_EFFORT, HIGH_REASONING_EFFORT];
  return rows.map((row) => ({ ...row }));
}

function modelRow(modelInfo: ModelInfo, model: string, isDefault: boolean): AvailableModel {
  const supportedReasoningEfforts = efforts(modelInfo);
  const levels = supportedReasoningEfforts.map((row) => row.reasoningEffort);
  const defaultReasoningEffort = levels.includes("high")
    ? "high"
    : levels.includes("medium") ? "medium" : (levels[0] ?? "low");
  return {
    id: model,
    model,
    displayName: modelInfo.displayName,
    description: modelInfo.description,
    supportedReasoningEfforts,
    defaultReasoningEffort,
    isDefault,
  };
}

export function buildClaudeCodeModels(discoveredModels: readonly ModelInfo[]): {
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
} {
  const models = new Map<string, AvailableModel>();
  const selectedOnlyModels = new Map<string, AvailableModel>();
  const defaultInfo = discoveredModels.find((row) => row.value === "default");
  const defaultModel = defaultInfo?.resolvedModel;
  if (defaultInfo && defaultModel) models.set(defaultModel, modelRow(defaultInfo, defaultModel, true));

  for (const info of discoveredModels) {
    if (info.value === "default") continue;
    const resolved = info.resolvedModel ?? info.value;
    if (!models.has(resolved)) models.set(resolved, modelRow(info, resolved, resolved === defaultModel));
    if (info.value !== resolved) selectedOnlyModels.set(info.value, modelRow(info, info.value, false));
  }
  if (![...models.values()].some((row) => row.isDefault) && models.size > 0) {
    const first = models.values().next().value as AvailableModel;
    models.set(first.model, { ...first, isDefault: true });
  }
  return { models: [...models.values()], selectedOnlyModels: [...selectedOnlyModels.values()] };
}
