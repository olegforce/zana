import { useRef, useState, type PointerEvent, type KeyboardEvent, type MouseEvent } from 'react';

export type Camera = { zoom: number; x: number; y: number };
export const FIT_CAMERA: Camera = { zoom: 1, x: 0, y: 0 };
export function clampCamera(camera: Camera): Camera {
  const zoom = Math.max(1, Math.min(4, camera.zoom)), limit = (zoom - 1) * 50;
  return { zoom, x: Math.max(-limit, Math.min(limit, camera.x)), y: Math.max(-limit, Math.min(limit, camera.y)) };
}
/** Percent coordinates keep the camera usable when the inspector or viewport resizes. */
export function useCityCamera() {
  const [camera, setCamera] = useState(FIT_CAMERA), [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; camera: Camera } | null>(null);
  const moved = useRef(false);
  const zoomBy = (factor: number) => setCamera((c) => clampCamera({ ...c, zoom: c.zoom * factor }));
  const fit = () => setCamera(FIT_CAMERA);
  return { camera, dragging, zoomBy, fit,
    handlers: {
      onPointerDown(event: PointerEvent<HTMLDivElement>) {
        if (event.button !== 0 || camera.zoom === 1 || (event.target as HTMLElement).closest('button')) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return;
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, camera };
        moved.current = false;
        (event.target as HTMLElement).setPointerCapture(event.pointerId);
        event.currentTarget.focus({ preventScroll: true });
        setDragging(true);
      },
      onPointerMove(event: PointerEvent<HTMLDivElement>) {
        const start = drag.current;
        if (!start || start.id !== event.pointerId) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        const dx = event.clientX - start.x, dy = event.clientY - start.y;
        if (!bounds.width || !bounds.height || (!moved.current && Math.hypot(dx, dy) < 5)) return;
        moved.current = true;
        setCamera(clampCamera({ ...start.camera, x: start.camera.x + dx / bounds.width * 100, y: start.camera.y + dy / bounds.height * 100 }));
      },
      onPointerUp() { drag.current = null; setDragging(false); },
      onPointerCancel() { drag.current = null; moved.current = false; setDragging(false); },
      onLostPointerCapture() { drag.current = null; setDragging(false); },
      onClickCapture(event: MouseEvent<HTMLDivElement>) {
        if (moved.current && event.detail !== 0) { event.preventDefault(); event.stopPropagation(); moved.current = false; }
      },
      onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        if (event.target !== event.currentTarget) return;
        if (event.key === '+' || event.key === '=') zoomBy(1.25);
        else if (event.key === '-') zoomBy(.8);
        else if (event.key === '0' || event.key === 'Home') fit();
        else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
          const key = event.key;
          setCamera((c) => clampCamera({ ...c, x: c.x + (key === 'ArrowLeft' ? 8 : key === 'ArrowRight' ? -8 : 0), y: c.y + (key === 'ArrowUp' ? 8 : key === 'ArrowDown' ? -8 : 0) }));
        } else return;
        event.preventDefault();
      }
    }
  };
}
