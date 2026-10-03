import { useRef } from "react";
import { useTaskPages, useTasksQuery } from "../../shell/data.js";
import { useTasksRefresh } from "../../shell/refresh.js";
import type { TaskSort } from "../../shared/pagination.js";
import type {
  Label,
  Task,
  TaskPriority,
  TaskStatus,
  TaskSummary,
} from "../../shared/contract.js";

interface ListTaskFilters {
  statuses: readonly TaskStatus[];
  priorities: readonly TaskPriority[];
  labelIds: readonly string[] | null;
}

export function useListTasks(
  projectId: string | null,
  activeOnly: boolean,
  filters: ListTaskFilters,
  sort: TaskSort = "manual",
  search = "",
) {
  return useTaskPages(
      {
        ...(projectId === null ? {} : { projectId }),
        ...(filters.statuses.length > 0
          ? { statuses: [...filters.statuses] }
          : {}),
        ...(filters.priorities.length > 0
          ? { priorities: [...filters.priorities] }
          : {}),
        ...(filters.labelIds !== null
          ? { labelIds: [...filters.labelIds] }
          : {}),
        activeOnly,
        parentTaskId: null,
        sort,
        ...(search.trim() ? { search: search.trim() } : {}),
      },
    [
      projectId,
      activeOnly,
      filters.statuses.join(),
      filters.priorities.join(),
      filters.labelIds === null ? "" : `active:${filters.labelIds.join()}`,
      sort, search,
    ],
    activeOnly ? ["tasks:changed", "threads:changed"] : ["tasks:changed"],
  );
}

export function useLabels(projectIds: readonly string[]) {
  return useTasksQuery<Label[]>(
    async (rpc) => {
      const results = await Promise.all(
        projectIds.map((projectId) => rpc.call("listLabels", { projectId })),
      );
      return results.flatMap((result) => result.labels);
    },
    ["projects:changed"],
    [projectIds.join()],
  );
}

export interface TaskRowMeta {
  activeThreads: TaskSummary["activeThreads"];
  activeThreadCount?: number;
  attachmentCount?: number;
  subDone?: number;
  subTotal?: number;
}

export function useTaskListMeta(tasks: readonly Task[] | undefined) {
  const taskIds = (tasks ?? []).map((task) => task.id);
  const cache = useRef(new Map<string, TaskRowMeta>());
  const dirty = useRef<Set<string> | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const { generation } = useTasksRefresh();
  const cachedGeneration = useRef(generation);
  if (cachedGeneration.current !== generation) {
    cachedGeneration.current = generation;
    dirty.current = null;
  }
  return useTasksQuery<Map<string, TaskRowMeta>>(
    rpc => {
      const run = queue.current.then(async () => {
        const wanted = taskIds.filter(id =>
          dirty.current === null || dirty.current.has(id) || !cache.current.has(id),
        );
        dirty.current = new Set();
        try {
          for (let offset = 0; offset < wanted.length; offset += 100) {
            const { summaries } = await rpc.call("listTaskSummaries", {
              taskIds: wanted.slice(offset, offset + 100),
            });
            for (const summary of summaries) cache.current.set(summary.taskId, summary);
          }
        } catch (error) {
          dirty.current = null;
          throw error;
        }
        cache.current = new Map(taskIds.flatMap(id => {
          const value = cache.current.get(id);
          return value ? [[id, value] as const] : [];
        }));
        return new Map(cache.current);
      });
      queue.current = run.then(() => undefined, () => undefined);
      return run;
    },
    ["threads:changed", "tasks:changed"],
    [taskIds.join()],
    { invalidationFilter: (channel, payload) => {
      // A child-task mutation can change a visible parent's subtask counts.
      if (channel === "tasks:changed") {
        dirty.current = null;
        return true;
      }
      const id = payload && typeof payload === 'object' && 'taskId' in payload ? String(payload.taskId) : null;
      if (id === null) {
        dirty.current = null;
        return true;
      }
      if (!taskIds.includes(id)) return false;
      dirty.current?.add(id);
      return true;
    } },
  );
}
