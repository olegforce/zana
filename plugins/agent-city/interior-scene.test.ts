// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { drawInterior } from './interior-scene.js';
import { buildingInterior, interiorLayout, interiorScreen, interiorWorker } from './interior.js';
import { cityBuildings, projectCity } from './model.js';
import { createCityRenderer } from './scene.js';
afterEach(() => vi.restoreAllMocks());
function fixture(n: number) {
  return cityBuildings(projectCity({ projects: [{ id: 'p', name: 'Interior' }], members: Array.from({ length: n }, (_, i) => ({ key: `agent:${i}`, projectId: 'p', kind: 'agent' as const, title: `Agent ${i}`, detail: '', live: true, scheduled: false, harness: 'Codex', status: (['working', 'needs-you', 'idle', 'error'] as const)[i % 4] })), schedules: [{ key: 's', projectId: 'p', title: 'Plan', enabled: false, running: false, nextRunAt: null }], executions: [], searchQuery: '' }), new Map());
}
function context() {
  return new Proxy({ fillText: vi.fn(), fill: vi.fn(), roundRect: vi.fn(), createRadialGradient: () => ({ addColorStop: vi.fn() }) }, { get: (obj, key) => key in obj ? obj[key as keyof typeof obj] : vi.fn(), set: () => true }) as unknown as CanvasRenderingContext2D;
}
it('draws garages, offices, lobby, roof, empty planned rooms and truthful status cues; only real workstations create hit targets', () => {
  const ctx = context();
  for (const n of [0, 1, 4, 5, 25]) for (const moving of [false, true]) {
    const buildings = fixture(n), initial = buildingInterior(buildings[0]);
    for (const floor of initial.levels) {
      const view = buildingInterior(buildings[0], { floor: floor.id });
      for (const entrance of [0, 1]) {
        vi.mocked(ctx.roundRect).mockClear();
        const hits = drawInterior(ctx, view, 600, 500, moving ? 20 : 0, moving, { white: '#ffffff' }, entrance);
        expect(hits.filter((h) => !h.kind).map((h) => h.id).sort()).toEqual(view.workers.map((s) => s.occupant.item.key).sort());
        expect(hits.every((h) => h.w > 0 && h.h > 0)).toBe(true);
        expect(vi.mocked(ctx.roundRect).mock.calls.filter((call) => call[2] === 16 && call[3] === 17)).toHaveLength(view.workers.length);
      }
    }
  }
  expect(ctx.fillText).toHaveBeenCalledWith('!', expect.any(Number), expect.any(Number));
  expect(ctx.fillText).toHaveBeenCalledWith('◷', expect.any(Number), expect.any(Number));
  const quiet = { ...fixture(0)[0], schedules: [] };
  drawInterior(ctx, buildingInterior(quiet), 320, 440, 0, false, {});
  expect(ctx.fillText).toHaveBeenCalledWith('QUIET WORKSHOP', expect.any(Number), expect.any(Number));
});
it('draws one idle agent and keeps its inspection target aligned while lounging, walking and taking coffee', () => {
  const ctx = context(), original = fixture(1)[0];
  const building = { ...original, schedules: [], members: [{ ...original.members[0], status: 'idle' as const }] };
  const model = buildingInterior(building), worker = model.workers[0];
  for (const time of [0, 15, 22, 30]) {
    vi.mocked(ctx.roundRect).mockClear();
    const hits = drawInterior(ctx, model, 600, 500, time, true, {});
    const { point: [u, v], seated } = interiorWorker(worker, time);
    const [x, y] = interiorScreen(u, v, seated ? 69 : 52, interiorLayout(600, 500));
    expect(hits).toHaveLength(1); expect(hits[0].id).toBe(worker.occupant.item.key);
    expect(x).toBeGreaterThanOrEqual(hits[0].x); expect(x).toBeLessThanOrEqual(hits[0].x + hits[0].w);
    expect(y).toBeGreaterThanOrEqual(hits[0].y); expect(y).toBeLessThanOrEqual(hits[0].y + hits[0].h);
    expect(vi.mocked(ctx.roundRect).mock.calls.filter((call) => call[2] === 16 && call[3] === 17)).toHaveLength(1);
  }
});
it('opens a real desk through canvas hit testing and restores exterior hits after leaving, with paused/reduced arrival immediately open', () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context());
  const canvas = document.createElement('canvas'), root = document.createElement('section'); root.append(canvas);
  const renderer = createCityRenderer(canvas, root)!, buildings = fixture(1), view = buildingInterior(buildings[0]);
  renderer.draw(buildings, 'p', 0, true, view); renderer.draw(buildings, 'p', 1, true, view);
  const station = view.workers[0], point = interiorScreen(station.u + 55, station.v + 38, 72, interiorLayout(1120, 775));
  expect(renderer.hit(...point)).toBe(station.occupant.item.key); expect(renderer.hit(0, 0)).toBeUndefined();
  renderer.draw(buildings, 'p', 2, false, view); expect(renderer.hit(...point)).toBe(station.occupant.item.key);
  renderer.draw(buildings, 'p', 2.1, true, view); expect(renderer.hit(...point)).toBe(station.occupant.item.key);
  renderer.draw(buildings, 'p', 3, false); expect(renderer.hit(...point)).not.toBe(station.occupant.item.key);
  renderer.draw([{ ...buildings[0], id: 'other' }], 'other', 5, true, { ...view, building: { ...view.building, id: 'other' } });
});
it('caches the exterior while inside, refreshes after theme/viewport/population changes and releases its backing canvas', () => {
  const ctx = context(); vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
  const canvas = document.createElement('canvas'), root = document.createElement('section'); root.append(canvas);
  const renderer = createCityRenderer(canvas, root)!, buildings = fixture(5), view = buildingInterior(buildings[0]);
  const cityDraws = () => vi.mocked(ctx.fillText).mock.calls.filter(([text]) => text === 'THE COMMONS').length;
  renderer.draw(buildings, 'p', 0, true, view); const first = cityDraws();
  renderer.draw(buildings, 'p', 1, true, view); expect(cityDraws()).toBe(first);
  const floor = buildingInterior(buildings[0], { floor: 2 }); renderer.draw(buildings, 'p', 2, true, floor); expect(cityDraws()).toBe(first);
  renderer.refreshPalette(); renderer.draw(buildings, 'p', 3, true, floor); expect(cityDraws()).toBe(first + 1);
  Object.defineProperty(canvas, 'clientWidth', { value: 600 }); renderer.draw(buildings, 'p', 4, true, floor); expect(cityDraws()).toBe(first + 2);
  renderer.draw([...buildings], 'p', 5, true, floor); expect(cityDraws()).toBe(first + 3);
  renderer.dispose(); renderer.draw(buildings, 'p', 6, false, floor); expect(cityDraws()).toBe(first + 4);
  renderer.draw(buildings, 'p', 7, false); renderer.dispose();
});
