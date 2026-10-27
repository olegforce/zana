/**
 * Wrap up before closing, for conversation threads (issue #537). When "Close
 * with follow-up" is used with the experiment on, the thread is sent the wrap-up
 * instructions as one more message, and a background job waits for the turn to
 * end. The close request returns at once: a wrap-up can take up to 15 minutes
 * and must not depend on the renderer's request.
 *
 * Same shape as {@link WrapUpCloseService} for CLI agents: every collaborator is
 * injected, one job per thread, every gate is re-checked when a timer fires, and
 * the hub subscription and every timer are released on every path.
 *
 * Rules:
 *  - The job subscribes to thread updates BEFORE it sends, and counts only an
 *    `active` edge seen after the send.
 *  - A pending interaction before the send means the thread already waits on the
 *    user: nothing is sent, the inbox says so, the thread stays open.
 *  - An offline host, or a send that throws, falls back to today's close path.
 *  - Outcome after the send, whichever comes first: a pending interaction that
 *    lasts 5 s or a question in the summary (kept open, inbox note), a rest that
 *    lasts 5 s (summary, inbox, archive), the user writing in the thread (kept
 *    open, no record), an error turn, or 15 minutes (kept open).
 *  - A failed summary still archives: a failed courtesy never blocks the close.
 *  - The hub listener catches everything and never throws.
 */

import { getConversationThread } from '@zana-ai/zcc-db';
import { resolveCloseWrapUpInstructions } from '@zana-ai/zcc-domain/product';
import type { ProductHttpContext } from '../../http/product-context.js';
import type { CloseRecordHow, KeptOpenReason, SessionCloseNote, SummarizeForCloseResult } from '../followups/close-summary.js';
import { conversationDigest } from './conversation-digest.js';
import { archiveConversation, sendConversationTurn } from './conversation-lifecycle.js';
import { conversationMessageTexts } from './conversation-timeline.js';

/** A rest or a pending interaction must last this long before it counts. */
export const WRAP_UP_SETTLE_MS = 5_000;
/** A thread still busy this long after the request is left running. */
export const WRAP_UP_TIMEOUT_MS = 15 * 60_000;

/** The slice of the `threads:updated` payload the job reads. */
interface ThreadUpdate {
  id?: string;
  status?: string;
  hasPendingInteraction?: boolean;
}

export interface ThreadWrapUpHost {
  instructions: () => string;
  hasPendingInteraction: (threadId: string) => boolean;
  hostOnline: (thread: ThreadWrapUpTarget) => boolean;
  getStatus: (threadId: string) => string | undefined;
  send: (threadId: string, text: string) => Promise<unknown>;
  subscribe: (listener: (payload: unknown) => void) => () => void;
  messages: (threadId: string) => Array<{ seq: number; role: 'user' | 'assistant'; text: string }>;
  digest: (threadId: string) => string;
  summarizeForClose: (projectId: string, threadId: string, opts: { digest: string; title: string }) => Promise<SummarizeForCloseResult>;
  recordClose: (projectId: string, threadId: string, title: string, note: SessionCloseNote, how: CloseRecordHow) => Promise<unknown>;
  recordKeptOpen: (projectId: string, threadId: string, title: string, reason: KeptOpenReason, note?: SessionCloseNote) => Promise<unknown>;
  archive: (threadId: string) => Promise<unknown>;
  setTimer: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer: (handle: NodeJS.Timeout) => void;
  log: (line: string) => void;
}

export interface ThreadWrapUpTarget {
  id: string;
  projectId: string;
  hostId: string;
  title?: string | null;
}

const isActive = (status: string | undefined) => status === 'active' || status === 'starting';

class Job {
  private unsubscribe: (() => void) | undefined;
  private rest: NodeJS.Timeout | undefined;
  private block: NodeJS.Timeout | undefined;
  private timeout: NodeJS.Timeout | undefined;
  private armed = false;
  private needIdle = false;
  private edge = false;
  private done = false;
  private seqBeforeSend = 0;
  private readonly title: string;
  private readonly instructions: string;

  constructor(
    private readonly host: ThreadWrapUpHost,
    private readonly thread: ThreadWrapUpTarget,
    private readonly onDone: () => void
  ) {
    this.title = thread.title?.trim() || 'Untitled agent';
    this.instructions = host.instructions();
  }

  /** Returns false when today's close path must run instead. */
  async start(): Promise<boolean> {
    const { host, thread } = this;
    if (host.hasPendingInteraction(thread.id)) {
      await this.keepOpen('asks-you');
      return true;
    }
    if (!host.hostOnline(thread)) {
      this.finish();
      return false;
    }
    this.unsubscribe = host.subscribe((payload) => this.onUpdate(payload));
    this.timeout = host.setTimer(() => void this.keepOpen('timeout'), WRAP_UP_TIMEOUT_MS);
    try {
      this.seqBeforeSend = Math.max(0, ...host.messages(thread.id).map((m) => m.seq));
      this.needIdle = isActive(host.getStatus(thread.id));
      this.armed = true;
      await host.send(thread.id, this.instructions);
    } catch (err) {
      host.log(`[thread-wrap-up] thread=${thread.id.slice(0, 8)} send failed: ${err instanceof Error ? err.message : String(err)}`);
      this.finish();
      return false;
    }
    return true;
  }

  dispose(): void {
    this.finish();
  }

  private onUpdate(payload: unknown): void {
    try {
      const view = payload as ThreadUpdate | null;
      if (this.done || !this.armed || !view || view.id !== this.thread.id) return;
      if (view.status === 'error') {
        void this.keepOpen('turn-error');
        return;
      }
      this.watchPending(view.hasPendingInteraction === true);
      if (!this.edge) {
        if (this.needIdle) this.needIdle = isActive(view.status);
        else if (view.status === 'active') this.edge = true;
        return;
      }
      if (view.status === 'idle' && view.hasPendingInteraction !== true) {
        this.rest ??= this.host.setTimer(() => void this.onRest(), WRAP_UP_SETTLE_MS);
      } else {
        this.clear('rest');
      }
    } catch (err) {
      this.host.log(`[thread-wrap-up] listener failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private watchPending(pending: boolean): void {
    if (!pending) return this.clear('block');
    this.block ??= this.host.setTimer(() => void this.onBlocked(), WRAP_UP_SETTLE_MS);
  }

  private clear(which: 'rest' | 'block'): void {
    const handle = this[which];
    if (handle) this.host.clearTimer(handle);
    this[which] = undefined;
  }

  /** The rest lasted: re-check, then summarise and close (or keep open). */
  private async onRest(): Promise<void> {
    this.rest = undefined;
    const { host, thread } = this;
    if (this.done || host.getStatus(thread.id) !== 'idle' || host.hasPendingInteraction(thread.id)) return;
    if (this.userWroteAfterWrapUp()) return this.finish(); // the user took over: keep it open, no record
    this.stop();
    const note = await this.summarize();
    try {
      if (note?.asksUser) {
        await host.recordKeptOpen(thread.projectId, thread.id, this.title, 'asks-you', note);
      } else {
        if (note) await host.recordClose(thread.projectId, thread.id, this.title, note, 'wrapped');
        await host.archive(thread.id);
      }
    } catch (err) {
      host.log(`[thread-wrap-up] thread=${thread.id.slice(0, 8)} close failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.finish();
  }

  /** The thread waits on the user: record what we know and keep it open. */
  private async onBlocked(): Promise<void> {
    this.block = undefined;
    if (this.done || !this.host.hasPendingInteraction(this.thread.id)) return;
    this.stop();
    const note = await this.summarize();
    await this.keepOpen('asks-you', note);
  }

  private userWroteAfterWrapUp(): boolean {
    const after = this.host.messages(this.thread.id).filter((m) => m.role === 'user' && m.seq > this.seqBeforeSend);
    return after.length > 1 || (after.length === 1 && after[0].text.trim() !== this.instructions.trim());
  }

  /** Summary of the whole thread, or undefined when it failed (the close goes on without it). */
  private async summarize(): Promise<SessionCloseNote | undefined> {
    try {
      const res = await this.host.summarizeForClose(this.thread.projectId, this.thread.id, {
        digest: this.host.digest(this.thread.id),
        title: this.title
      });
      return res.ok ? res.note : undefined;
    } catch (err) {
      this.host.log(`[thread-wrap-up] summary failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** Stop watching: the outcome is being written. */
  private stop(): void {
    this.armed = false;
    this.clear('rest');
    this.clear('block');
    if (this.timeout) this.host.clearTimer(this.timeout);
    this.timeout = undefined;
  }

  private async keepOpen(reason: KeptOpenReason, note?: SessionCloseNote): Promise<void> {
    if (this.done) return;
    this.stop();
    try {
      await this.host.recordKeptOpen(this.thread.projectId, this.thread.id, this.title, reason, note);
    } catch (err) {
      this.host.log(`[thread-wrap-up] thread=${this.thread.id.slice(0, 8)} record failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.finish();
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    this.stop();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.onDone();
  }
}

/** One wrap-up job per thread id. */
export class ThreadWrapUpRegistry {
  private jobs = new Map<string, Job>();

  constructor(private readonly host: ThreadWrapUpHost) {}

  isWrappingUp(threadId: string): boolean {
    return this.jobs.has(threadId);
  }

  /**
   * Start the wrap-up, or join the one already running (nothing is sent twice).
   * Resolves `false` when the caller must fall back to today's close path.
   */
  async request(thread: ThreadWrapUpTarget): Promise<boolean> {
    if (this.jobs.has(thread.id)) return true;
    const job = new Job(this.host, thread, () => {
      if (this.jobs.get(thread.id) === job) this.jobs.delete(thread.id);
    });
    this.jobs.set(thread.id, job);
    return job.start();
  }

  dispose(): void {
    for (const job of [...this.jobs.values()]) job.dispose();
  }
}

const registries = new WeakMap<ProductHttpContext, ThreadWrapUpRegistry>();

/** The per-server registry, wired to the real thread, hub and close-summary services. */
export function threadWrapUps(ctx: ProductHttpContext): ThreadWrapUpRegistry {
  let registry = registries.get(ctx);
  if (!registry) {
    registry = new ThreadWrapUpRegistry({
      instructions: () => resolveCloseWrapUpInstructions(ctx.config.getConfig()),
      hasPendingInteraction: (id) => ctx.pendingInteractions.hasPendingThreadInteraction(id),
      hostOnline: (thread) => ctx.hostHub.connectedHostIds?.().includes(thread.hostId) === true,
      getStatus: (id) => getConversationThread(ctx.db, id)?.status,
      send: (id, text) => sendConversationTurn(ctx, id, [{ type: 'text', text, mentions: [] }], 'queue-if-active'),
      subscribe: (listener) => ctx.hub.subscribe('threads:updated', listener),
      messages: (id) => conversationMessageTexts(ctx, id),
      digest: (id) => conversationDigest(ctx, id),
      summarizeForClose: (projectId, id, opts) => ctx.closeSummary.summarizeForClose(projectId, id, opts),
      recordClose: (...args) => ctx.closeSummary.recordClose(...args),
      recordKeptOpen: (...args) => ctx.closeSummary.recordKeptOpen(...args),
      archive: (id) => archiveConversation(ctx, id),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle),
      log: (line) => console.warn(line)
    });
    registries.set(ctx, registry);
  }
  return registry;
}

/** Release every job's subscription and timers; called from `ctx.dispose`. */
export function disposeThreadWrapUps(ctx: ProductHttpContext): void {
  registries.get(ctx)?.dispose();
  registries.delete(ctx);
}
