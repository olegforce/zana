import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ApiErrorResumeConfig, ApiErrorResumeRule } from '@zana-ai/zcc-domain/product';
import {
  ApiErrorResumeService,
  createRegexMatcher,
  type ApiErrorResumeDeps,
  type RegexMatchResult
} from './api-error-resume.js';

const rule = (o: Partial<ApiErrorResumeRule> = {}): ApiErrorResumeRule => ({
  id: 'r1', match: 'Provider anthropic not found', matchMode: 'contains',
  message: 'continue', delaySeconds: 20, enabled: true, ...o
});

function setup(over: { config?: Partial<ApiErrorResumeConfig>; regex?: RegexMatchResult[] } = {}) {
  const state = {
    config: { enabled: true, rules: [rule()], maxPerWindow: 3, windowMinutes: 15, ...over.config } as ApiErrorResumeConfig | undefined,
    session: { projectId: 'p', title: 'Agent', status: 'running', lastInputAt: 1 as number | undefined } as { projectId: string; title: string; status: string; lastInputAt?: number } | null,
    agent: 'idle',
    replyOk: true,
    regex: [...(over.regex ?? [])]
  };
  const deps = {
    getConfig: () => state.config,
    getSession: () => state.session,
    getAgentState: () => state.agent,
    reply: vi.fn(() => state.replyOk),
    markNeedsYou: vi.fn(),
    pushInbox: vi.fn(),
    matchRegex: vi.fn(async () => state.regex.shift() ?? 'no-match'),
    now: () => Date.now(),
    setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimer: (h: NodeJS.Timeout) => clearTimeout(h),
    log: vi.fn()
  } satisfies ApiErrorResumeDeps;
  return { state, deps, svc: new ApiErrorResumeService(deps) };
}
const err = { error: 'Provider ANTHROPIC not found', text: '' };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-21T10:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('matching', () => {
  it('contains ignores case and sends after the delay', async () => {
    const { svc, deps } = setup();
    await svc.onApiErrorStop('abcdef123456', err);
    expect(deps.reply).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20000);
    expect(deps.reply).toHaveBeenCalledWith('abcdef123456', 'continue');
    expect(deps.log).toHaveBeenCalledWith('[api-error-resume] session=abcdef12 rule=r1 attempt 1/3');
  });
  it('regex match / no-match', async () => {
    const r = rule({ matchMode: 'regex', match: 'foo.*bar' });
    const a = setup({ config: { rules: [r] }, regex: ['match'] });
    expect(await a.svc.findRule('x', [r], { retry: false })).toEqual({ rule: r, skipped: [] });
    expect(a.deps.matchRegex).toHaveBeenCalledWith('x', 'foo.*bar', 'i');
    const b = setup({ regex: ['no-match'] });
    expect((await b.svc.findRule('x', [r], { retry: false })).rule).toBeUndefined();
    const cs = rule({ matchMode: 'regex', match: 'Foo.*', caseSensitive: true });
    await b.svc.findRule('x', [cs], { retry: false });
    expect(b.deps.matchRegex).toHaveBeenLastCalledWith('x', 'Foo.*', '');
  });
  it('timeout skips the rule, tries the next, and notifies once per day', async () => {
    const slow = rule({ id: 'slow', matchMode: 'regex', match: '(a+)+$' });
    const ok = rule({ id: 'ok' });
    const { svc, deps } = setup({ config: { rules: [slow, ok] }, regex: ['timeout', 'timeout', 'timeout'] });
    await svc.onApiErrorStop('s1', err);
    await svc.onApiErrorStop('s1', err);
    expect(deps.pushInbox).toHaveBeenCalledTimes(2); // dedupeKey does the daily collapse
    const keys = deps.pushInbox.mock.calls.map(c => (c[0] as { dedupeKey: string }).dedupeKey);
    expect(new Set(keys)).toEqual(new Set(['api-error-resume:slow:slow:2026-10-21']));
    expect((deps.pushInbox.mock.calls[0][0] as { comments: string }).comments).toContain('took too long to check');
    vi.advanceTimersByTime(20000);
    expect(deps.reply).toHaveBeenCalledTimes(1);
  });
  it('invalid is skipped without notice', async () => {
    const bad = rule({ id: 'bad', matchMode: 'regex', match: '(' });
    const { svc, deps } = setup({ regex: ['invalid'] });
    expect(await svc.findRule('x', [bad], { retry: true })).toEqual({ skipped: [{ ruleId: 'bad', reason: 'invalid' }] });
    expect(deps.pushInbox).not.toHaveBeenCalled();
  });
  it('unavailable is retried 3 times, then skipped; with retry:false skipped at once', async () => {
    const r = rule({ id: 'x', matchMode: 'regex', match: 'abcd' });
    const a = setup({ regex: ['unavailable', 'unavailable', 'unavailable', 'unavailable'] });
    const p = a.svc.findRule('t', [r], { retry: true });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await p).toEqual({ skipped: [{ ruleId: 'x', reason: 'unavailable' }] });
    expect(a.deps.matchRegex).toHaveBeenCalledTimes(4);
    const b = setup({ regex: ['unavailable'] });
    expect(await b.svc.findRule('t', [r], { retry: false })).toEqual({ skipped: [{ ruleId: 'x', reason: 'unavailable' }] });
    expect(b.deps.matchRegex).toHaveBeenCalledTimes(1);
    const c = setup({ regex: ['unavailable', 'match'] });
    const q = c.svc.findRule('t', [r], { retry: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await q).rule).toBe(r);
  });
  it('the first matching rule wins and disabled rules are ignored', async () => {
    const a = rule({ id: 'a', match: 'not found', message: 'one' });
    const off = rule({ id: 'off', match: 'not found', enabled: false });
    const b = rule({ id: 'b', match: 'not found', message: 'two' });
    const { svc } = setup();
    expect((await svc.findRule('not found', [off, a, b], { retry: false })).rule).toBe(a);
    expect((await svc.findRule('not found', [off], { retry: false })).rule).toBeUndefined();
  });
});

describe('early exits', () => {
  it.each([
    ['no config', (s: ReturnType<typeof setup>) => { s.state.config = undefined; }],
    ['disabled', (s: ReturnType<typeof setup>) => { s.state.config!.enabled = false; }],
    ['no session', (s: ReturnType<typeof setup>) => { s.state.session = null; }],
    ['exited', (s: ReturnType<typeof setup>) => { s.state.session!.status = 'exited'; }]
  ])('%s sends nothing', async (_n, tweak) => {
    const s = setup();
    tweak(s);
    await s.svc.onApiErrorStop('s1', err);
    vi.advanceTimersByTime(60000);
    expect(s.deps.reply).not.toHaveBeenCalled();
    expect(s.deps.log).toHaveBeenCalled();
  });
  it('no rule matched sends nothing', async () => {
    const s = setup();
    await s.svc.onApiErrorStop('s1', { error: 'other', text: '' });
    vi.advanceTimersByTime(60000);
    expect(s.deps.reply).not.toHaveBeenCalled();
  });
});

describe('fire-time guards', () => {
  it.each([
    ['the user typed', (s: ReturnType<typeof setup>) => { s.state.session!.lastInputAt = 99; }],
    ['working', (s: ReturnType<typeof setup>) => { s.state.agent = 'working'; }],
    ['blocked', (s: ReturnType<typeof setup>) => { s.state.agent = 'blocked'; }],
    ['exited', (s: ReturnType<typeof setup>) => { s.state.session!.status = 'exited'; }],
    ['session gone', (s: ReturnType<typeof setup>) => { s.state.session = null; }],
    ['rule removed', (s: ReturnType<typeof setup>) => { s.state.config!.rules = []; }],
    ['rule disabled', (s: ReturnType<typeof setup>) => { s.state.config!.rules[0].enabled = false; }],
    ['feature disabled', (s: ReturnType<typeof setup>) => { s.state.config!.enabled = false; }],
    ['config gone', (s: ReturnType<typeof setup>) => { s.state.config = undefined; }]
  ])('does not send when %s', async (_n, tweak) => {
    const s = setup();
    await s.svc.onApiErrorStop('s1', err);
    tweak(s);
    vi.advanceTimersByTime(20000);
    expect(s.deps.reply).not.toHaveBeenCalled();
  });
  it.each(['done', 'waiting'])('sends when the agent is %s', async st => {
    const s = setup();
    s.state.agent = st;
    await s.svc.onApiErrorStop('s1', err);
    vi.advanceTimersByTime(20000);
    expect(s.deps.reply).toHaveBeenCalledTimes(1);
  });
  it('a reply returning false records no send', async () => {
    const s = setup({ config: { maxPerWindow: 1 } });
    s.state.replyOk = false;
    await s.svc.onApiErrorStop('s1', err);
    vi.advanceTimersByTime(20000);
    s.state.replyOk = true;
    await s.svc.onApiErrorStop('s1', err);
    expect(s.deps.markNeedsYou).not.toHaveBeenCalled();
  });
  it('cancel clears the pending timer; a new stop replaces the old one', async () => {
    const s = setup();
    await s.svc.onApiErrorStop('s1', err);
    s.svc.cancel('s1');
    s.svc.cancel('s1');
    vi.advanceTimersByTime(20000);
    expect(s.deps.reply).not.toHaveBeenCalled();
    await s.svc.onApiErrorStop('s1', err);
    await s.svc.onApiErrorStop('s1', err);
    vi.advanceTimersByTime(20000);
    expect(s.deps.reply).toHaveBeenCalledTimes(1);
  });
  it('forget clears timer and send history', async () => {
    const s = setup({ config: { maxPerWindow: 1 } });
    await s.svc.onApiErrorStop('s1', err);
    vi.advanceTimersByTime(20000);
    s.svc.forget('s1');
    await s.svc.onApiErrorStop('s1', err);
    expect(s.deps.markNeedsYou).not.toHaveBeenCalled();
    s.svc.forget('s1');
    vi.advanceTimersByTime(20000);
    expect(s.deps.reply).toHaveBeenCalledTimes(1);
  });
});

describe('cancel while matching, rested state, edited rules', () => {
  const slowRegex = () => {
    const slow = rule({ matchMode: 'regex', match: 'foo.*bar' });
    const s = setup({ config: { rules: [slow] } });
    const waiting: ((r: RegexMatchResult) => void)[] = [];
    s.deps.matchRegex.mockImplementation(() => new Promise<RegexMatchResult>((r) => { waiting.push(r); }));
    return { s, release: (r: RegexMatchResult) => waiting.splice(0).forEach((w) => w(r)) };
  };
  it('a cancel during the match stops the stale error from arming', async () => {
    const { s, release } = slowRegex();
    const stopped = s.svc.onApiErrorStop('s1', err);
    s.svc.cancel('s1');
    release('match');
    await stopped;
    vi.advanceTimersByTime(60000);
    expect(s.deps.reply).not.toHaveBeenCalled();
    expect(s.deps.log).toHaveBeenCalledWith(expect.stringContaining('a new turn started'));
  });
  it('a forget during the match stops it too, and a later stop still works', async () => {
    const { s, release } = slowRegex();
    const stopped = s.svc.onApiErrorStop('s1', err);
    s.svc.forget('s1');
    release('match');
    await stopped;
    vi.advanceTimersByTime(60000);
    expect(s.deps.reply).not.toHaveBeenCalled();
    const again = s.svc.onApiErrorStop('s1', err);
    release('match');
    await again;
    vi.advanceTimersByTime(20000);
    expect(s.deps.reply).toHaveBeenCalledTimes(1);
  });
  it('a newer stop supersedes an older one still matching', async () => {
    const { s, release } = slowRegex();
    const first = s.svc.onApiErrorStop('s1', err);
    const second = s.svc.onApiErrorStop('s1', err);
    release('match');
    await Promise.all([first, second]);
    vi.advanceTimersByTime(60000);
    expect(s.deps.reply).toHaveBeenCalledTimes(1);
  });
  it('rests on an API error until the next turn, even with the feature off', async () => {
    const s = setup();
    s.state.config = undefined;
    expect(s.svc.restedOnApiError('s1')).toBe(false);
    await s.svc.onApiErrorStop('s1', err);
    expect(s.svc.restedOnApiError('s1')).toBe(true);
    s.svc.cancel('s1');
    expect(s.svc.restedOnApiError('s1')).toBe(false);
    await s.svc.onApiErrorStop('s1', err);
    s.svc.forget('s1');
    expect(s.svc.restedOnApiError('s1')).toBe(false);
  });
  it('stays rested while a resume is armed', async () => {
    const s = setup();
    await s.svc.onApiErrorStop('s1', err);
    expect(s.svc.restedOnApiError('s1')).toBe(true);
  });
  it('does not send when the rule was edited during the wait', async () => {
    const s = setup();
    await s.svc.onApiErrorStop('s1', err);
    s.state.config!.rules[0] = { ...s.state.config!.rules[0], match: 'something else entirely' };
    vi.advanceTimersByTime(20000);
    expect(s.deps.reply).not.toHaveBeenCalled();
    expect(s.deps.log).toHaveBeenCalledWith(expect.stringContaining('rule edited'));
  });
});

describe('cap', () => {
  it('trips on the 4th, notifies once per window, and recovers after the window', async () => {
    const s = setup();
    for (let i = 0; i < 3; i++) {
      await s.svc.onApiErrorStop('s1', err);
      vi.advanceTimersByTime(20000);
    }
    expect(s.deps.reply).toHaveBeenCalledTimes(3);
    await s.svc.onApiErrorStop('s1', err);
    expect(s.deps.markNeedsYou).toHaveBeenCalledWith('s1');
    expect(s.deps.pushInbox).toHaveBeenCalledTimes(1);
    const input = s.deps.pushInbox.mock.calls[0][0] as { comments: string; dedupeKey: string };
    expect(input.comments).toBe('Stopped resuming “Agent”: “Provider anthropic not found” matched 3 times in 15 minutes. Type in the agent to carry on.');
    expect(input.dedupeKey).toMatch(/^api-error-resume:cap:s1:\d+$/);
    vi.advanceTimersByTime(60000);
    expect(s.deps.reply).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(15 * 60000);
    await s.svc.onApiErrorStop('s1', err);
    vi.advanceTimersByTime(20000);
    expect(s.deps.reply).toHaveBeenCalledTimes(4);
  });
  it('survives a throwing pushInbox', async () => {
    const s = setup({ config: { maxPerWindow: 1 } });
    s.deps.pushInbox.mockImplementation(() => { throw new Error('x'); });
    await s.svc.onApiErrorStop('s1', err);
    vi.advanceTimersByTime(20000);
    await expect(s.svc.onApiErrorStop('s1', err)).resolves.toBeUndefined();
    expect(s.deps.markNeedsYou).toHaveBeenCalled();
  });
});

describe('check', () => {
  it('reports the rule that would fire and nothing is sent', async () => {
    const s = setup();
    expect(await s.svc.check('provider anthropic NOT FOUND', [rule({ message: 'go', delaySeconds: 7 })]))
      .toEqual({ ruleId: 'r1', message: 'go', delaySeconds: 7, skipped: [] });
    expect(await s.svc.check('nothing', [rule()])).toEqual({ ruleId: null, skipped: [] });
    expect(s.deps.reply).not.toHaveBeenCalled();
  });
});

describe('createRegexMatcher', () => {
  const scanner = (scan: () => Promise<unknown[]>) => {
    const dispose = vi.fn();
    return { dispose, make: (() => ({ scan, dispose })) as never };
  };
  it('null scanner is unavailable', async () => {
    expect(await createRegexMatcher((() => null) as never)('a', 'a', 'i')).toBe('unavailable');
  });
  it.each([
    ['hits', async () => [{ line: 1 }], 'match'],
    ['no hits', async () => [], 'no-match'],
    ['time limit', async () => { throw new Error('Search expression exceeded its time limit'); }, 'timeout'],
    ['invalid', async () => { throw new Error('Invalid search expression'); }, 'invalid'],
    ['other error', async () => { throw new Error('boom'); }, 'unavailable'],
    ['non-error throw', async () => { throw 'boom'; }, 'unavailable']
  ])('%s', async (_n, scan, expected) => {
    const sc = scanner(scan as never);
    expect(await createRegexMatcher(sc.make)('a', 'a', 'i')).toBe(expected);
    expect(sc.dispose).toHaveBeenCalledTimes(1);
  });
  it('the real worker times out a catastrophic pattern', async () => {
    vi.useRealTimers();
    const started = Date.now();
    expect(await createRegexMatcher()('a'.repeat(40) + '!', '(a+)+$', '')).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
