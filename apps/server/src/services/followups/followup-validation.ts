import type { FollowUp, FollowUpKind, FollowUpOrigin, FollowUpStatus } from '@zana-ai/zcc-domain/product';
const VALID_STATUS: FollowUpStatus[] = ['open', 'resolved', 'dismissed'];
const VALID_KIND: FollowUpKind[] = ['question', 'decision', 'note'];

/** Cap on the option list so a hand-edited / agent-supplied file stays a scannable
 *  picker, not a survey (mirrors the inbox MAX_OPTIONS bound). */
const MAX_OPTIONS = 20;


/** Coerce arbitrary JSON into a clean option list, or undefined when absent/empty. */
function sanitizeOptions(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const cleaned = raw
    .filter((o): o is string => typeof o === 'string')
    .map((o) => o.trim())
    .filter((o) => o.length > 0)
    .slice(0, MAX_OPTIONS);
  return cleaned.length > 0 ? cleaned : undefined;
}


/** Coerce arbitrary JSON into a clean {@link FollowUpOrigin}. Defaults to user. */
function sanitizeOrigin(raw: unknown): FollowUpOrigin {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (r.source === 'idle-triage' && typeof r.sessionId === 'string') {
    const confidence =
      typeof r.confidence === 'number' && Number.isFinite(r.confidence)
        ? Math.max(0, Math.min(1, r.confidence))
        : undefined;
    return { source: 'idle-triage', sessionId: r.sessionId, confidence };
  }
  if (r.source === 'agent' && typeof r.sessionId === 'string') {
    return { source: 'agent', sessionId: r.sessionId };
  }
  return { source: 'user' };
}

/**
 * Validate a follow-up JSON file. Returns the record on success, or `{ error }`
 * so the caller can log why a file was dropped. Tolerant of hand edits: missing
 * optional pieces get defaults. Pure; exported for tests.
 */
export function validateFollowUpFile(raw: unknown): FollowUp | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'not an object' };
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id.trim()) return { error: 'missing id' };
  if (typeof r.title !== 'string' || !r.title.trim()) return { error: 'missing title' };
  if (typeof r.projectId !== 'string' || !r.projectId.trim()) return { error: 'missing projectId' };

  const status =
    typeof r.status === 'string' && VALID_STATUS.includes(r.status as FollowUpStatus)
      ? (r.status as FollowUpStatus)
      : 'open';
  const kind =
    typeof r.kind === 'string' && VALID_KIND.includes(r.kind as FollowUpKind)
      ? (r.kind as FollowUpKind)
      : 'question';
  const origin = sanitizeOrigin(r.origin);

  const followUp: FollowUp = {
    id: r.id,
    projectId: r.projectId,
    title: r.title.trim(),
    detail: typeof r.detail === 'string' ? r.detail : undefined,
    kind,
    status,
    origin,
    options: sanitizeOptions(r.options),
    sessionId:
      typeof r.sessionId === 'string'
        ? r.sessionId
        : origin.source !== 'user'
          ? origin.sessionId
          : undefined,
    resolution: typeof r.resolution === 'string' ? r.resolution : undefined,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString(),
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date().toISOString(),
    resolvedAt: typeof r.resolvedAt === 'string' ? r.resolvedAt : undefined,
    spawnedAt: typeof r.spawnedAt === 'string' ? r.spawnedAt : undefined,
    dedupeKey: typeof r.dedupeKey === 'string' && r.dedupeKey.trim() ? r.dedupeKey : undefined,
    occurrences:
      typeof r.occurrences === 'number' && Number.isFinite(r.occurrences) && r.occurrences > 1
        ? Math.floor(r.occurrences)
        : undefined
  };
  return followUp;
}
