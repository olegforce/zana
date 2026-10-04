import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Settings2 } from 'lucide-react';
import type { Project } from '@zana-ai/zcc-domain/product';
import { useUi } from '../../store.js';
import { composerProjectLabel } from '../composer-project-default.js';
import { ProjectOpenActions } from './ProjectOpenActions.js';

export function FocusedProjectMenu({ project, x, y, onClose }: {
  project: Project; x: number; y: number; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const openProjectSettings = useUi((s) => s.openProjectSettings);
  useLayoutEffect(() => {
    const el = ref.current!;
    const previous = document.activeElement;
    const rect = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    el.querySelector('button')?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [x, y]);
  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    };
    window.addEventListener('mousedown', dismiss);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('mousedown', dismiss);
      window.removeEventListener('keydown', escape);
    };
  }, [onClose]);

  return createPortal(
    <div ref={ref} className="project-menu" role="group" aria-label={`Project actions for ${composerProjectLabel(project)}`}
      style={{ left: x, top: y }} onClick={(event) => event.stopPropagation()}>
      <ProjectOpenActions project={project} onClose={onClose} />
      <div className="project-menu-sep" />
      <button type="button" className="project-menu-item" onClick={() => {
        onClose();
        openProjectSettings(project.id);
      }}>
        <Settings2 size={12} /><span>Project settings…</span>
      </button>
    </div>, document.body
  );
}
