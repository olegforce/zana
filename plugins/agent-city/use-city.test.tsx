// @vitest-environment jsdom
import { useRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
const renderer = vi.hoisted(() => ({ draw: vi.fn(), refreshPalette: vi.fn(), hit: vi.fn(() => 'p0') }));
vi.mock('./scene.js', () => ({ createCityRenderer: vi.fn(() => renderer) }));
import { useCityCanvas } from './use-city.js';
import { createCityRenderer } from './scene.js';
let motionChange: () => void, intersect: (entries: { isIntersecting: boolean }[]) => void, resize: () => void, mutate: () => void;
let frame: FrameRequestCallback;
const disconnect = vi.fn();
const media = { matches: false, addEventListener: vi.fn((_key: string, cb: () => void) => { motionChange = cb; }), removeEventListener: vi.fn() };
function setup() {
  vi.stubGlobal('matchMedia', () => media);
  vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => { frame = cb; return 1; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { resize = cb; } observe() {} disconnect = disconnect; });
  vi.stubGlobal('IntersectionObserver', class { constructor(cb: typeof intersect) { intersect = cb; } observe() {} disconnect = disconnect; });
  vi.stubGlobal('MutationObserver', class { constructor(cb: () => void) { mutate = cb; } observe() {} disconnect = disconnect; });
}
function Harness({ paused = false, onSelect = vi.fn() }) {
  const root = useRef<HTMLElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const state = useCityCanvas(root, canvas, [], 'p0', paused, onSelect);
  return <section ref={root}><canvas ref={canvas} data-testid="canvas"/><span>{state.reduced ? 'reduced' : 'motion'}</span><span>{state.available ? 'available' : 'unavailable'}</span></section>;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); media.matches = false; });
it('pauses offscreen and hidden animation, respects reduced motion, responds to updates and cleans everything on unmount', () => {
  setup(); const select = vi.fn(); const { rerender, unmount } = render(<Harness onSelect={select}/>);
  act(() => { frame(100); frame(120); frame(170); });
  expect(renderer.draw).toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('canvas')); expect(select).toHaveBeenCalledWith('p0');
  act(() => intersect([{ isIntersecting: false }])); renderer.draw.mockClear();
  act(() => frame(200)); expect(renderer.draw).not.toHaveBeenCalled();
  act(() => intersect([{ isIntersecting: true }]));
  act(() => { media.matches = true; motionChange(); }); expect(screen.getByText('reduced')).toBeTruthy();
  act(() => { media.matches = false; motionChange(); resize(); mutate(); }); expect(renderer.refreshPalette).toHaveBeenCalled();
  rerender(<Harness paused onSelect={select}/>); renderer.draw.mockClear(); act(() => frame(250)); expect(renderer.draw).not.toHaveBeenCalled();
  Object.defineProperty(document, 'hidden', { configurable: true, value: true }); act(() => document.dispatchEvent(new Event('visibilitychange')));
  Object.defineProperty(document, 'hidden', { configurable: true, value: false }); act(() => document.dispatchEvent(new Event('visibilitychange')));
  unmount(); expect(disconnect).toHaveBeenCalledTimes(3); expect(media.removeEventListener).toHaveBeenCalled(); expect(cancelAnimationFrame).toHaveBeenCalled();
  renderer.draw.mockClear(); act(() => { frame(300); resize(); }); expect(renderer.draw).not.toHaveBeenCalled();
});
it('reports unavailable canvas without creating observers or animation', () => {
  setup(); vi.mocked(createCityRenderer).mockReturnValueOnce(null); render(<Harness/>);
  expect(screen.getByText('unavailable')).toBeTruthy(); expect(requestAnimationFrame).not.toHaveBeenCalled();
});
it('maps clicks through the zoomed canvas bounds and publishes viewport resizing', () => {
  setup(); const select = vi.fn(); render(<Harness onSelect={select}/>);
  const canvas = screen.getByTestId('canvas');
  Object.defineProperty(canvas, 'clientWidth', { configurable: true, value: 500 });
  Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: 300 });
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 50, width: 1000, height: 600 } as DOMRect);
  act(() => resize());
  fireEvent.click(canvas, { clientX: 600, clientY: 350 });
  expect(renderer.hit).toHaveBeenLastCalledWith(250, 150);
  expect(select).toHaveBeenCalledWith('p0');
  renderer.hit.mockReturnValueOnce(undefined as never);
  select.mockClear(); fireEvent.click(canvas); expect(select).not.toHaveBeenCalled();
});
