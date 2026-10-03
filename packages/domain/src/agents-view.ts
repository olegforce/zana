/** Persisted selection; an unavailable plugin view falls back in the renderer. */
export type AgentsViewId = 'board' | 'list' | 'flow' | `plugin:${string}/${string}`;

export function isAgentsViewId(value: unknown): value is AgentsViewId {
  return value === 'board' || value === 'list' || value === 'flow' ||
    (typeof value === 'string' && value.length <= 240 && /^plugin:[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(value));
}
