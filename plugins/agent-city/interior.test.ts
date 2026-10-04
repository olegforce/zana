import { describe, expect, it } from 'vitest';
import { buildingInterior, interiorLayout, interiorScreen, interiorWorker, reconcileSeats, workerLocation, interiorTier } from './interior.js';
import { cityBuildings, projectCity } from './model.js';
function building(n: number) {
  return cityBuildings(projectCity({ projects: [{ id: 'p', name: 'Workshop' }], members: Array.from({ length: n }, (_, i) => ({
    key: `agent:${String(i).padStart(3, '0')}`, projectId: 'p', kind: 'agent' as const, title: `Agent ${i}`, detail: '', live: true, status: 'idle' as const, scheduled: false, harness: i % 2 ? 'Cursor' : 'Codex'
  })), schedules: [{ key: 's', projectId: 'p', title: 'Nightly', enabled: false, running: false, nextRunAt: null, harness: 'Claude Code' }], executions: [], searchQuery: '' }), new Map())[0];
}
describe('Building interiors', () => {
  it('preserves survivors and their motion on ordinary arrivals/departures, reuses vacancies and bounds sparse pages', () => {
    const original = { ...building(6), schedules: [] };
    const seats = reconcileSeats(new Map(), original);
    const arrival = { ...original, count: 7, members: [{ ...original.members[0], key: 'agent:aaa' }, ...original.members] };
    const added = reconcileSeats(seats, arrival);
    for (const m of original.members) {
      expect(added.get(m.key)).toBe(seats.get(m.key));
      const before = workerLocation(original, seats.get(m.key)!);
      const after = workerLocation(arrival, added.get(m.key)!);
      expect(after).toEqual(before);
      const worker = (b: typeof original, map: Map<string, number>) => buildingInterior(b, { ...before, seats: map }).workers.find((w) => w.occupant.item.key === m.key)!;
      expect(worker(arrival, added).offset).toBe(worker(original, seats).offset);
    }
    const removed = { ...arrival, count: 6, members: arrival.members.filter((m) => m.key !== 'agent:002') };
    const surviving = reconcileSeats(added, removed); expect(surviving.has('agent:002')).toBe(false);
    const replacement = { ...removed, count: 7, members: [...removed.members, { ...original.members[0], key: 'replacement' }] };
    expect(reconcileSeats(surviving, replacement).get('replacement')).toBe(seats.get('agent:002'));
    const sparse = new Map([[original.members[0].key, 1000], [original.members[1].key, 2000]]);
    const compact = reconcileSeats(sparse, { ...original, members: original.members.slice(0, 2), count: 2 });
    expect([...compact.values()]).toEqual([0, 1]);
    expect(interiorTier(building(4))).not.toBe(interiorTier(building(5)));
    expect(reconcileSeats(added, { ...arrival, members: [], schedules: [] }).size).toBe(0);
    // A missing desk remains vacant rather than renumbering its neighbors.
    const view = buildingInterior(removed, { seats: surviving });
    expect(view.workers.map((w) => w.slot)).toEqual([0, 1, 3]);
  });
  it('renders exactly one worker per live session or planned seat, with idle agents relaxing and plans staying distinct', () => {
    const garage = buildingInterior({ ...building(1), schedules: [] });
    expect(garage.floor.label).toBe('Garage workshop'); expect(garage.workers).toHaveLength(1);
    expect(garage.workers[0].occupant.item.key).toBe('agent:000'); expect(garage.workers[0].color).toBe('#55cfa7'); expect(garage.workers[0].atDesk).toBe(false);
    const planned = buildingInterior(building(0));
    expect(planned.workers).toHaveLength(1); expect(planned.workers[0].occupant.kind).toBe('plan'); expect(planned.workers[0].atDesk).toBe(true);
    expect(planned.workers[0].color).toBe('#e89b71'); expect(planned.building.count).toBe(0);
    const exited = { ...building(1), count: 0, members: [{ ...building(1).members[0], live: false }], schedules: [] };
    expect(buildingInterior(exited).workers).toEqual([]);
    const running = { ...building(1), members: [{ ...building(1).members[0], scheduled: true }], schedules: [{ ...building(1).schedules[0], running: true }] };
    const run = buildingInterior(running); expect(run.workers).toHaveLength(1); expect(run.workers[0].atDesk).toBe(true);
    for (const status of ['working', 'needs-you', 'error', 'unknown'] as const) {
      const changed = buildingInterior({ ...garage.building, members: [{ ...garage.building.members[0], status }] });
      expect(changed.workers).toHaveLength(1); expect(changed.workers[0].atDesk).toBe(true);
    }
  });
  it('offers an office and roof, distributes towers over floors and excludes circulation areas from agent desks', () => {
    const office = buildingInterior({ ...building(4), schedules: [] });
    expect(office.levels.map((f) => f.label)).toEqual(['Main office', 'Roof terrace']); expect(office.workers).toHaveLength(4);
    const tower = { ...building(5), schedules: [] }, first = buildingInterior(tower);
    expect(first.floor.label).toBe('Floor 1'); expect(first.workers).toHaveLength(4);
    const second = buildingInterior(tower, { floor: 2 });
    expect(second.workers[0].occupant.item.key).toBe('agent:004'); expect(second.workers).toHaveLength(1);
    const lobby = buildingInterior(tower, { floor: 0 }), roof = buildingInterior(tower, { floor: 6 });
    expect(lobby.floor.kind).toBe('lobby'); expect(lobby.workers).toEqual([]);
    expect(roof.floor.kind).toBe('terrace'); expect(roof.workers).toEqual([]);
    expect(buildingInterior(tower, { floor: 4 }).workers).toEqual([]);
    expect(buildingInterior(tower, { floor: 99 }).floor.id).toBe(1);
  });
  it('keeps floor assignment stable across status and input order changes, and reaches every agent within bounded desk pages', () => {
    const tower = { ...building(105), schedules: [] }, seen: string[] = [];
    for (const floor of buildingInterior(tower).levels) {
      const initial = buildingInterior(tower, { floor: floor.id });
      for (let page = 0; page < initial.pages; page++) {
        const view = buildingInterior(tower, { floor: floor.id, page });
        expect(view.workers.length).toBeLessThanOrEqual(4); seen.push(...view.workers.map((s) => s.occupant.item.key));
      }
    }
    expect(new Set(seen).size).toBe(105); expect(seen).toHaveLength(105);
    const stable = buildingInterior({ ...tower, members: [...tower.members].reverse().map((m) => ({ ...m, status: 'working' as const })) });
    expect(stable.workers.map((s) => s.occupant.item.key)).toEqual(buildingInterior(tower).workers.map((s) => s.occupant.item.key));
    expect(buildingInterior(tower, { floor: 1, page: -1 }).page).toBe(0);
    const last = buildingInterior(tower, { floor: 1, page: 99 }); expect(last.page).toBe(last.pages - 1);
  });
  it('keeps motion in the circulation lanes and fits room corners within narrow and wide viewports', () => {
    for (let t = -50; t < 200; t += .7) {
      const { point: [u, v] } = interiorWorker({ offset: .37, slot: 0 }, t);
      expect(u).toBeGreaterThanOrEqual(42); expect(u).toBeLessThanOrEqual(450); expect(v).toBeGreaterThanOrEqual(96); expect(v).toBeLessThanOrEqual(365);
      expect(u < 150 || v >= 320).toBe(true);
    }
    expect(interiorWorker({ offset: 0, slot: 0 }, 0)).toEqual({ point: [42, 198], seated: true, walking: false });
    expect(interiorWorker({ offset: 0, slot: 0 }, 15).walking).toBe(true);
    expect(interiorWorker({ offset: 0, slot: 0 }, 22)).toEqual({ point: [130, 96], seated: false, walking: false });
    expect(interiorWorker({ offset: 0, slot: 0 }, 30).walking).toBe(true);
    for (const [width, height] of [[280, 340], [280, 440], [600, 550], [1120, 760]]) {
      const layout = interiorLayout(width, height);
      for (const [u, v, z] of [[0, 0, 110], [620, 0, 110], [620, 420, -18], [0, 420, -18]]) {
        const [x, y] = interiorScreen(u, v, z, layout); expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(width); expect(y).toBeGreaterThan(70); expect(y).toBeLessThan(height - 45);
      }
    }
  });
});
