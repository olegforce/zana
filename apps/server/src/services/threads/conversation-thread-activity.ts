import {
  getConversationThreadActivityCounts,
  listConversationActiveTurnInputs,
  type ConversationThreadEventRow,
  type ConversationThreadRow
} from '@zana-ai/zcc-db';
import type { ThreadEvent, ThreadActivityState } from '@zana-ai/zcc-domain/thread-runtime';
import {
  EMPTY_THREAD_ACTIVITY,
  extractThreadTimelineActivePlanTurn,
  type ThreadEventWithMeta
} from '@zana-ai/zcc-thread-view';
import type { ProductHttpContext } from '../../http/product-context.js';
import { planCommandForProvider } from './thread-provider-catalog.js';

const ACTIVITY_CACHE_CAP = 256;
const activityCache = new Map<string, { maxSeq: number; status: string; providerId: string; db: unknown; activity: ThreadActivityState }>();

export function resetThreadActivityCache(): void {
  activityCache.clear();
}

function isThreadEvent(value: unknown): value is ThreadEvent {
  return Boolean(
    value
    && typeof value === 'object'
    && 'type' in value
    && 'threadId' in value
    && 'scope' in value
    && (value as { scope?: { kind?: unknown } }).scope
    && typeof (value as { scope: { kind?: unknown } }).scope.kind === 'string'
  );
}

function eventsFromRows(rows: ConversationThreadEventRow[]): ThreadEventWithMeta[] {
  return rows.flatMap((row) => {
    const event = isThreadEvent(row.payload)
      ? row.payload
      : isThreadEvent((row.payload as { event?: unknown } | null)?.event)
        ? (row.payload as { event: ThreadEvent }).event
        : null;
    if (!event) return [];
    return [{
      event,
      meta: { id: row.id, seq: row.sequence, createdAt: row.createdAt }
    }];
  });
}

function remember(
  threadId: string,
  entry: { maxSeq: number; status: string; providerId: string; db: unknown; activity: ThreadActivityState }
): ThreadActivityState {
  if (activityCache.has(threadId)) activityCache.delete(threadId);
  activityCache.set(threadId, entry);
  while (activityCache.size > ACTIVITY_CACHE_CAP) {
    const oldest = activityCache.keys().next().value;
    if (oldest === undefined) break;
    activityCache.delete(oldest);
  }
  return entry.activity;
}

export function activePlanTurnForConversation(
  ctx: Pick<ProductHttpContext, 'db'>,
  thread: Pick<ConversationThreadRow, 'id' | 'providerId' | 'status'>
) {
  if (thread.status !== 'active') return null;
  let beforeSequence: number | undefined;
  for (;;) {
    const inputs = listConversationActiveTurnInputs(ctx.db, thread.id, beforeSequence);
    if (inputs.length === 0) return null;
    for (const input of inputs) {
      const planTurn = extractThreadTimelineActivePlanTurn({
        events: eventsFromRows(input.events),
        planCommand: planCommandForProvider(thread.providerId),
        providerId: thread.providerId,
        threadStatus: thread.status
      });
      if (planTurn) return planTurn;
    }
    beforeSequence = inputs[inputs.length - 1]!.sequence;
  }
}

/** Cached activity rollup keyed by threadId + maxSeq. */
export function threadActivityForConversation(
  ctx: ProductHttpContext,
  thread: Pick<ConversationThreadRow, 'id' | 'providerId' | 'status'>,
  maxSeq: number
): ThreadActivityState {
  const cached = activityCache.get(thread.id);
  if (cached && cached.maxSeq === maxSeq && cached.status === thread.status
    && cached.providerId === thread.providerId && cached.db === ctx.db) return cached.activity;
  const key = { maxSeq, status: thread.status, providerId: thread.providerId, db: ctx.db };
  if (maxSeq <= 0) {
    return remember(thread.id, { ...key, activity: EMPTY_THREAD_ACTIVITY });
  }
  const activity = {
    ...getConversationThreadActivityCounts(ctx.db, thread.id),
    activePlanModeCount: activePlanTurnForConversation(ctx, thread) ? 1 : 0
  };
  return remember(thread.id, { ...key, activity });
}
