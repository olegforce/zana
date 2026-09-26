import { useId, useState, type ReactNode } from 'react';
import { ChevronDown, FileText } from 'lucide-react';

/** Load a document only when its card is opened; reports remain the main reading surface. */
export function InboxMobileDocument({ path, children }: { path: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const name = path.split(/[\\/]/u).filter(Boolean).pop() || path;
  return <section className="inbox-mobile-document">
    <button
      type="button"
      className="inbox-mobile-document-toggle"
      aria-expanded={open}
      aria-controls={id}
      onClick={() => setOpen((value) => !value)}
      title={path}
    >
      <FileText size={20} aria-hidden="true" />
      <span>{name}</span>
      <ChevronDown size={18} className={open ? 'is-open' : undefined} aria-hidden="true" />
    </button>
    <div id={id} hidden={!open} className="inbox-mobile-document-body">{open ? children : null}</div>
  </section>;
}
