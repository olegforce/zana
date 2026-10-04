import type { ExecutionBoardProjection } from '@zana-ai/zcc-domain/product';
import type { PluginAgentsViewProps, PluginAgentsViewRegistration, PluginFleetMember } from '@zana-ai/zcc-plugin-sdk';
import { visibleAgentLanes, executionNeedsAttention } from '../components/AgentBoard.js';
import { threadRailStatus, threadHarnessLabel, cliHarnessLabel, type FleetItem } from '../components/fleet-item.js';
export function agentsViewKey(slot: Pick<PluginAgentsViewRegistration, 'pluginId' | 'id'>): `plugin:${string}/${string}` {
  return `plugin:${slot.pluginId}/${slot.id}`;
}
export function resolveAgentsView(preferred: string, slots: readonly PluginAgentsViewRegistration[]): string {
  return preferred.startsWith('plugin:') && !slots.some((slot) => agentsViewKey(slot) === preferred) ? 'board' : preferred;
}
export function fleetKey(item: Pick<FleetItem, 'kind' | 'id'>): string {
  return `${item.kind}:${item.id}`;
}
export function executionKey(item: Pick<ExecutionBoardProjection, 'projectId' | 'executionId'>): string {
  return `execution:${item.projectId}:${item.executionId}`;
}
/** Reuses board lane rules, without squad collapsing or synthetic agent counts. */
export function projectAgentsView(fleet: readonly FleetItem[], executions: readonly ExecutionBoardProjection[], sensitivity: 'high' | 'medium' | 'low'): Pick<PluginAgentsViewProps, 'members' | 'schedules' | 'executions'> {
  const members: PluginFleetMember[] = [];
  const liveSessionIds = new Set<string>();
  for (const item of fleet) {
    if (item.kind === 'schedule')
      continue;
    if (item.kind === 'thread') {
      const label = threadRailStatus(item.thread);
      const status = label === 'Needs you' ? 'needs-you' : label.toLowerCase() as PluginFleetMember['status'];
      members.push({ key: fleetKey(item), kind: item.kind, projectId: item.projectId, title: item.title,
        status, detail: label, live: status !== 'error', scheduled: false, harness: threadHarnessLabel(item.thread.providerId ?? '') });
    }
    else {
      const { card } = item;
      const live = card.session.status !== 'exited';
      if (live)
        liveSessionIds.add(item.id);
      const lane = visibleAgentLanes(true).find((lane) => lane.match(card, sensitivity))?.key;
      const status: PluginFleetMember['status'] = !live
        ? (card.session.exitCode != null && card.session.exitCode !== 0 ? 'error' : 'done')
        : lane === 'blocked' ? 'needs-you' : lane === 'working' ? 'working'
          : card.state === 'unknown' ? 'unknown' : 'idle';
      const detail = !live ? (card.session.exitCode == null ? 'Exited · outcome unknown' : `Exited · code ${card.session.exitCode}`)
        : status === 'needs-you' ? 'Needs you' : card.state === 'blocked' ? 'Working · background agent blocked'
          : status === 'unknown' ? 'Status unknown' : status === 'working' ? 'Working' : 'Idle';
      members.push({ key: fleetKey(item), kind: item.kind, projectId: item.projectId, title: item.title,
        status, detail, live, scheduled: !!card.session.scheduled, harness: cliHarnessLabel(card.session.profile ?? ''),
        ...(card.session.cohort ? { teamId: card.session.cohort.executionId ?? card.session.cohort.cohortId } : {}) });
    }
  }
  return {
    members,
    schedules: fleet.flatMap((item) => item.kind === 'schedule' ? [{
        key: fleetKey(item), title: item.title, projectId: item.projectId, enabled: item.task.enabled, harness: cliHarnessLabel(item.task.profile ?? ''),
        nextRunAt: item.task.enabled ? item.task.status?.nextRunAt ?? null : null,
        running: (item.task.status?.runs ?? []).some((run) => !!run.sessionId && liveSessionIds.has(run.sessionId) && !run.finishedAt && run.durationMs === undefined)
          || (!!item.task.status?.lastRunSessionId && liveSessionIds.has(item.task.status.lastRunSessionId)
            && !(item.task.status.runs ?? []).some((run) => run.sessionId === item.task.status?.lastRunSessionId && (run.finishedAt || run.durationMs !== undefined)))
      }] : []),
    executions: executions.map((execution) => ({ key: executionKey(execution), projectId: execution.projectId,
      title: execution.jobTitle, state: execution.state, needsAttention: executionNeedsAttention(execution) }))
  };
}
