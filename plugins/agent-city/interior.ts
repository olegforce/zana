import { alongRoute, harnessStyle, routeLength, type Point } from './commuters.js';
import { floors, projectPoint, type CityBuilding } from './model.js';

export type InteriorOccupant = { kind: 'agent'; item: CityBuilding['members'][number] } | { kind: 'plan'; item: CityBuilding['schedules'][number] };
export type InteriorFloor = { id: number; label: string; kind: 'work' | 'lobby' | 'terrace'; count: number; planned: number; needs: number };
export type InteriorWorker = { occupant: InteriorOccupant; u: number; v: number; color: string; atDesk: boolean; offset: number; slot: number; highlighted: boolean };
export type InteriorModel = ReturnType<typeof buildingInterior>;
export const ROOM_WIDTH = 620, ROOM_DEPTH = 420, DESKS_PER_PAGE = 4;

export function interiorOccupants(building: CityBuilding): InteriorOccupant[] {
  const live = building.members.filter((m) => m.live).sort((a, b) => a.key.localeCompare(b.key));
  return [
    ...live.map((item) => ({ kind: 'agent' as const, item })),
    ...building.schedules.filter((s) => !s.running).sort((a, b) => a.key.localeCompare(b.key)).map((item) => ({ kind: 'plan' as const, item }))
  ];
}
export const interiorTier = (building: CityBuilding) => `${building.form}:${floors(building.count)}`;
/** Reuse empty seats; ordinary arrivals/departures never move surviving occupants. */
export function reconcileSeats(previous: ReadonlyMap<string, number>, building: CityBuilding) {
  const occupants = interiorOccupants(building), ids = new Set(occupants.map((o) => o.item.key));
  let seats = new Map([...previous].filter(([key]) => ids.has(key)));
  // Bound empty pages after a large contraction, even if the building keeps its tier.
  if ([...seats.values()].reduce((max, seat) => Math.max(max, seat), -1) >= Math.max(40, occupants.length * 2)) {
    seats = new Map([...seats].sort((a, b) => a[1] - b[1]).map(([key], index) => [key, index]));
  }
  const used = new Set(seats.values()); let next = 0;
  for (const { item } of occupants) {
    if (seats.has(item.key)) continue;
    while (used.has(next)) next++;
    seats.set(item.key, next); used.add(next);
  }
  return seats;
}
export function workerLocation(building: CityBuilding, seat: number) {
  const offices = building.form === 'tower' ? floors(building.count) - 2 : 1;
  return { floor: building.form === 'tower' ? 1 + Math.floor(seat / DESKS_PER_PAGE) % offices : 0,
    page: Math.floor(seat / (DESKS_PER_PAGE * offices)), slot: seat % DESKS_PER_PAGE };
}
/** Identity-seeded phases survive a change of floor/page or neighbors. */
function workerOffset(key: string) {
  let hash = 0; for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (hash % 1000) / 1000 * .2;
}
/** One worker per live session or non-running plan. A running plan already has a live session. */
export function buildingInterior(building: CityBuilding, { floor: chosenFloor, page: chosenPage = 0, seats = reconcileSeats(new Map(), building), focusedKey }: { floor?: number; page?: number; seats?: ReadonlyMap<string, number>; focusedKey?: string } = {}) {
  const occupants = interiorOccupants(building).map((occupant) => ({ occupant, ...workerLocation(building, seats.get(occupant.item.key)!) }));
  const levelCount = floors(building.count);
  const levels: InteriorFloor[] = Array.from({ length: levelCount }, (_, id) => ({
    id, kind: building.form !== 'house' && id === levelCount - 1 ? 'terrace' : building.form === 'tower' && id === 0 ? 'lobby' : 'work',
    label: building.form === 'house' ? 'Garage workshop' : id === levelCount - 1 ? 'Roof terrace' : building.form === 'tower' ? id === 0 ? 'Lobby' : `Floor ${id}` : 'Main office',
    count: occupants.filter((o) => o.occupant.kind === 'agent' && o.floor === id).length,
    planned: occupants.filter((o) => o.occupant.kind === 'plan' && o.floor === id).length,
    needs: occupants.filter((o) => o.occupant.kind === 'agent' && o.occupant.item.status === 'needs-you' && o.floor === id).length
  }));
  const floor = levels.find((f) => f.id === chosenFloor) ?? levels[building.form === 'tower' ? 1 : 0];
  const floorMembers = occupants.filter((o) => o.floor === floor.id);
  const pages = floorMembers.reduce((max, o) => Math.max(max, o.page + 1), 1);
  const page = Math.max(0, Math.min(pages - 1, chosenPage));
  const visible = floorMembers.filter((o) => o.page === page).sort((a, b) => a.slot - b.slot);
  const workers: InteriorWorker[] = visible.map(({ occupant, slot: i }) => ({
    occupant, u: 210 + (i % 2) * 170, v: 100 + Math.floor(i / 2) * 115,
    color: harnessStyle(occupant.item.harness).color,
    atDesk: occupant.kind === 'plan' || occupant.item.scheduled || occupant.item.status !== 'idle', offset: workerOffset(occupant.item.key), slot: i,
    highlighted: occupant.item.key === focusedKey
  }));
  return { building, levels, floor, workers, page, pages };
}

/** Idle agents relax, walk to coffee, then stroll back. Position and hits share this path. */
export function interiorWorker(worker: Pick<InteriorWorker, 'offset' | 'slot'>, elapsed: number) {
  const seat: Point = [42 + worker.slot * 30, 198], coffee: Point = [130, 96];
  const phase = ((elapsed + worker.offset * 48) % 48 + 48) % 48;
  const outward: Point[] = [seat, [145, 220], [145, 100], coffee];
  const homeward: Point[] = [coffee, [145, 100], [145, 320], [450, 320], [450, 365], [145, 365], [145, 220], seat];
  if (phase < 12) return { point: seat, walking: false, seated: true };
  if (phase < 20) return { point: alongRoute(outward, routeLength(outward) * (phase - 12) / 8), walking: true, seated: false };
  if (phase < 26) return { point: coffee, walking: false, seated: false };
  return { point: alongRoute(homeward, routeLength(homeward) * (phase - 26) / 22), walking: true, seated: false };
}
export function interiorLayout(width: number, height: number, entrance = 1) {
  const top = width < 450 ? 128 : 80, available = height - top - 70;
  const scale = Math.max(.1, Math.min((width - 32) / 780, available / 490)) * (.88 + .12 * entrance);
  return { scale, x: width / 2 - 72 * scale, y: top + available / 2 - 140 * scale };
}
export function interiorScreen(u: number, v: number, z: number, layout: ReturnType<typeof interiorLayout>): [number, number] {
  const [x, y] = projectPoint(u, v, z);
  return [layout.x + x * layout.scale, layout.y + y * layout.scale];
}
