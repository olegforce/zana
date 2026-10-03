// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { clampCamera, useCityCamera } from './use-camera.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function Harness({ onClick = vi.fn() }) {
  const { camera, dragging, handlers, zoomBy, fit } = useCityCamera();
  return <><div data-testid="map" tabIndex={0} {...handlers} onClick={onClick}><span data-testid="surface"/><button>Building</button></div><output>{JSON.stringify({ ...camera, dragging })}</output><button onClick={() => zoomBy(2)}>Zoom</button><button onClick={fit}>Fit</button></>;
}
const state = () => JSON.parse(screen.getByRole('status').textContent!);
describe('City camera', () => {
  it('bounds zoom and panning and supports keyboard navigation without stealing button keys', () => {
    expect(clampCamera({ zoom: .1, x: 40, y: -50 })).toEqual({ zoom: 1, x: 0, y: -0 });
    expect(clampCamera({ zoom: 10, x: 999, y: -999 })).toEqual({ zoom: 4, x: 150, y: -150 });
    render(<Harness/>); const map = screen.getByTestId('map');
    fireEvent.keyDown(map, { key: '+' }); expect(state().zoom).toBe(1.25);
    fireEvent.keyDown(map, { key: 'ArrowRight' }); expect(state().x).toBe(-8);
    fireEvent.keyDown(map, { key: 'ArrowLeft' }); expect(state().x).toBe(0);
    fireEvent.keyDown(map, { key: 'ArrowDown' }); expect(state().y).toBe(-8);
    fireEvent.keyDown(map, { key: 'ArrowUp' }); expect(state().y).toBe(0);
    fireEvent.keyDown(map, { key: '-' }); expect(state().zoom).toBe(1);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Building' }), { key: '+' }); expect(state().zoom).toBe(1);
    fireEvent.keyDown(map, { key: 'Enter' }); expect(state().zoom).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom' }));
    fireEvent.keyDown(map, { key: 'Home' }); expect(state().zoom).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Fit' })); expect(state().x).toBe(0);
  });
  it('pans only after a drag threshold, suppresses its click, releases capture state and leaves normal clicks alone', () => {
    vi.stubGlobal('PointerEvent', class extends MouseEvent { pointerId: number; constructor(type: string, init: PointerEventInit) { super(type, init); this.pointerId = init.pointerId ?? 1; } });
    const clicked = vi.fn(); render(<Harness onClick={clicked}/>);
    const map = screen.getByTestId('map'), surface = screen.getByTestId('surface');
    map.setPointerCapture = vi.fn(); surface.setPointerCapture = vi.fn();
    const bounds = vi.spyOn(map, 'getBoundingClientRect').mockReturnValue({ width: 1000, height: 500 } as DOMRect);
    const down = (target: HTMLElement = surface, button = 0) => fireEvent.pointerDown(target, { button, pointerId: 1, clientX: 100, clientY: 100 });
    down(); expect(state().dragging).toBe(false); // fit view does not pan
    fireEvent.click(screen.getByRole('button', { name: 'Zoom' }));
    down(surface, 2); expect(state().dragging).toBe(false);
    down(screen.getByRole('button', { name: 'Building' })); expect(state().dragging).toBe(false);
    bounds.mockReturnValueOnce({ width: 0, height: 0 } as DOMRect); down(); expect(state().dragging).toBe(false);
    down(); expect(state().dragging).toBe(true);
    fireEvent.pointerMove(map, { pointerId: 2, clientX: 200, clientY: 150 }); expect(state().x).toBe(0);
    fireEvent.pointerMove(map, { pointerId: 1, clientX: 102, clientY: 101 }); expect(state().x).toBe(0);
    fireEvent.pointerMove(map, { pointerId: 1, clientX: 200, clientY: 150 }); expect(state()).toMatchObject({ x: 10, y: 10 });
    fireEvent.pointerUp(map); expect(state().dragging).toBe(false);
    fireEvent.click(surface, { detail: 1 }); expect(clicked).not.toHaveBeenCalled();
    fireEvent.click(surface, { detail: 1 }); expect(clicked).toHaveBeenCalledOnce();
    down(); fireEvent.pointerCancel(map); expect(state().dragging).toBe(false);
    down(); fireEvent.lostPointerCapture(map); expect(state().dragging).toBe(false);
    fireEvent.pointerMove(map, { pointerId: 1, clientX: 400, clientY: 400 }); expect(state().x).toBe(10);
  });
});
