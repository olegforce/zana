import type { TaskRowProps } from "./row.js";
import { Icon } from "../../vendor/shared-ui/components/ui/icon.js";
import { activeWorkLabel, formatDueDate, PRIORITY_LABELS, STATUS_LABELS } from "./lib.js";
import { StatusIcon } from "./icons.js";

export function MobileTaskRow({ task, project, showProject, meta, onOpen, pending }: Pick<TaskRowProps, "task" | "project" | "showProject" | "meta" | "onOpen" | "pending">) {
  const working = (meta?.activeThreads.length ?? 0) > 0;
  return <button type="button" data-task-key={task.key} className="tasks-mobile-row" onClick={onOpen} aria-busy={pending || undefined} aria-label={`Open ${task.key}: ${task.title}`}>
    <span className="tasks-mobile-row-project"><Icon name="Folder" className="size-3.5" />{showProject && project ? <span>{project.name}</span> : null}<span>{task.key}</span></span>
    <span className="tasks-mobile-row-title">{task.title}</span>
    <span className="tasks-mobile-row-meta">
      <span><StatusIcon status={task.status} />{STATUS_LABELS[task.status]}</span>
      {task.priority !== "none" && <span data-priority={task.priority}>{PRIORITY_LABELS[task.priority]}</span>}
      {working && <span className="tasks-working" title={activeWorkLabel(meta!.activeThreads)}><i aria-hidden />Working</span>}
      {task.dueDate && <span><Icon name="Clock" className="size-3.5" />{formatDueDate(task.dueDate)}</span>}
    </span>
  </button>;
}
