import { describe, expect, it } from 'vitest';
import type { AgentState, TerminalSession } from '@zana-ai/zcc-domain/product';
import type { ThreadListItem } from '../thread-store';
import { filterMobileAgents, mobileAgentItems } from './mobile-agent-items';

const projects = [{ id: 'p1', name: 'Design system' }, { id: 'p2', name: 'Website' }];
const thread = (id: string, extra: Partial<ThreadListItem> = {}): ThreadListItem => ({
  id, projectId: 'p1', hostId: 'host', environmentId: null, providerId: 'fake', status: 'idle',
  title: `Agent ${id}`, createdAt: 1, cwd: null, branchName: null, isWorktree: false, ...extra
});
const session = (id: string, extra: Partial<TerminalSession> = {}): TerminalSession => ({
  id, projectId: 'p2', title: `Agent ${id}`, profile: 'codex', cwd: '/test', status: 'running', createdAt: 2, ...extra
});
const empty = { projects, threads: [], terminals: {}, states: {}, since: {} };

describe('mobile agent history', () => {
  it('combines both agent types across projects, newest first, excluding archives and shells', () => {
    const items = mobileAgentItems({ ...empty,
      threads: [thread('old'), thread('latest', { updatedAt: 30 }), thread('archive', { archivedAt: 20 })],
      terminals: { p2: [session('cli'), session('shell', { profile: 'shell' }), session('scheduled', { scheduled: true })] },
      since: { cli: 10 }
    });
    expect(items.map((item) => item.key)).toEqual(['thread:latest', 'session:cli', 'session:scheduled', 'thread:old']);
    expect(items[0]).toMatchObject({ to: '/threads/latest', projectName: 'Design system', status: 'Idle' });
    expect(items[1]).toMatchObject({ to: '/sessions/cli', projectName: 'Website' });
  });

  it('respects a dedicated project scope, including navigation and missing session lists', () => {
    expect(mobileAgentItems({ ...empty, projectId: 'p1', threads: [thread('a'), thread('b', { projectId: 'p2' })],
      terminals: { p2: [session('cli')] }
    }).map((item) => item.to)).toEqual(['/projects/p1/threads/a']);
    expect(mobileAgentItems({ ...empty, projectId: 'p2', terminals: { p2: [session('cli')] } })[0].to)
      .toBe('/projects/p2/sessions/cli');
  });

  it('keeps untitled and orphaned conversations searchable with a readable fallback', () => {
    const items = mobileAgentItems({ ...empty, threads: [thread('a', { title: null, projectId: 'gone' })],
      terminals: { p2: [session('cli', { title: '' })] }
    });
    expect(items.map((item) => item.title)).toEqual(['Untitled agent', 'Untitled agent']);
    expect(items[1].projectName).toBe('Unknown project');
    expect(filterMobileAgents(items, '  WEBSITE  ')).toEqual([items[0]]);
    expect(filterMobileAgents(items, 'untitled')).toHaveLength(2);
    expect(filterMobileAgents(items, ' ')).toBe(items);
    expect(filterMobileAgents(items, 'missing')).toEqual([]);
  });

  it.each([
    ['blocked', 'Needs you'], ['working', 'Working'], ['waiting', 'Waiting'],
    ['done', 'Finished'], ['idle', 'Idle'], ['unknown', 'Idle']
  ] as const)('uses the live CLI %s state', (state: AgentState, status) => {
    expect(mobileAgentItems({ ...empty, terminals: { p2: [session('cli')] }, states: { cli: state } })[0].status).toBe(status);
  });

  it('handles starting, successful exit and failed exit before stale CLI activity', () => {
    const items = mobileAgentItems({ ...empty, terminals: { p2: [
      session('start', { status: 'starting' }),
      session('success', { status: 'exited', exitCode: 0, finishedAt: 100 }),
      session('failure', { status: 'exited', exitCode: 1, finishedAt: 90 })
    ] }, states: { success: 'working', failure: 'working' } });
    expect(items.map((item) => item.status)).toEqual(['Finished', 'Error', 'Working']);
  });

  it('uses the shared thread status including errors and pending interactions', () => {
    const items = mobileAgentItems({ ...empty, threads: [thread('a', { status: 'error' }),
      thread('b', { hasPendingInteraction: true }), thread('c', { status: 'active' })] });
    expect(items.map((item) => item.status)).toEqual(['Error', 'Needs you', 'Working']);
  });
});
