import { useEffect, useState } from "react";
import type { PluginNavPanelProps } from "../compat/app";
import { CompactViewportOverrideProvider } from "../vendor/shared-ui/components/ui/hooks/use-compact-viewport.js";
import { TasksAppShell } from "./app-shell.js";
import { TasksNavigationPanel } from "./navigation-panel.js";
import { MobileProjectsContext, TasksMobileSheet, useIsMobileTasks } from "./mobile.js";

export function TasksPanel(props: PluginNavPanelProps) {
  const compact = useIsMobileTasks();
  const [projectsOpen, setProjectsOpen] = useState(false);
  useEffect(() => { setProjectsOpen(false); }, [compact, props.subPath]);
  return <CompactViewportOverrideProvider isCompactViewport={compact}>
    <MobileProjectsContext.Provider value={compact ? () => setProjectsOpen(true) : null}>
      <div className="bb-tasks tasks-panel" data-compact={compact}>
        {!compact && <aside className="tasks-desktop-navigation"><TasksNavigationPanel {...props} /></aside>}
        <main className="tasks-panel-main"><TasksAppShell {...props} /></main>
        {compact && <TasksMobileSheet title="Projects" open={projectsOpen} onClose={() => setProjectsOpen(false)}>
          <TasksNavigationPanel {...props} searchable onNavigate={() => setProjectsOpen(false)} />
        </TasksMobileSheet>}
      </div>
    </MobileProjectsContext.Provider>
  </CompactViewportOverrideProvider>;
}
