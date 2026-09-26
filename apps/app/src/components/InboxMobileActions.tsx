import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal, X } from 'lucide-react';
import { Modal } from './Modal.js';
import './mobile-inbox.css';

export interface InboxMobileAction {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  pressed?: boolean;
  danger?: boolean;
}

/** Labeled, finger-sized actions keep the reading header to a single row. */
export function InboxMobileActions({ actions }: { actions: InboxMobileAction[] }) {
  const [open, setOpen] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) close.current?.focus(); }, [open]);
  return <>
    <button
      type="button"
      className="inbox-mobile-actions-trigger"
      aria-label="Message actions"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={(event) => { event.currentTarget.focus(); setOpen(true); }}
    >
      <MoreHorizontal size={22} aria-hidden="true" />
    </button>
    {open && <Modal
      title="Message actions"
      className="inbox-mobile-actions-sheet"
      onClose={() => setOpen(false)}
      header={<div className="inbox-mobile-actions-header">
        <h2>Message actions</h2>
        <button ref={close} type="button" aria-label="Close message actions" onClick={() => setOpen(false)}><X size={22} aria-hidden="true" /></button>
      </div>}
    >
      <div className="inbox-mobile-actions-list">
        {actions.map((action) => <button
          key={action.label}
          type="button"
          className={action.danger ? 'is-danger' : undefined}
          disabled={action.disabled}
          aria-pressed={action.pressed}
          onClick={() => { setOpen(false); action.onSelect(); }}
        >
          {action.icon}<span>{action.label}</span>
        </button>)}
      </div>
    </Modal>}
  </>;
}
