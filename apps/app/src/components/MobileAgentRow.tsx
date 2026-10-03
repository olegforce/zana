import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Link } from 'react-router-dom';
import { Folder, MessageSquare, X } from 'lucide-react';
import { errorMessage, pushErrorToast } from '../store';
import type { MobileAgentItem } from './mobile-agent-items';

const ACTION_WIDTH = 88;
const REVEAL_DISTANCE = 44;
const CLOSE_DISTANCE = 144;

export function MobileAgentRow({ item, active, onOpen, onClose }: {
  item: MobileAgentItem;
  active: boolean;
  onOpen: () => void;
  onClose: () => Promise<void>;
}) {
  const rowRef = useRef<HTMLLIElement>(null);
  const gesture = useRef<{ id: number; x: number; y: number; offset: number; horizontal: boolean } | null>(null);
  const suppressClick = useRef(false);
  const closing = useRef(false);
  const [distance, setDistance] = useState(0);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [dragging, setDragging] = useState(false);

  function reset() {
    setDistance(0);
    setRevealed(false);
  }

  useEffect(() => {
    if (!revealed) return;
    const dismiss = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !rowRef.current?.contains(event.target)) reset();
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [revealed]);

  async function close() {
    if (closing.current) return;
    reset();
    closing.current = true;
    setBusy(true);
    try {
      await onClose();
    } catch (error) {
      pushErrorToast(errorMessage(error, 'Could not close the agent'));
    } finally {
      closing.current = false;
      setBusy(false);
    }
  }

  function move(event: PointerEvent<HTMLAnchorElement>) {
    const start = gesture.current;
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!start.horizontal) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return;
      // Lock only a deliberate horizontal drag. A revealed row can swipe back.
      if (Math.abs(dx) <= Math.abs(dy) * 1.5 || (start.offset === 0 && dx > 0)) {
        gesture.current = null;
        return;
      }
      start.horizontal = true;
      setDragging(true);
      suppressClick.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    setDistance(Math.min(220, Math.max(0, start.offset - dx)));
  }

  function finish(event: PointerEvent<HTMLAnchorElement>, cancelled: boolean) {
    const start = gesture.current;
    if (!start || start.id !== event.pointerId) return;
    gesture.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!start.horizontal) return;
    const next = cancelled ? start.offset : Math.max(0, start.offset + start.x - event.clientX);
    if (!cancelled && next >= CLOSE_DISTANCE) {
      void close();
    } else {
      const open = next >= REVEAL_DISTANCE;
      setDistance(open ? ACTION_WIDTH : 0);
      setRevealed(open);
    }
  }

  return (
    <li ref={rowRef} className="mobile-agent-swipe" aria-busy={busy} data-swiping={dragging} data-revealed={revealed}
      data-ready={distance >= CLOSE_DISTANCE} onKeyDown={(event) => {
        if (event.key === 'Escape' && revealed) {
          event.preventDefault();
          event.stopPropagation();
          reset();
          rowRef.current?.querySelector('a')?.focus({ preventScroll: true });
        }
      }}>
      <div className="mobile-agent-swipe-action">
        <button type="button" disabled={busy || !revealed} tabIndex={revealed ? 0 : -1}
          aria-hidden={!revealed} aria-label={`Close ${item.title}`}
          onClick={() => void close()}>
          <X size={20} aria-hidden="true" />
          <span>{distance >= CLOSE_DISTANCE ? 'Release to close' : 'Close'}</span>
        </button>
      </div>
      <div className="mobile-agent-row-surface" style={{ transform: `translateX(${-distance}px)` }}>
        <Link to={item.to} className="mobile-agent-row" draggable={false}
          aria-current={active ? 'page' : undefined}
          onPointerDown={(event) => {
            if (closing.current || !event.isPrimary || event.button !== 0) return;
            suppressClick.current = false;
            gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, offset: distance, horizontal: false };
          }}
          onPointerMove={move}
          onPointerUp={(event) => finish(event, false)}
          onPointerCancel={(event) => finish(event, true)}
          onLostPointerCapture={(event) => {
            // Touch starts with implicit capture on the tapped icon/text. Its
            // bubbled loss when we capture the link is a transfer, not a cancel.
            if (event.target === event.currentTarget) finish(event, true);
          }}
          onClick={(event) => {
            if (suppressClick.current || closing.current) {
              event.preventDefault();
              suppressClick.current = false;
              return;
            }
            if (revealed) {
              event.preventDefault();
              reset();
              return;
            }
            onOpen();
          }}>
          <MessageSquare size={19} aria-hidden="true" />
          <span className="mobile-agent-row-copy">
            <span className="mobile-agent-row-title">{item.title}</span>
            <span className="mobile-agent-row-detail">
              <span className="mobile-agent-project" title={item.projectName}>
                <Folder size={12} aria-hidden="true" /><span>{item.projectName}</span>
              </span>
              <span className="mobile-agent-status" data-status={item.status}>{item.status}</span>
            </span>
          </span>
        </Link>
        <button className="mobile-agent-close" type="button" disabled={busy}
          aria-label={`Close ${item.title}`} title="Close agent (or swipe left)" onClick={() => void close()}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}
