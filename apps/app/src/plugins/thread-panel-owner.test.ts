import { describe, expect, it } from 'vitest';
import { agentSessionPanelOwnerId, resolveThreadPanelOwnerId } from './thread-panel-owner.js';

describe('resolveThreadPanelOwnerId', () => {
  it('prefers the visible panel over the card hint and the URL', () => {
    expect(resolveThreadPanelOwnerId(['thread-on-screen', 'message-thread', 'route-thread', null])).toBe(
      'thread-on-screen'
    );
  });

  it('uses the card hint when the URL has no thread', () => {
    expect(resolveThreadPanelOwnerId([null, 'message-thread', null, 'session-1'])).toBe('message-thread');
  });

  it('falls through to the agent session in the URL', () => {
    expect(resolveThreadPanelOwnerId([undefined, '  ', null, 'session-1'])).toBe('session-1');
  });

  it('returns null when nothing identifies a panel', () => {
    expect(resolveThreadPanelOwnerId([null, '', '  ', undefined])).toBeNull();
  });
});

describe('agentSessionPanelOwnerId', () => {
  it('keeps the inspector panel distinct from the docked session', () => {
    expect(agentSessionPanelOwnerId('sess-1', false)).toBe('sess-1');
    expect(agentSessionPanelOwnerId('sess-1', true)).toBe('sess-1:modal');
  });
});
