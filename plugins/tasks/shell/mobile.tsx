import { createContext, useContext, type ReactNode } from "react";
import { useMediaQuery } from "../vendor/shared-ui/components/ui/hooks/use-media-query.js";
import { ResponsiveDrawerShell } from "../vendor/shared-ui/components/ui/responsive-overlay.js";
import { Icon } from "../vendor/shared-ui/components/ui/icon.js";

export const useIsMobileTasks = () => useMediaQuery("(max-width: 1024px)");

export const MobileProjectsContext = createContext<(() => void) | null>(null);
export const useOpenTaskProjects = () => useContext(MobileProjectsContext);

export function TasksMobileSheet({ title, open, onClose, children, footer }: {
  title: string; open: boolean; onClose: () => void; children: ReactNode; footer?: ReactNode;
}) {
  return <ResponsiveDrawerShell open={open} onOpenChange={(next) => { if (!next) onClose(); }}
    srLabel={title} contentClassName="tasks-mobile-sheet">
    <header className="tasks-mobile-sheet-header">
      <strong>{title}</strong>
      <button type="button" aria-label={`Close ${title.toLowerCase()}`} onClick={onClose}><Icon name="X" className="size-5" /></button>
    </header>
    <div className="tasks-mobile-sheet-body">{children}</div>
    {footer && <footer className="tasks-mobile-sheet-footer">{footer}</footer>}
  </ResponsiveDrawerShell>;
}
