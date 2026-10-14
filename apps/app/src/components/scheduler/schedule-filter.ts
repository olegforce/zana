import type { Project, ScheduledTask } from '@zana-ai/zcc-domain/product';
import { isOpenProblem } from '@zana-ai/zcc-domain/schedule-health';

const OPEN_PROBLEM_LABEL = 'Open problem';

export type ScheduleFilter = 'all' | 'enabled' | 'paused' | 'attention';

export function scheduleIssue(task: ScheduledTask, projects: ReadonlyMap<string, Project>): string | null {
  if (!projects.has(task.projectId)) return 'Project missing';
  const now = Date.now();
  if (task.status?.runs?.some(run => isOpenProblem(run, now))) return OPEN_PROBLEM_LABEL;
  return null;
}

export function filterSchedules(
  tasks: ScheduledTask[], projects: ReadonlyMap<string, Project>, search: string, filter: ScheduleFilter
): ScheduledTask[] {
  const query = search.trim().toLowerCase();
  return tasks.filter(task => {
    if (filter === 'enabled' && !task.enabled) return false;
    if (filter === 'paused' && task.enabled) return false;
    if (filter === 'attention' && !scheduleIssue(task, projects)) return false;
    return [task.name, task.description ?? '', task.profile, projects.get(task.projectId)?.name ?? 'Project missing']
      .join(' ').toLowerCase().includes(query);
  });
}
