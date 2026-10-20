/**
 * Resume after API errors (issue #421) — when an agent stops on an API error
 * whose text matches a user-configured rule, type the rule's message
 * (default "continue") into it after a delay.
 *
 * Same shape as {@link HeartbeatService}: every collaborator is injected (no
 * Electron, timers via deps) and every eligibility gate is re-checked when the
 * timer fires, because the agent may have moved on during the delay.
 *
 * Safety:
 *  - Sends only while the agent rests (`idle`/`done`/`waiting`), never into a
 *    permission prompt (`blocked`) or while it works.
 *  - Yields to the human: if `lastInputAt` changed since arming, the person
 *    typed, so we stay out of the way. `reply()` never stamps `lastInputAt`.
 *  - Regex rules run in the bounded regex worker (time limit, no main-loop
 *    ReDoS); a slow or invalid rule is skipped, never fatal.
 *  - A per-session cap (`maxPerWindow` in `windowMinutes`) marks the tab
 *    "needs you" and stops resuming.
 */

import {
  buildApiErrorMatchText,
  type ApiErrorResumeConfig,
  type ApiErrorResumeRule
} from '@zana-ai/zcc-domain/product';
import { createRegexScanner } from '../projects/regex-worker.js';

export type RegexMatchResult = 'match' | 'no-match' | 'timeout' | 'unavailable' | 'invalid';
export type RegexMatcher = (text: string, pattern: string, flags: string) => Promise<RegexMatchResult>;

export function createRegexMatcher(createScanner: typeof createRegexScanner = createRegexScanner): RegexMatcher {
  return async (text, pattern, flags) => {
    const scanner = createScanner();
    if (!scanner) return 'unavailable';
    try {
      const hits = await scanner.scan(text, pattern, flags);
      return hits.length > 0 ? 'match' : 'no-match';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('time limit')) return 'timeout';
      if (message.includes('Invalid search expression')) return 'invalid';
      return 'unavailable';
    } finally {
      scanner.dispose();
    }
  };
}

export type SkippedReason = 'timeout' | 'unavailable' | 'invalid';
export interface SkippedRule { ruleId: string; reason: SkippedReason }

export interface ApiErrorResumeSession {
  projectId: string;
  title: string;
  status: string;
  lastInputAt?: number;
}

export interface ApiErrorResumeDeps {
  getConfig: () => ApiErrorResumeConfig | undefined;
  getSession: (sessionId: string) => ApiErrorResumeSession | null;
  getAgentState: (sessionId: string) => string;
  /** Type a line into the session (body + deferred CR). Returns false if gone. */
  reply: (sessionId: string, text: string) => boolean;
  markNeedsYou: (sessionId: string) => void;
  pushInbox: (input: { projectId: string; subject?: string; comments: string; dedupeKey?: string }) => void;
  matchRegex: RegexMatcher;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer: (handle: NodeJS.Timeout) => void;
  log: (line: string) => void;
}

interface Pending {
  timer: NodeJS.Timeout;
  ruleId: string;
  lastInputAt: number | undefined;
}

const RESTING = new Set(['idle', 'done', 'waiting']);
const UNAVAILABLE_RETRIES = 3;
const UNAVAILABLE_RETRY_MS = 1000;

export class ApiErrorResumeService {
  private pending = new Map<string, Pending>();
  private sends = new Map<string, number[]>();

  constructor(private readonly deps: ApiErrorResumeDeps) {}

  async findRule(
    matchText: string,
    rules: ApiErrorResumeRule[],
    { retry }: { retry: boolean }
  ): Promise<{ rule?: ApiErrorResumeRule; skipped: SkippedRule[] }> {
    const skipped: SkippedRule[] = [];
    const lowered = matchText.toLowerCase();
    for (const rule of rules) {
      if (!rule.enabled) continue;
      if (rule.matchMode === 'contains') {
        if (lowered.includes(rule.match.toLowerCase())) return { rule, skipped };
        continue;
      }
      let result = await this.deps.matchRegex(matchText, rule.match, rule.caseSensitive ? '' : 'i');
      for (let attempt = 0; retry && result === 'unavailable' && attempt < UNAVAILABLE_RETRIES; attempt++) {
        await new Promise<void>(resolve => this.deps.setTimer(resolve, UNAVAILABLE_RETRY_MS));
        result = await this.deps.matchRegex(matchText, rule.match, rule.caseSensitive ? '' : 'i');
      }
      if (result === 'match') return { rule, skipped };
      if (result !== 'no-match') skipped.push({ ruleId: rule.id, reason: result });
    }
    return { skipped };
  }

  async onApiErrorStop(sessionId: string, event: { error: string; text: string }): Promise<void> {
    const { deps } = this;
    const config = deps.getConfig();
    if (!config?.enabled) return deps.log(`[api-error-resume] session=${sessionId.slice(0, 8)} skip: feature off`);
    const session = deps.getSession(sessionId);
    if (!session || session.status === 'exited') {
      return deps.log(`[api-error-resume] session=${sessionId.slice(0, 8)} skip: session gone`);
    }
    const matchText = buildApiErrorMatchText(event.error, event.text);
    const { rule, skipped } = await this.findRule(matchText, config.rules, { retry: true });
    this.notifySlow(session, config.rules, skipped);
    if (!rule) return deps.log(`[api-error-resume] session=${sessionId.slice(0, 8)} skip: no rule matched`);

    const now = deps.now();
    const windowMs = config.windowMinutes * 60000;
    const recent = (this.sends.get(sessionId) ?? []).filter(t => now - t < windowMs);
    if (recent.length > 0) this.sends.set(sessionId, recent); else this.sends.delete(sessionId);
    if (recent.length >= config.maxPerWindow) {
      deps.markNeedsYou(sessionId);
      safely(() => deps.pushInbox({
        projectId: session.projectId,
        subject: `Resume stopped — ${session.title}`,
        comments:
          `Stopped resuming “${session.title}”: “${rule.match}” matched ${recent.length} times in ` +
          `${config.windowMinutes} minutes. Type in the agent to carry on.`,
        dedupeKey: `api-error-resume:cap:${sessionId}:${Math.floor(now / windowMs)}`
      }));
      return deps.log(`[api-error-resume] session=${sessionId.slice(0, 8)} skip: cap reached`);
    }

    this.cancel(sessionId);
    const timer = deps.setTimer(() => this.fire(sessionId), rule.delaySeconds * 1000);
    this.pending.set(sessionId, { timer, ruleId: rule.id, lastInputAt: session.lastInputAt });
  }

  private notifySlow(session: ApiErrorResumeSession, rules: ApiErrorResumeRule[], skipped: SkippedRule[]): void {
    const day = new Date(this.deps.now()).toISOString().slice(0, 10);
    for (const s of skipped) {
      if (s.reason !== 'timeout') continue;
      const rule = rules.find(r => r.id === s.ruleId);
      if (!rule) continue;
      safely(() => this.deps.pushInbox({
        projectId: session.projectId,
        subject: 'Resume rule skipped',
        comments:
          `Rule “${rule.match}” took too long to check, so Zana skipped it. ` +
          `Simplify the pattern in Settings → Agents → Resume after API errors.`,
        dedupeKey: `api-error-resume:slow:${rule.id}:${day}`
      }));
    }
  }

  private fire(sessionId: string): void {
    const { deps } = this;
    const entry = this.pending.get(sessionId);
    this.pending.delete(sessionId);
    const tag = `[api-error-resume] session=${sessionId.slice(0, 8)}`;
    if (!entry) return;
    const config = deps.getConfig();
    if (!config?.enabled) return deps.log(`${tag} skip: feature turned off`);
    const rule = config.rules.find(r => r.id === entry.ruleId);
    if (!rule || !rule.enabled) return deps.log(`${tag} skip: rule removed or disabled`);
    const session = deps.getSession(sessionId);
    if (!session || session.status === 'exited') return deps.log(`${tag} skip: session gone`);
    const state = deps.getAgentState(sessionId);
    if (!RESTING.has(state)) return deps.log(`${tag} skip: agent is ${state}`);
    if (session.lastInputAt !== entry.lastInputAt) return deps.log(`${tag} skip: user typed`);
    if (!deps.reply(sessionId, rule.message)) return deps.log(`${tag} skip: reply failed`);
    const now = deps.now();
    const history = (this.sends.get(sessionId) ?? []).filter(t => now - t < config.windowMinutes * 60000);
    history.push(now);
    this.sends.set(sessionId, history);
    deps.log(`${tag} rule=${rule.id} attempt ${history.length}/${config.maxPerWindow}`);
  }

  cancel(sessionId: string): void {
    const entry = this.pending.get(sessionId);
    if (!entry) return;
    this.deps.clearTimer(entry.timer);
    this.pending.delete(sessionId);
  }

  forget(sessionId: string): void {
    this.cancel(sessionId);
    this.sends.delete(sessionId);
  }

  /** Settings "Check an error": which rule would fire, without sending anything. */
  async check(text: string, rules: ApiErrorResumeRule[]): Promise<{
    ruleId: string | null;
    message?: string;
    delaySeconds?: number;
    skipped: SkippedRule[];
  }> {
    const { rule, skipped } = await this.findRule(buildApiErrorMatchText('', text), rules, { retry: false });
    return rule
      ? { ruleId: rule.id, message: rule.message, delaySeconds: rule.delaySeconds, skipped }
      : { ruleId: null, skipped };
  }
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    /* notifying is best-effort; never let it break the timer path */
  }
}
