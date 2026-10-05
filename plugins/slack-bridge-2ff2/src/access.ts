import catalog from "./catalog.js";
import type { Config, Delivery } from "./model.js";

export const slackFeatures = catalog.features;
export type SlackFeature =
  | "projects"
  | "imports"
  | "launch"
  | "followups"
  | "status"
  | "answers"
  | "plugins";
export const accessMessage =
  "This functionality is disabled in Zana → Plugins → Zana for Slack → What Slack can do.";
/** The desktop is authoritative. Missing flags preserve existing installations. */
export function featureEnabled(config: Config, id: SlackFeature): boolean {
  if (id === "imports")
    return (
      featureEnabled(config, "projects") &&
      !!config.projectSync?.enabled &&
      !!config.projectSync.allowSlackImport
    );
  if (id === "launch")
    return (
      featureEnabled(config, "projects") && config.slackAccess?.launch !== false
    );
  return config.slackAccess?.[id] !== false;
}
export function toolEnabled(config: Config, name: string): boolean {
  const feature = slackFeatures.find((f) => f.tools.includes(name));
  return !!feature && featureEnabled(config, feature.id as SlackFeature);
}
export function accessView(config: Config) {
  return slackFeatures.map((f) => ({
    ...f,
    enabled: featureEnabled(config, f.id as SlackFeature),
    available:
      f.id === "imports"
        ? !!config.projectSync?.enabled && featureEnabled(config, "projects")
        : f.id !== "launch" || featureEnabled(config, "projects"),
  }));
}
export function setFeature(
  config: Config,
  id: unknown,
  enabled: unknown,
): void {
  if (
    typeof id !== "string" ||
    typeof enabled !== "boolean" ||
    !slackFeatures.some((f) => f.id === id)
  )
    throw new Error("Choose a valid Slack functionality.");
  if (
    enabled &&
    ["imports", "launch"].includes(id) &&
    !featureEnabled(config, "projects")
  )
    throw new Error("Enable Browse Projects first.");
  if (id === "imports") {
    if (!config.projectSync?.enabled)
      throw new Error("Save Project import defaults first.");
    config.projectSync.allowSlackImport = enabled;
  } else {
    config.slackAccess = { ...config.slackAccess, [id]: enabled };
  }
}
/** Recheck after async authorization, including fallback Slack deliveries. */
export function deliveryEnabled(config: Config, d: Delivery): boolean {
  if (
    d.questionId &&
    (config.questionsEnabled !== true || !featureEnabled(config, "followups"))
  )
    return false;
  if (d.canvasId && config.canvasEnabled !== true) return false;
  if (d.result && config.richResultsEnabled !== true) return false;
  if (d.id.startsWith("home-root:")) return featureEnabled(config, "launch");
  if (d.origin === "agent" || d.origin === "operator")
    return featureEnabled(config, "answers");
  return (
    !!d.control || d.id.startsWith("help:") || featureEnabled(config, "status")
  );
}
