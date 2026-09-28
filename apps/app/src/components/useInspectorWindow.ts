import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { product } from '../lib/product-client.js';
import { suppressPostDragClick } from '../lib/suppress-post-drag-click.js';
import {
  clearInspectorSize,
  cursorForInspectorEdge,
  currentInspectorFrame,
  focusInspectorDialog,
  inspectorFrameFromKey,
  inspectorFrameFromPointer,
  inspectorFrameFromRect,
  inspectorFrameStyle,
  inspectorModalClassName,
  inspectorViewport,
  releaseInspectorFullScreen,
  rememberInspectorSize,
  toggleInspectorFullScreen,
  type InspectorFrame,
  type InspectorResizeEdge
} from './inspector-window.js';

function sameFrame(a: InspectorFrame | null, b: InspectorFrame | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

export function useInspectorWindow() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [fullScreen, setFullScreen] = useState(false);
  const [frame, setFrame] = useState<InspectorFrame | null>(() => currentInspectorFrame(inspectorViewport()));
  const [resizing, setResizing] = useState(false);
  const fullScreenRef = useRef(false);
  fullScreenRef.current = fullScreen;
  const drag = useRef<{
    pointerId: number;
    edge: InspectorResizeEdge;
    originX: number;
    originY: number;
    start: InspectorFrame;
    previousCursor: string;
    previousUserSelect: string;
  } | null>(null);

  useEffect(() => product.app.onFullScreenChanged(setFullScreen), []);
  useEffect(() => () => releaseInspectorFullScreen(fullScreenRef.current), []);
  // Mount-only focus. Do not depend on per-render values — a 1s tick or status
  // poll would yank focus off the live xterm the user is typing into.
  useEffect(() => {
    focusInspectorDialog(ref.current);
  }, []);
  useEffect(() => {
    const onWindowResize = () => {
      // A drag owns the size until pointerup. App-window changes scale the
      // size the user chose; an unchanged viewport leaves it alone.
      if (drag.current) return;
      const next = currentInspectorFrame(inspectorViewport());
      // A missing stored size must not wipe a live frame (opening another
      // overlay can fire `resize` before hydrate). Reset stays explicit.
      if (!next) return;
      setFrame((current) => (sameFrame(current, next) ? current : next));
    };
    window.addEventListener('resize', onWindowResize);
    return () => window.removeEventListener('resize', onWindowResize);
  }, []);

  const commitFrame = (next: InspectorFrame) => {
    rememberInspectorSize(next, inspectorViewport());
    setFrame(next);
  };

  const measure = (): InspectorFrame | null => {
    const node = ref.current;
    if (!node) return null;
    return inspectorFrameFromRect(node.getBoundingClientRect());
  };

  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    const session = drag.current;
    if (!session || session.pointerId !== event.pointerId) return;
    drag.current = null;
    setResizing(false);
    document.body.style.cursor = session.previousCursor;
    document.body.style.userSelect = session.previousUserSelect;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    suppressPostDragClick();
    const next = currentInspectorFrame(inspectorViewport());
    if (!next) return;
    setFrame((current) => (sameFrame(current, next) ? current : next));
  };

  return {
    ref,
    fullScreen,
    resizing,
    className: inspectorModalClassName(fullScreen, resizing),
    style: inspectorFrameStyle(frame, fullScreen),
    toggleFullScreen: () => toggleInspectorFullScreen(fullScreen, setFullScreen),
    beginResize: (edge: InspectorResizeEdge, event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || fullScreen || drag.current) return;
      const start = measure();
      if (!start) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = {
        pointerId: event.pointerId,
        edge,
        originX: event.clientX,
        originY: event.clientY,
        start,
        previousCursor: document.body.style.cursor,
        previousUserSelect: document.body.style.userSelect
      };
      document.body.style.cursor = cursorForInspectorEdge(edge);
      document.body.style.userSelect = 'none';
      setResizing(true);
      commitFrame(inspectorFrameFromPointer({
        start,
        originX: event.clientX,
        originY: event.clientY,
        clientX: event.clientX,
        clientY: event.clientY,
        edge,
        viewport: inspectorViewport()
      }));
    },
    moveResize: (event: PointerEvent<HTMLDivElement>) => {
      const session = drag.current;
      if (!session || session.pointerId !== event.pointerId) return;
      commitFrame(
        inspectorFrameFromPointer({
          start: session.start,
          originX: session.originX,
          originY: session.originY,
          clientX: event.clientX,
          clientY: event.clientY,
          edge: session.edge,
          viewport: inspectorViewport()
        })
      );
    },
    endResize: finishDrag,
    resetFrame: () => {
      drag.current = null;
      setResizing(false);
      clearInspectorSize();
      setFrame(null);
    },
    keyResize: (key: string) => {
      const start = frame ?? measure();
      if (!start) return;
      const next = inspectorFrameFromKey(start, key, inspectorViewport());
      if (next) commitFrame(next);
    }
  };
}
