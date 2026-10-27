import type { AgentState, CloseFollowupFailure, CloseFollowupKeptOpen } from '@zana-ai/zcc-domain/product';

export type { CloseFollowupFailure, CloseFollowupKeptOpen };

export type CloseIdleAgentsResult = {
  closed: number;
  summarized: number;
  followedUp: number;
  /** Agents the wrap-up left open; absent when every agent was closed. */
  keptOpen?: CloseFollowupKeptOpen[];
};

/**
 * Toast text after a bulk close. When nothing was summarized the wording says why
 * if main reported `failures`; without them (older main) it keeps the generic hint.
 */
export function closedToastMessage(
  closed: number,
  summarized: number,
  followedUp: number,
  failures?: CloseFollowupFailure[],
  keptOpen: CloseFollowupKeptOpen[] = []
): string {
  // A kept-open agent that asked something or timed out left a note in the inbox; a `typed` one did not.
  const seeInbox = keptOpen.some((k) => k.reason === 'asks-you' || k.reason === 'timeout') ? ' (see your inbox)' : '';
  if (closed === 0 && keptOpen.length > 0) {
    return `Kept ${keptOpen.length} agent${keptOpen.length === 1 ? '' : 's'} open${seeInbox}.`;
  }
  const bits = [`Closed ${closed} agent${closed === 1 ? '' : 's'}`];
  if (summarized > 0) bits.push(`${summarized} summarized to inbox`);
  if (followedUp > 0) {
    bits.push(`${followedUp} follow-up${followedUp === 1 ? '' : 's'} filed`);
    // The inbox summary write failed but the follow-up still went in: say the summary is lost.
    if (summarized === 0 && failures?.some((f) => f.reason === 'write-failed')) bits.push('could not save the summary');
  } else if (summarized > 0) {
    // A failed follow-up write must not read as "nothing to file".
    if (failures?.some((f) => f.reason === 'write-failed')) bits.push('could not file the follow-up');
    else bits.push('no unfinished work found');
  } else {
    // Raw CLI detail stays in the main-process log; the toast says what happened in plain words.
    if (failures?.some((f) => f.reason === 'summary-failed')) bits.push('the AI summary failed (details in the log)');
    else if (failures?.some((f) => f.reason === 'unparseable')) bits.push('the AI reply could not be understood');
    else if (failures?.some((f) => f.reason === 'write-failed')) bits.push('could not save the summary or follow-up');
    else bits.push('no readable transcript found');
  }
  if (keptOpen.length > 0) bits.push(`${keptOpen.length} kept open`);
  return `${bits.join(' · ')}${seeInbox}.`;
}


export function selectCloseableIdleIds(
  sessionIds: string[],
  statusById: Record<string, AgentState | undefined>,
  force: boolean
): string[] {
  if (force) return [...sessionIds];
  return sessionIds.filter((id) => {
    const st = statusById[id];
    return st !== 'working' && st !== 'blocked';
  });
}

/** Sticky progress copy while Close with follow-up waits on the LLM paper trail. */
export function closeFollowupProgressMessage(count: number, wrapUp = false): string {
  if (wrapUp) {
    return count === 1
      ? 'Wrapping up… the agent saves what it learnt, then closes.'
      : `Wrapping up ${count} agents… each closes when it finishes.`;
  }
  return count === 1
    ? 'Closing… filing a follow-up if work is left.'
    : `Closing ${count} agents… filing follow-ups.`;
}

export async function runCloseIdleAgents(input: {
  projectId: string;
  sessionIds: string[];
  summarize: boolean;
  force: boolean;
  /** "Wrap up before closing": one call per agent, each closed as soon as its own result arrives. */
  wrapUp?: boolean;
  deps: {
    statusById: Record<string, AgentState | undefined>;
    alreadyClosingIds: ReadonlySet<string>;
    markClosing: (ids: string[]) => void;
    clearClosing: (ids: string[]) => void;
    closeFollowup: (
      projectId: string,
      ids: string[]
    ) => Promise<{
      summarized: number;
      followedUp: number;
      failures?: CloseFollowupFailure[];
      keptOpen?: CloseFollowupKeptOpen[];
    }>;
    closeTerminal: (sessionId: string, projectId: string) => Promise<void>;
    pushBusyToast: (requestedCount: number) => void;
    pushErrorToast: (err: unknown) => void;
    pushClosedToast: (
      closed: number,
      summarized: number,
      followedUp: number,
      failures?: CloseFollowupFailure[],
      keptOpen?: CloseFollowupKeptOpen[]
    ) => void;
    pushProgressToast: (count: number) => string;
    dismissProgressToast: (id: string) => void;
  };
}): Promise<CloseIdleAgentsResult> {
  const { projectId, sessionIds, summarize, force, wrapUp = false, deps } = input;
  if (sessionIds.length === 0) return { closed: 0, summarized: 0, followedUp: 0 };
  const eligible = selectCloseableIdleIds(sessionIds, deps.statusById, force);
  if (eligible.length === 0) {
    deps.pushBusyToast(sessionIds.length);
    return { closed: 0, summarized: 0, followedUp: 0 };
  }
  const ids = eligible.filter((id) => !deps.alreadyClosingIds.has(id));
  if (ids.length === 0) return { closed: 0, summarized: 0, followedUp: 0 };

  deps.markClosing(ids);
  let progressToastId: string | undefined;
  try {
    let summarized = 0;
    let followedUp = 0;
    let failures: CloseFollowupFailure[] | undefined;
    const keptOpen: CloseFollowupKeptOpen[] = [];
    let closed = 0;
    const closeOne = async (id: string) => {
      try {
        await deps.closeTerminal(id, projectId);
        closed++;
      } catch {
        /* closeTerminal already toasts */
      }
    };
    if (summarize && wrapUp) {
      progressToastId = deps.pushProgressToast(ids.length);
      let errorShown = false;
      await Promise.all(
        ids.map(async (id) => {
          let kept = false;
          try {
            const res = await deps.closeFollowup(projectId, [id]);
            summarized += res.summarized;
            followedUp += res.followedUp;
            if (res.failures?.length) failures = [...(failures ?? []), ...res.failures];
            const own = (res.keptOpen ?? []).filter((k) => k.sessionId === id);
            kept = own.length > 0;
            keptOpen.push(...own);
          } catch (err) {
            if (!errorShown) deps.pushErrorToast(err);
            errorShown = true;
          }
          // Close each agent as soon as its own wrap-up is done, so a fast one does not sit idle meanwhile.
          if (!kept) await closeOne(id);
        })
      );
    } else {
      if (summarize) {
        progressToastId = deps.pushProgressToast(ids.length);
        try {
          const res = await deps.closeFollowup(projectId, ids);
          summarized = res.summarized;
          followedUp = res.followedUp;
          failures = res.failures;
          keptOpen.push(...(res.keptOpen ?? []));
        } catch (err) {
          deps.pushErrorToast(err);
        }
      }
      const keptIds = new Set(keptOpen.map((k) => k.sessionId));
      for (const id of ids) {
        if (!keptIds.has(id)) await closeOne(id);
      }
    }
    if (progressToastId) {
      deps.dismissProgressToast(progressToastId);
      progressToastId = undefined;
    }
    if (closed > 0 || keptOpen.length > 0) deps.pushClosedToast(closed, summarized, followedUp, failures, keptOpen);
    return keptOpen.length > 0 ? { closed, summarized, followedUp, keptOpen } : { closed, summarized, followedUp };
  } finally {
    if (progressToastId) deps.dismissProgressToast(progressToastId);
    deps.clearClosing(ids);
  }
}
