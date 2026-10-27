import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { MemoryRouter } from 'react-router-dom';

const h = vi.hoisted(() => ({
  closeTerminal: vi.fn(),
  closeIdleAgents: vi.fn(async () => ({ closed: 1, summarized: 1, followedUp: 1 })),
  closingFollowupIds: new Set<string>(),
  closeWrapUpEnabled: false
}));

vi.mock('../store.js', () => ({
  useData: Object.assign(
    (selector: (s: {
      closeTerminal: typeof h.closeTerminal;
      closingFollowupIds: Set<string>;
      closeWrapUpEnabled: boolean;
      projects: unknown[];
      idleAttentionSensitivity: string;
    }) => unknown) =>
      selector({
        closeTerminal: h.closeTerminal,
        closingFollowupIds: h.closingFollowupIds,
        projects: [],
        idleAttentionSensitivity: 'balanced',
        closeWrapUpEnabled: h.closeWrapUpEnabled
      }),
    {
      getState: () => ({
        closeTerminal: h.closeTerminal,
        closeIdleAgents: h.closeIdleAgents,
        closingFollowupIds: h.closingFollowupIds,
        closeWrapUpEnabled: h.closeWrapUpEnabled
      })
    }
  ),
  useIdleTriage: () => undefined
}));

import {
  AgentCardMenu,
  AgentDeleteQuickAction,
  canCloseWithFollowup,
  cliAgentArchives,
  cliAgentMenuProjectId,
  cliAgentRemoveConfirm,
  cliAgentRemoveLabel,
  cliAgentRestartConfirm,
  cliAgentRestartLiveTitle,
  closeAgentWithFollowup,
  useAgentCardActions
} from './agentCardActions.js';

describe('cliAgentMenuProjectId', () => {
  it('uses the focused project when the shell is project-focused', () => {
    expect(cliAgentMenuProjectId({ isProjectFocused: true, focusedProjectId: 'p1' })).toBe('p1');
  });
});

describe('AgentDeleteQuickAction', () => {
  it('renders an Archive control for a live CLI agent', () => {
    const html = renderToStaticMarkup(
      <AgentDeleteQuickAction
        session={{ id: 's1', title: 'Hello', status: 'running', profile: 'claude' }}
        projectId="p1"
      />
    );
    expect(html).toContain('data-testid="agent-delete-quick"');
    expect(html).toContain('aria-label="Archive Hello"');
    expect(html).toContain('lucide-archive');
    expect(html).not.toContain('Delete Hello');
    expect(html).toContain('agent-delete-quick');
  });

  it('keeps the bin and Delete for a live plain shell', () => {
    const html = renderToStaticMarkup(
      <AgentDeleteQuickAction
        session={{ id: 's1', title: 'Hello', status: 'running', profile: 'shell' }}
        projectId="p1"
      />
    );
    expect(html).toContain('aria-label="Delete Hello"');
    expect(html).toContain('lucide-trash');
    expect(html).not.toContain('Archive Hello');
  });

  it('labels an exited row as dismiss', () => {
    const html = renderToStaticMarkup(
      <AgentDeleteQuickAction
        session={{ id: 's1', title: 'Hello', status: 'exited', profile: 'claude' }}
        projectId="p1"
      />
    );
    expect(html).toContain('Dismiss Hello');
    expect(html).not.toContain('Delete Hello');
  });

  it('closes the session without a confirm dialog', () => {
    const source = readFileSync(new URL('./agentCardActions.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('export function AgentDeleteQuickAction');
    const end = source.indexOf('export function clampMenuAnchor');
    const body = source.slice(start, end);
    expect(body).toContain('void closeTerminal(session.id, projectId)');
    expect(body).not.toContain('confirm');
    expect(body).not.toContain('actions.remove');
  });
});

describe('plugin agent card menu', () => {
  it('portals the right-click menu to document.body', () => {
    const source = readFileSync(new URL('./agentCardActions.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('export function AgentCardMenu');
    const end = source.indexOf('export function AgentDeleteQuickAction');
    const body = source.slice(start, end);
    expect(body).toContain('createPortal(node, document.body)');
    expect(body).toContain("typeof document === 'undefined'");
  });

  it('runs experimental_agentCardAction from the overflow menu', () => {
    const source = readFileSync(new URL('./agentCardActions.tsx', import.meta.url), 'utf8');
    expect(source).toContain('listAgentCardActions');
    expect(source).toContain('invokeAgentCardAction');
    expect(source).toContain('agent-card-plugin-');
  });

  it('offers Close with follow-up on live Claude-family cards', () => {
    const source = readFileSync(new URL('./agentCardActions.tsx', import.meta.url), 'utf8');
    expect(source).toContain('canCloseWithFollowup(card.session)');
    expect(source).toContain('actions.closeWithFollowup(card)');
    expect(source).toContain('Close with follow-up');
    expect(source).toContain("closingWithFollowup ? (wrapUpClose ? 'Wrapping up…' : 'Closing…') : 'Close with follow-up'");
    expect(source).toContain('disabled={closingWithFollowup}');
    expect(source).toContain('closingFollowupIds.has(card.session.id)');
    expect(source).toContain('closeIdleAgents(projectId, [session.id], true, { force: true })');
    expect(source).toContain('Open in split');
    expect(source).toContain('openAgentSessionInSplit');
    expect(source).toContain('getAgentSessionRoutePath(card.session.id, menuProjectId)');
    expect(source).toContain('cliAgentMenuProjectId');
    expect(source).toContain('cliAgentRemoveLabel(card.session)');
    expect(source).toContain('cliAgentRestartLiveTitle()');
    expect(source).not.toContain('Kill and');
  });
});

describe('AgentCardMenu Close with follow-up item', () => {
  afterEach(() => {
    h.closeWrapUpEnabled = false;
    h.closingFollowupIds.clear();
  });

  function followupButton() {
    const card = { projectId: 'p1', state: 'idle', session: { id: 's1', title: 'Boss', status: 'running', profile: 'claude' } } as never;
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AgentCardMenu menu={{ card, x: 0, y: 0 }} setMenu={() => {}} actions={{} as never} />
      </MemoryRouter>
    );
    const match = /<button type="button"( disabled="")? title="([^"]*)">((?:Close with follow-up|Closing…|Wrapping up…))<\/button>/.exec(html);
    return { title: match?.[2], label: match?.[3] };
  }

  it('keeps today\'s label and tooltip with the experiment off', () => {
    expect(followupButton()).toEqual({
      title: 'Close the agent, summarising its work to your inbox and filing a follow-up if it left something unfinished',
      label: 'Close with follow-up'
    });
    h.closingFollowupIds.add('s1');
    expect(followupButton().label).toBe('Closing…');
  });

  it('says Wrapping up… and explains the wrap-up with the experiment on', () => {
    h.closeWrapUpEnabled = true;
    expect(followupButton()).toEqual({
      title: 'Ask the agent to wrap up, then close it with a summary in your inbox and a follow-up if work is left',
      label: 'Close with follow-up'
    });
    h.closingFollowupIds.add('s1');
    expect(followupButton().label).toBe('Wrapping up…');
  });
});

describe('AgentCardMenu remove item', () => {
  function removeButton(session: Record<string, unknown>) {
    const card = {
      projectId: 'p1',
      state: 'idle',
      session: { id: 's1', title: 'Boss', status: 'running', profile: 'claude', ...session }
    } as never;
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AgentCardMenu menu={{ card, x: 0, y: 0 }} setMenu={() => {}} actions={{} as never} />
      </MemoryRouter>
    );
    const match = /<button class="tab-context-danger" title="([^"]*)">([^<]*)<\/button>/.exec(html);
    return { title: match?.[1], label: match?.[2] };
  }

  it('archives a live agent with the History tooltip', () => {
    const button = removeButton({});
    expect(button.label).toBe('Archive');
    expect(button.title).toBe(
      'Stop the agent and remove it from the board. Its conversation stays in History.'
    );
  });

  it('keeps Delete for a live plain shell', () => {
    const button = removeButton({ profile: 'shell' });
    expect(button.label).toBe('Delete');
    expect(button.title).toBe('Terminate this agent and remove it from the board');
  });

  it('keeps Dismiss for an exited card', () => {
    const button = removeButton({ status: 'exited' });
    expect(button.label).toBe('Dismiss');
    expect(button.title).toBe('Dismiss this finished agent from the board');
  });
});

describe('cliAgentArchives / cliAgentRemoveLabel', () => {
  it('archives live agents, deletes live shells and dismisses exited sessions', () => {
    const claude = { status: 'running', profile: 'claude' } as const;
    const codex = { status: 'running', profile: 'codex' } as const;
    const shell = { status: 'running', profile: 'shell' } as const;
    expect(cliAgentArchives(claude)).toBe(true);
    expect(cliAgentArchives(codex)).toBe(true);
    expect(cliAgentArchives(shell)).toBe(false);
    expect(cliAgentArchives({ status: 'exited', profile: 'claude' })).toBe(false);
    expect(cliAgentRemoveLabel(claude)).toBe('Archive');
    expect(cliAgentRemoveLabel(codex)).toBe('Archive');
    expect(cliAgentRemoveLabel(shell)).toBe('Delete');
    expect(cliAgentRemoveLabel({ status: 'exited', profile: 'claude' })).toBe('Dismiss');
    expect(cliAgentRemoveLabel({ status: 'exited', profile: 'shell' })).toBe('Dismiss');
  });
});

describe('cliAgentRemoveConfirm', () => {
  it('tells an agent it stays in History', () => {
    expect(cliAgentRemoveConfirm({ title: 'Review', profile: 'claude' })).toBe(
      'Archive “Review”? The agent stops and its conversation stays in History.'
    );
  });

  it('keeps the Delete wording for a plain shell', () => {
    const text = cliAgentRemoveConfirm({ title: 'Review', profile: 'shell' });
    expect(text).toBe('Delete “Review”? The process will be terminated.');
    expect(text).not.toMatch(/Stop/);
  });
});

function captureActions(confirm: () => boolean) {
  vi.stubGlobal('window', { confirm });
  let actions!: ReturnType<typeof useAgentCardActions>['actions'];
  function Probe() {
    actions = useAgentCardActions().actions;
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return actions;
}

describe('useAgentCardActions remove', () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => h.closeTerminal.mockClear());

  const card = (session: Record<string, unknown>) =>
    ({ projectId: 'p1', session: { id: 's1', title: 'Boss', status: 'running', profile: 'claude', ...session } }) as never;
  const lead = { cohort: { role: 'orchestrator', teamName: 'Crew' } };

  it('warns that archiving an agent lead also stops its team', () => {
    const confirm = vi.fn(() => false);
    const actions = captureActions(confirm);
    actions.remove(card(lead));
    expect(confirm).toHaveBeenCalledWith(
      'Archive “Boss”? It\'s the orchestrator, so archiving it also stops every other agent in “Crew”. Their conversations stay in History.'
    );
    expect(h.closeTerminal).not.toHaveBeenCalled();
  });

  it('keeps the Close wording for a shell lead', () => {
    const confirm = vi.fn(() => false);
    const actions = captureActions(confirm);
    actions.remove(card({ ...lead, profile: 'shell' }));
    expect(confirm).toHaveBeenCalledWith(
      'Close “Boss”? It\'s the orchestrator — closing it will also stop every other agent in “Crew”.'
    );
  });

  it('uses the shared confirm for a non-lead and closes when accepted', () => {
    const confirm = vi.fn(() => true);
    const actions = captureActions(confirm);
    actions.remove(card({}));
    expect(confirm).toHaveBeenCalledWith(
      'Archive “Boss”? The agent stops and its conversation stays in History.'
    );
    expect(h.closeTerminal).toHaveBeenCalledWith('s1', 'p1');
  });

  it('closes an exited card without a prompt', () => {
    const confirm = vi.fn(() => true);
    const actions = captureActions(confirm);
    actions.remove(card({ status: 'exited' }));
    expect(confirm).not.toHaveBeenCalled();
    expect(h.closeTerminal).toHaveBeenCalledWith('s1', 'p1');
  });
});

describe('cliAgentRestart copy', () => {
  it('mentions stopping the process without Kill', () => {
    expect(cliAgentRestartLiveTitle()).toBe(
      'Stop the process and relaunch this session with the same profile and args'
    );
    expect(cliAgentRestartConfirm('Hello')).toBe('Stop the process and relaunch "Hello"?');
    expect(cliAgentRestartLiveTitle()).not.toMatch(/Kill/i);
    expect(cliAgentRestartConfirm('Hello')).not.toMatch(/Kill/i);
  });
});

describe('canCloseWithFollowup', () => {
  it('allows a live Claude session and rejects shells and exited sessions', () => {
    expect(canCloseWithFollowup({ status: 'running', profile: 'claude' })).toBe(true);
    expect(canCloseWithFollowup({ status: 'running', profile: 'shell' })).toBe(false);
    expect(canCloseWithFollowup({ status: 'exited', profile: 'claude' })).toBe(false);
  });
});

describe('closeAgentWithFollowup', () => {
  it('confirms then closes with summarize=true', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    h.closeIdleAgents.mockClear();
    h.closingFollowupIds.clear();
    const ok = await closeAgentWithFollowup({ id: 's1', title: 'Review' }, 'p1');
    expect(ok).toBe(true);
    expect(confirm).toHaveBeenCalled();
    expect(h.closeIdleAgents).toHaveBeenCalledWith('p1', ['s1'], true, { force: true });
    vi.unstubAllGlobals();
  });

  it('returns false without closing when the user cancels', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    h.closeIdleAgents.mockClear();
    h.closingFollowupIds.clear();
    const ok = await closeAgentWithFollowup({ id: 's1', title: 'Review' }, 'p1');
    expect(ok).toBe(false);
    expect(h.closeIdleAgents).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('returns false without confirming when the session is already closing', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    h.closeIdleAgents.mockClear();
    h.closingFollowupIds.add('s1');
    const ok = await closeAgentWithFollowup({ id: 's1', title: 'Review' }, 'p1');
    expect(ok).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(h.closeIdleAgents).not.toHaveBeenCalled();
    h.closingFollowupIds.clear();
    vi.unstubAllGlobals();
  });
});

describe('closeAgentWithFollowup with wrap-up', () => {
  afterEach(() => {
    h.closeWrapUpEnabled = false;
    h.closingFollowupIds.clear();
    vi.unstubAllGlobals();
  });

  it('asks with the wrap-up confirm text only when on', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    await closeAgentWithFollowup({ id: 's1', title: 'Review' }, 'p1');
    expect(confirm).toHaveBeenLastCalledWith('Close “Review” and file a follow-up if work is left?');
    h.closeWrapUpEnabled = true;
    await closeAgentWithFollowup({ id: 's1', title: 'Review' }, 'p1');
    expect(confirm).toHaveBeenLastCalledWith(
      'Close “Review” with follow-up? The agent first saves what it learnt and tidies up, then closes with a summary in your inbox. If it asks you something, it stays open.'
    );
  });

  it('returns false when the agent stayed open, true when it was closed', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    h.closeWrapUpEnabled = true;
    h.closeIdleAgents.mockResolvedValueOnce({ closed: 0, summarized: 0, followedUp: 0, keptOpen: [{ sessionId: 's1', reason: 'asks-you' }] } as never);
    expect(await closeAgentWithFollowup({ id: 's1', title: 'Review' }, 'p1')).toBe(false);
    h.closeIdleAgents.mockResolvedValueOnce({ closed: 1, summarized: 1, followedUp: 0, keptOpen: [{ sessionId: 'other', reason: 'typed' }] } as never);
    expect(await closeAgentWithFollowup({ id: 's1', title: 'Review' }, 'p1')).toBe(true);
  });

  it('returns false when the close itself failed with the wrap-up on, and today\'s true with it off', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    h.closeWrapUpEnabled = true;
    h.closeIdleAgents.mockResolvedValueOnce({ closed: 0, summarized: 1, followedUp: 0 } as never);
    expect(await closeAgentWithFollowup({ id: 's1', title: 'Review' }, 'p1')).toBe(false);
    h.closeWrapUpEnabled = false;
    h.closeIdleAgents.mockResolvedValueOnce({ closed: 0, summarized: 0, followedUp: 0 } as never);
    expect(await closeAgentWithFollowup({ id: 's1', title: 'Review' }, 'p1')).toBe(true);
  });
});

describe('CLI agent rail delete wiring', () => {
  it('shows a delete bin on workspace-rail CLI agents instead of a status dot', () => {
    const projects = readFileSync(new URL('./listpane/ProjectsList.tsx', import.meta.url), 'utf8');
    const rows = readFileSync(new URL('./listpane/project-session-rail-rows.tsx', import.meta.url), 'utf8');
    expect(rows).toContain('<AgentDeleteQuickAction session={session} projectId={projectId} />');
    expect(projects).not.toContain('agentActions.remove(sessionToCard(t, p))');
    expect(projects).not.toContain('AgentStatusDot');
  });
});
