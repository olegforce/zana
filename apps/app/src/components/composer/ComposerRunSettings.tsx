import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Laptop, X } from 'lucide-react';
import { useCompactLayout } from '../../hooks/useCompactLayout.js';
import { useDialogFocusTrap } from '../../hooks/useDialogFocusTrap.js';
import { shortHostName } from '../composer-host-status.js';
import type { WorkspacePickerValue } from '../EnvironmentPicker.js';

export function composerRunSummary({ machineName, remote, foreignHost, workspace }: {
  machineName?: string;
  remote: boolean;
  foreignHost: boolean;
  workspace: WorkspacePickerValue['kind'];
}) {
  const location = remote ? 'Remote project' : foreignHost ? 'Project copy'
    : workspace === 'worktree' ? 'New worktree' : workspace === 'reuse' ? 'Existing worktree'
      : workspace === 'personal' ? 'Personal scratch' : 'Local';
  return `${machineName ? shortHostName(machineName) : 'Host unavailable'} · ${location}`;
}

/** Keep the existing controls mounted so closing settings cannot reset a choice. */
export function ComposerRunSettings({ summary, children }: { summary: string; children: ReactNode }) {
  const compact = useCompactLayout();
  const [open, setOpen] = useState(false);
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  // Handle Escape below: a nested, portalled picklist gets first refusal.
  useDialogFocusTrap(dialog, undefined, compact && open);
  useEffect(() => {
    if (!compact) setOpen(false);
    else if (open) close.current?.focus();
  }, [compact, open]);

  if (!compact) return <>{children}</>;
  return (
    <>
      <button
        type="button"
        className="mobile-run-settings-trigger"
        aria-label={`Run settings: ${summary}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => { event.currentTarget.focus(); setOpen(true); }}
      >
        <Laptop size={16} aria-hidden="true" />
        <span>{summary}</span>
        <ChevronRight size={16} aria-hidden="true" />
      </button>
      {createPortal(
        <div
          ref={dialog}
          className="mobile-run-settings"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${id}-title`}
          hidden={!open}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || event.defaultPrevented || !dialog.current?.contains(event.target as Node)) return;
            // Non-searchable picklists can retain focus on their trigger. Their
            // document listener closes the menu after this React handler runs.
            if (dialog.current.querySelector('[aria-haspopup="listbox"][aria-expanded="true"]')) return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }}
        >
          <header>
            <h2 id={`${id}-title`}>Run settings</h2>
            <button ref={close} type="button" aria-label="Close run settings" onClick={() => setOpen(false)}>
              <X size={22} aria-hidden="true" />
            </button>
          </header>
          <div className="mobile-run-settings-body">
            <p>Choose where this agent works.</p>
            {children}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
