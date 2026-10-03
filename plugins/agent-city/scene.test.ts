// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCityRenderer } from './scene.js';
import { cityBuildings, cityLayout, projectPoint, buildingHeight, projectCity } from './model.js';
afterEach(() => vi.restoreAllMocks());
describe('City renderer', () => {
  it('renders all building sizes, real citizens and traffic and resolves a building hit', () => {
    const fill = vi.fn();
    const context = new Proxy({ fill, createRadialGradient: () => ({ addColorStop: vi.fn() }) }, { get: (obj, key) => key in obj ? obj[key as keyof typeof obj] : vi.fn(), set: () => true });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ backgroundColor: 'rgb(100, 150, 180)' } as CSSStyleDeclaration);
    const canvas = document.createElement('canvas'), root = document.createElement('section'); root.appendChild(canvas);
    const renderer = createCityRenderer(canvas, root)!;
    const projects = [0,1,2].map((i) => ({ id: `p${i}`, name: `Project ${i}` }));
    for (const n of [1, 3, 7, 18, 40]) {
      const members = projects.flatMap((p) => Array.from({ length: n }, (_, i) => ({ key: `${p.id}-${i}`, kind: 'agent' as const, title: String(i), projectId: p.id, status: (['working','idle','needs-you','done','error'] as const)[i%5], live: i%5<3, scheduled: false, detail: '' })));
      const buildings = cityBuildings(projectCity({ projects, members, schedules: [], executions: [], searchQuery: '' }), new Map());
      renderer.draw(buildings, 'p0', 0, true); renderer.draw(buildings, 'p1', 20, false);
    }
    expect(fill).toHaveBeenCalled();
    const buildings = cityBuildings(projectCity({ projects, members: [], schedules: [], executions: [], searchQuery: '' }), new Map());
    renderer.draw(buildings, '', 0, false);
    const layout = cityLayout(buildings), p = buildings[0], [x, y] = projectPoint(p.u + p.w / 2, p.v + p.d / 2, buildingHeight(p.count) + 8);
    expect(renderer.hit(layout.x + x * layout.scale, layout.y + y * layout.scale)).toBe('p0'); expect(renderer.hit(-20, -20)).toBeUndefined();
    expect(root.childElementCount).toBe(1);
    Object.defineProperty(canvas, 'clientWidth', { value: 320 });
    renderer.draw([], '', 1, false); expect(canvas.width).toBe(320);
    renderer.refreshPalette();
    const many = Array.from({ length: 200 }, (_, i) => ({ ...buildings[i % 3], id: `many-${i}`, members: [{ key: `member-${i}`, status: 'working', live: true }] }));
    renderer.draw(many as never, '', 30, true);
  });
  it('degrades to the roster if 2D canvas is unavailable', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(createCityRenderer(document.createElement('canvas'), document.createElement('section'))).toBeNull();
  });
});
