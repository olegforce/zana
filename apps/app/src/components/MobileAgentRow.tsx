import { useRef, useState, type PointerEvent } from 'react';
import { Link } from 'react-router-dom';
import { Folder, MessageSquare, X } from 'lucide-react';
import { errorMessage, pushErrorToast } from '../store';
import type { MobileAgentItem } from './mobile-agent-items';

const CLOSE_DISTANCE = 96;

export function MobileAgentRow({ item, active, onOpen, onClose }: {
  item: MobileAgentItem;
  active: boolean;
  onOpen: () => void;
  onClose: () => Promise<void>;
}) {
  const gesture = useRef<{ id: number; x: number; y: number; horizontal: boolean } | null>(null);
  const suppressClick = useRef(false);
  const closing = useRef(false);
  const [distance, setDistance] = useState(0);
  const [busy, setBusy] = useState(false);

  async function close() {
    if (closing.current) return;
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
      // Give vertical scrolling and leftward gestures back to the browser.
      if (dx <= Math.abs(dy) * 1.5) {
        gesture.current = null;
        return;
      }
      start.horizontal = true;
      suppressClick.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    setDistance(Math.min(180, Math.max(0, dx)));
  }

  function finish(event: PointerEvent<HTMLAnchorElement>, cancelled: boolean) {
    const start = gesture.current;
    if (!start || start.id !== event.pointerId) return;
    gesture.current = null;
    setDistance(0);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!cancelled && start.horizontal && event.clientX - start.x >= CLOSE_DISTANCE) void close();
  }

  return (
    <li className="mobile-agent-swipe" aria-busy={busy} data-swiping={distance > 0}
      data-ready={distance >= CLOSE_DISTANCE}>
      <div className="mobile-agent-swipe-action" aria-hidden="true">
        <X size={20} /> <span>{distance >= CLOSE_DISTANCE ? 'Release to close' : 'Close'}</span>
      </div>
      <div className="mobile-agent-row-surface" style={{ transform: `translateX(${distance}px)` }}>
        <Link to={item.to} className="mobile-agent-row" draggable={false}
          aria-current={active ? 'page' : undefined}
          onPointerDown={(event) => {
            if (closing.current || !event.isPrimary || event.button !== 0) return;
            suppressClick.current = false;
            gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, horizontal: false };
          }}
          onPointerMove={move}
          onPointerUp={(event) => finish(event, false)}
          onPointerCancel={(event) => finish(event, true)}
          onLostPointerCapture={(event) => finish(event, true)}
          onClick={(event) => {
            if (suppressClick.current || closing.current) {
              event.preventDefault();
              suppressClick.current = false;
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
          aria-label={`Close ${item.title}`} title="Close agent (or swipe right)" onClick={() => void close()}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}
