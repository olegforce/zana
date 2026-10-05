import { createHash } from "node:crypto";

const MAX_CHANNEL_NAME = 80;
const MAX_CHANNEL_PREFIX = 24;
export const MAX_PROJECT_CHANNELS = 250;
export const PROJECT_SYNC_BATCH_SIZE = 5;

const slug = (value: string, fallback: string): string =>
  value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || fallback;

/** Optional user label placed before the reserved zana marker. */
export function normalizeChannelPrefix(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string")
    throw new Error("Channel prefix must be 24 characters or fewer.");
  if (!value.trim()) return "";
  const normalized = slug(value, "");
  if (!normalized)
    throw new Error("Channel prefix must include a letter or number.");
  if (normalized.length > MAX_CHANNEL_PREFIX)
    throw new Error("Channel prefix must be 24 characters or fewer.");
  return normalized;
}

/** Preferred clean name followed by a stable collision fallback. */
export function projectChannelNames(
  project: { id: string; name: string },
  prefix = "",
): [string, string] {
  const safePrefix = normalizeChannelPrefix(prefix);
  const marker = `${safePrefix ? `${safePrefix}-` : ""}zana-`;
  const stem = slug(project.name, "project");
  const suffix = createHash("sha256")
    .update(project.id)
    .digest("hex")
    .slice(0, 6);
  const cleanRoom = MAX_CHANNEL_NAME - marker.length;
  const fallbackRoom = cleanRoom - suffix.length - 1;
  const cleanStem = stem.slice(0, cleanRoom).replace(/-+$/g, "") || "project";
  const fallbackStem =
    stem.slice(0, fallbackRoom).replace(/-+$/g, "") || "project";
  return [
    `${marker}${cleanStem}`,
    `${marker}${fallbackStem}-${suffix}`,
  ];
}

export function managedChannelName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_CHANNEL_NAME &&
    /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-)?zana-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(
      value,
    )
  );
}
