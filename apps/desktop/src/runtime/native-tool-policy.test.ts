import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createNativeToolPolicyHook, parseNativeToolHookEvent, type NativeToolPolicySession } from './native-tool-policy.js';

const sha = (key: unknown[]) => createHash('sha256').update(JSON.stringify(key)).digest('hex');

// Exactly the keys Claude Code 2.1.296 sends to a PreToolUse hook: no turn_id.
const claudeEvent = {
  session_id: '6f1c2c8e-8a52-4a8b-9d1e-0c9e2f4b7a10',
  transcript_path: '/home/user/.claude/projects/p/6f1c2c8e.jsonl',
  cwd: '/work/project',
  prompt_id: 'a3e1b7c2-5d4f-4e8a-9b6c-2f1d0e9c8b7a',
  permission_mode: 'default',
  effort: 'medium',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'pwd' },
  tool_use_id: 'toolu_01ABC'
};
// Codex's PreToolUse carries the turn id.
const codexEvent = {
  session_id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  transcript_path: '/home/user/.codex/sessions/rollout.jsonl',
  cwd: '/work/project',
  hook_event_name: 'PreToolUse',
  model: 'gpt-5.5',
  permission_mode: 'default',
  turn_id: 'turn-1',
  tool_name: 'Bash',
  tool_use_id: 'call-1',
  tool_input: { command: 'pwd' }
};
const parse = (event: unknown, sessionId = 'session-1') => parseNativeToolHookEvent(sessionId, JSON.stringify(event));

describe('parseNativeToolHookEvent', () => {
  it('keys a Claude call, which has no turn_id, on the session and the call content', () => {
    expect(Object.keys(claudeEvent).sort()).toEqual([
      'cwd', 'effort', 'hook_event_name', 'permission_mode', 'prompt_id', 'session_id', 'tool_input', 'tool_name', 'tool_use_id', 'transcript_path'
    ]);
    expect(parse(claudeEvent)).toEqual({
      invocationId: sha(['session-1', null, 'toolu_01ABC', 'Bash', { command: 'pwd' }]),
      toolName: 'Bash',
      input: { command: 'pwd' }
    });
  });

  it('keys a Codex call with its turn id under the same formula', () => {
    expect(parse(codexEvent)?.invocationId).toBe(sha(['session-1', 'turn-1', 'call-1', 'Bash', { command: 'pwd' }]));
  });

  it('replays an identical retry and separates any change of session or content', () => {
    const id = parse(codexEvent)!.invocationId;
    expect(parse(codexEvent)!.invocationId).toBe(id);
    const variants = [
      parse(codexEvent, 'session-2'),
      parse({ ...codexEvent, turn_id: 'turn-2' }),
      parse({ ...codexEvent, tool_use_id: 'call-2' }),
      parse({ ...codexEvent, tool_name: 'Write' }),
      parse({ ...codexEvent, tool_input: { command: 'rm -rf /tmp/x' } }),
      parse(claudeEvent)
    ].map((call) => call!.invocationId);
    expect(new Set([id, ...variants]).size).toBe(variants.length + 1);
  });

  it('reads a null turn_id as absent, and a missing or null tool_input as {}', () => {
    expect(parse({ ...claudeEvent, turn_id: null })).toEqual(parse(claudeEvent));
    const { tool_input: _dropped, ...withoutInput } = claudeEvent;
    for (const event of [withoutInput, { ...claudeEvent, tool_input: null }]) {
      expect(parse(event)).toEqual({
        invocationId: sha(['session-1', null, 'toolu_01ABC', 'Bash', {}]), toolName: 'Bash', input: {}
      });
    }
  });

  it('ignores identity the body claims for itself', () => {
    expect(parse({ ...claudeEvent, session_id: 'forged', cwd: '/forged', threadId: 'forged', projectId: 'forged', providerId: 'codex' }))
      .toEqual(parse(claudeEvent));
  });

  it.each([
    ['invalid JSON', '{not json'],
    ['null', 'null'],
    ['an array', '[]'],
    ['a number', '1']
  ])('rejects a body that is %s', (_label, body) => {
    expect(parseNativeToolHookEvent('session-1', body)).toBeNull();
  });

  it.each<[string, Record<string, unknown>]>([
    ['a missing tool_use_id', { tool_use_id: undefined }],
    ['an empty tool_use_id', { tool_use_id: '' }],
    ['an oversized tool_use_id', { tool_use_id: 'x'.repeat(513) }],
    ['a tool_use_id with a newline', { tool_use_id: 'a\nb' }],
    ['a numeric tool_use_id', { tool_use_id: 12 }],
    ['a missing tool_name', { tool_name: undefined }],
    ['an empty tool_name', { tool_name: '' }],
    ['an oversized tool_name', { tool_name: 'x'.repeat(513) }],
    ['a tool_name with NUL', { tool_name: 'Ba\u0000sh' }],
    ['a numeric turn_id', { turn_id: 12 }],
    ['an empty turn_id', { turn_id: '' }],
    ['a turn_id with a newline', { turn_id: 'bad\n' }],
    ['an oversized turn_id', { turn_id: 'x'.repeat(513) }],
    ['an array tool_input', { tool_input: ['pwd'] }],
    ['a string tool_input', { tool_input: 'pwd' }],
    ['a numeric tool_input', { tool_input: 1 }]
  ])('rejects %s', (_label, change) => {
    expect(parse({ ...codexEvent, ...change })).toBeNull();
  });

  it('rejects input too deeply nested to re-serialise instead of throwing', () => {
    // ~100 KB, under the route's cap: V8 parses it, but JSON.stringify overflows the stack.
    const depth = 50_000;
    const body = `{"tool_use_id":"call-1","tool_name":"Bash","tool_input":{"a":${'['.repeat(depth)}${']'.repeat(depth)}}}`;
    expect(parseNativeToolHookEvent('session-1', body)).toBeNull();
  });
});

describe('createNativeToolPolicyHook', () => {
  const live: NativeToolPolicySession = { id: 'session-1', projectId: 'project-1', profile: 'claude', status: 'running' };
  const secret = 'SECRET-INPUT-MARKER';
  const body = JSON.stringify({ ...claudeEvent, tool_input: { command: `echo ${secret}` } });

  function setup(reply: unknown, session: NativeToolPolicySession | null = live) {
    const decide = vi.fn(async () => {
      if (reply instanceof Error) throw reply;
      return reply;
    });
    const log = vi.fn();
    const hook = createNativeToolPolicyHook({ getSession: (id) => (session && id === session.id ? session : null), decider: () => decide, log });
    return { hook, decide, log };
  }

  it.each<[string, NativeToolPolicySession | null, string]>([
    ['the session is unknown', null, 'project-1'],
    ['the session has exited', { ...live, status: 'exited' }, 'project-1'],
    ['the URL names another project', live, 'project-2']
  ])('fails closed without asking the policy when %s', async (_label, session, projectId) => {
    const { hook, decide } = setup({ action: 'allow' }, session);
    await expect(hook(projectId, 'session-1', body)).resolves.toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });

  it('fails closed when no policy is reachable (dev has no runtime supervisor)', async () => {
    const hook = createNativeToolPolicyHook({ getSession: () => live, decider: () => null });
    await expect(hook('project-1', 'session-1', body)).resolves.toBeNull();
  });

  it('fails closed on a malformed event without asking the policy', async () => {
    const { hook, decide } = setup({ action: 'allow' });
    await expect(hook('project-1', 'session-1', JSON.stringify({ ...claudeEvent, tool_use_id: undefined }))).resolves.toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });

  it('asserts the live session identity, whatever the body claims', async () => {
    const { hook, decide } = setup({ action: 'allow' });
    const forged = JSON.stringify({ ...claudeEvent, session_id: 'forged', cwd: '/forged', threadId: 'forged', projectId: 'forged', providerId: 'codex' });
    await expect(hook('project-1', 'session-1', forged)).resolves.toEqual({ decision: 'allow', reason: 'allowed' });
    expect(decide).toHaveBeenCalledWith({
      invocationId: sha(['session-1', null, 'toolu_01ABC', 'Bash', { command: 'pwd' }]),
      threadId: 'session-1',
      projectId: 'project-1',
      profile: 'claude',
      toolName: 'Bash',
      input: { command: 'pwd' }
    });
  });

  it('maps a deny with its reason', async () => {
    const { hook } = setup({ action: 'deny', reason: 'blocked by plugin policy' });
    await expect(hook('project-1', 'session-1', body)).resolves.toEqual({ decision: 'deny', reason: 'blocked by plugin policy' });
  });

  it.each<[string, unknown]>([
    ['a rejected request', new Error('server plugins-tool-policy request timed out')],
    ['null', null],
    ['an array', []],
    ['an empty object', {}],
    ['an uppercase action', { action: 'ALLOW' }],
    ['a deny without a reason', { action: 'deny' }],
    ['a deny with an empty reason', { action: 'deny', reason: '' }],
    ['a deny with an oversized reason', { action: 'deny', reason: 'r'.repeat(1025) }],
    ['an allow with extra keys', { action: 'allow', extra: 1 }]
  ])('fails closed and logs once, without the tool input, on %s', async (_label, reply) => {
    const { hook, log } = setup(reply);
    await expect(hook('project-1', 'session-1', body)).resolves.toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).not.toContain(secret);
    expect(log.mock.calls[0]![0].length).toBeLessThanOrEqual(300);
  });

  it('logs a non-Error rejection without echoing it', async () => {
    const log = vi.fn();
    const hook = createNativeToolPolicyHook({
      getSession: () => live,
      decider: () => () => Promise.reject(`raw ${secret}`),
      log
    });
    await expect(hook('project-1', 'session-1', body)).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith('decision failed for session session-: unknown error');
  });
});
