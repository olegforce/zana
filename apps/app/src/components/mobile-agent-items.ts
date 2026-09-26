import type { AgentState, Project, TerminalSession } from '@zana-ai/zcc-domain/product';
import type { ThreadListItem } from '../thread-store';
import { getAgentSessionRoutePath, getThreadRoutePath } from '../lib/route-paths';
import { isVisibleThread, threadRailStatus, threadTitle } from './fleet-item';

export interface MobileAgentItem {
  key: string;
  title: string;
  projectName: string;
  to: string;
  status: 'Needs you' | 'Working' | 'Idle' | 'Error' | 'Finished' | 'Waiting';
  updatedAt: number;
}

export function mobileCliAgentStatus(session: Pick<TerminalSession, 'status' | 'exitCode'>, state?: AgentState): MobileAgentItem['status'] {
  return session.status === 'exited'
    ? (session.exitCode ? 'Error' : 'Finished')
    : state === 'blocked' ? 'Needs you'
    : state === 'working' || session.status === 'starting' ? 'Working'
    : state === 'waiting' ? 'Waiting'
    : state === 'done' ? 'Finished' : 'Idle';
}

/** One history across projects, using the same live rosters as the Agents view. */
export function mobileAgentItems({ projects, threads, terminals, states, since, projectId }: {
  projects: readonly Pick<Project, 'id' | 'name'>[];
  threads: readonly ThreadListItem[];
  terminals: Record<string, TerminalSession[]>;
  states: Record<string, AgentState | undefined>;
  since: Record<string, number | undefined>;
  projectId?: string;
}): MobileAgentItem[] {
  const names = new Map(projects.map((project) => [project.id, project.name]));
  const items: MobileAgentItem[] = threads
    .filter((thread) => isVisibleThread(thread) && (!projectId || thread.projectId === projectId))
    .map((thread) => ({
      key: `thread:${thread.id}`,
      title: threadTitle(thread),
      projectName: names.get(thread.projectId) ?? 'Unknown project',
      to: getThreadRoutePath(thread.id, projectId),
      status: threadRailStatus(thread),
      updatedAt: thread.updatedAt ?? thread.createdAt
    }));
  for (const project of projects) {
    if (projectId && project.id !== projectId) continue;
    for (const session of terminals[project.id] ?? []) {
      if (session.profile === 'shell') continue;
      const state = states[session.id];
      const status = mobileCliAgentStatus(session, state);
      items.push({
        key: `session:${session.id}`,
        title: session.title || 'Untitled agent',
        projectName: project.name,
        to: getAgentSessionRoutePath(session.id, projectId),
        status,
        updatedAt: session.finishedAt ?? since[session.id] ?? session.createdAt
      });
    }
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
}

export function filterMobileAgents(items: readonly MobileAgentItem[], search: string): readonly MobileAgentItem[] {
  const query = search.trim().toLocaleLowerCase();
  return query ? items.filter((item) => `${item.title} ${item.projectName}`.toLocaleLowerCase().includes(query)) : items;
}
