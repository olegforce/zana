import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

/** Measure the rendered content so attachments and wrapped text share one height budget. */
export function MobileMessagePreview({ enabled, expanded, onExpandedChange, children }: {
  enabled: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  children: ReactNode;
}) {
  const id = useId();
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const previousExpanded = useRef(expanded);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    // A pinned prompt may be far above the actual scroll position. When it
    // leaves sticky flow, keep the message the user just tapped in view.
    if (enabled && previousExpanded.current !== expanded) {
      viewportRef.current?.scrollIntoView({ block: 'start', inline: 'nearest' });
    }
    previousExpanded.current = expanded;
  }, [enabled, expanded]);

  useLayoutEffect(() => {
    if (!enabled || expanded) return;
    const viewport = viewportRef.current!;
    const content = contentRef.current!;
    const measure = () => setOverflowing(content.scrollHeight > viewport.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, [enabled, expanded]);

  if (!enabled) return children;
  return (
    <div className="mobile-message-preview" data-expanded={expanded} data-overflowing={overflowing}>
      <div
        id={id}
        ref={viewportRef}
        className="mobile-message-preview-viewport"
        onFocusCapture={(event) => {
          // A keyboard user can tab to a link below the clipped preview.
          if (!expanded && event.target.getBoundingClientRect().bottom > event.currentTarget.getBoundingClientRect().bottom) {
            onExpandedChange(true);
          }
        }}
      >
        <div ref={contentRef} className="mobile-message-preview-content">{children}</div>
      </div>
      {overflowing || expanded ? (
        <button
          type="button"
          className="mobile-message-preview-toggle"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => onExpandedChange(!expanded)}
        >
          {expanded ? 'Show less' : 'Show more'}
          {expanded ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
        </button>
      ) : null}
    </div>
  );
}
