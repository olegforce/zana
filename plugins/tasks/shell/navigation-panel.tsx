import type { PluginNavPanelProps } from "../compat/app";
import {
  useActiveTasks,
  useFolders,
  usePresets,
  useProjects,
  useSidebarSummary,
} from "./data.js";
import { TasksRefreshProvider } from "./refresh.js";
import { parseTasksRoute, useTasksNavigation } from "./routes.js";
import { TasksSidebar } from "./sidebar.js";
import { NewProjectDialog } from "../views/manage/new-project-dialog.js";
import { useState } from "react";

function isAwaitingFirstResult(query: {
  data: unknown;
  error: string | null;
}): boolean {
  return query.data === undefined && query.error === null;
}

type NavigationPanelProps = PluginNavPanelProps & { onNavigate?: () => void; searchable?: boolean };

function TasksNavigationPanelContent({ subPath, onNavigate, searchable = false }: NavigationPanelProps) {
  const [query, setQuery] = useState("");
  const route = parseTasksRoute(subPath);
  const navigation = useTasksNavigation();
  const folders = useFolders();
  const projects = useProjects();
  const summaries = useSidebarSummary();
  const presets = usePresets();
  const activeTasks = useActiveTasks();
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const search = query.trim().toLowerCase();
  const visibleProjects = search
    ? projects.data?.filter(project => `${project.name} ${project.prefix}`.toLowerCase().includes(search))
    : projects.data;

  return (
    <div className="tasks-navigation-content">
      {searchable && <label className="tasks-project-search"><input type="search" placeholder="Search projects…" aria-label="Search task projects" value={query} onChange={event => setQuery(event.target.value)} /></label>}
      {search && visibleProjects?.length === 0 && <p className="px-4 text-sm text-muted-foreground" role="status">No projects match your search.</p>}
      <TasksSidebar
        route={route}
        folders={search ? [] : folders.data}
        projects={visibleProjects}
        summaries={summaries.data}
        presets={search ? undefined : presets.data}
        activeTasks={activeTasks.data}
        isLoading={
          isAwaitingFirstResult(folders) ||
          isAwaitingFirstResult(projects) ||
          isAwaitingFirstResult(summaries)
        }
        onNavigate={(route) => { onNavigate?.(); navigation.go(route); }}
        onNewProject={() => setNewProjectOpen(true)}
      />
      {newProjectOpen ? (
        <NewProjectDialog open onOpenChange={setNewProjectOpen} />
      ) : null}
    </div>
  );
}

export function TasksNavigationPanel(props: NavigationPanelProps) {
  return (
    <TasksRefreshProvider>
      <TasksNavigationPanelContent {...props} />
    </TasksRefreshProvider>
  );
}
