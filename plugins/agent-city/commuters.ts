import type { PluginFleetMember, PluginSidebarThread } from '@zana-ai/zcc-plugin-sdk/app';
import { BLOCK, type CityBuilding, type CityLayout } from './model.js';

const HARNESS_COLORS = [
  { name: 'Codex', color: '#55cfa7' },
  { name: 'Claude Code', color: '#e89b71' },
  { name: 'Cursor', color: '#80b9ff' },
  { name: 'OpenCode', color: '#c29bff' },
  { name: 'Pi', color: '#edce64' },
  { name: 'Grok Build', color: '#ed91bd' },
  { name: 'Mastra Code', color: '#83d8e4' },
  { name: 'Afcode', color: '#b5d97b' }
];
export function harnessStyle(harness?: string): { name: string; color: string } {
  if (!harness) return { name: 'Unknown harness', color: '#9faebc' };
  const normalized = harness.toLowerCase().replace(/^(provider-|harness-|acp-)/, '').replace(/[\s_-]/g, '');
  const known = HARNESS_COLORS.find((h) => normalized.startsWith(h.name.toLowerCase().replace(/ /g, '').replace(/code$|build$/, '')));
  if (known) return known;
  let hash = 0;
  for (const char of normalized) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return { name: harness, color: `hsl(${hash % 360} 62% 70%)` };
}
/** Compatibility metadata from the host's existing reactive thread store; never adds fleet members. */
export function withThreadHarnesses(members: readonly PluginFleetMember[], threads: readonly PluginSidebarThread[]): readonly PluginFleetMember[] {
  const harnesses = new Map(threads.map((t) => [`thread:${t.id}`, t]));
  return members.map((m) => {
    const thread = harnesses.get(m.key);
    return !m.harness && m.kind === 'thread' && thread?.projectId === m.projectId ? { ...m, harness: thread.providerId } : m;
  });
}
export function harnessLegend(buildings: readonly CityBuilding[]) {
  const styles = buildings.flatMap((p) => [...p.members, ...p.schedules].map((m) => harnessStyle(m.harness)));
  return [...new Map(styles.map((s) => [s.name, s])).values()].sort((a, b) => a.name.localeCompare(b.name));
}

export type Point = readonly [number, number];
export type Commute = { projectId: string; color: string; via: 'train' | 'bus'; route: Point[]; distance: number; offset: number; speed: number };
export const MAX_COMMUTERS = 220;
export const BUS_PERIOD = 34;
/** Eight decorative employees per live agent; planned-only houses get light traffic. */
export function commuterCounts(buildings: readonly CityBuilding[]): number[] {
  const desired = buildings.map((p) => p.count > 0 ? p.count * 8 : p.schedules.length > 0 ? 4 : 0);
  const total = desired.reduce((sum, n) => sum + n, 0);
  if (total <= MAX_COMMUTERS) return desired;
  // Scale the entire population together so the scene cap preserves relative traffic.
  const scaled = desired.map((n) => n * MAX_COMMUTERS / total);
  const counts = scaled.map(Math.floor);
  const remainder = MAX_COMMUTERS - counts.reduce((sum, n) => sum + n, 0);
  const order = buildings.map((p, i) => ({ id: p.id, i, fraction: scaled[i] - counts[i] }))
    .sort((a, b) => b.fraction - a.fraction || a.id.localeCompare(b.id));
  for (let i = 0; i < remainder; i++) counts[order[i].i]++;
  return counts;
}
export function routeLength(points: readonly Point[]) {
  return points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - points[i][0], p[1] - points[i][1]), 0);
}
export function alongRoute(points: readonly Point[], distance: number): Point {
  let remaining = Math.max(0, distance);
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (remaining <= length && length > 0) return [a[0] + (b[0] - a[0]) * remaining / length, a[1] + (b[1] - a[1]) * remaining / length];
    remaining -= length;
  }
  return points[points.length - 1];
}
export function busStop(p: CityBuilding): Point { return [p.u + p.w * .42 + 15, (Math.floor(p.v / BLOCK) + 1) * BLOCK + 49]; }
export function commuteRoute(p: CityBuilding, layout: CityLayout, via: Commute['via'], lane = 0): Point[] {
  const sidewalk = Math.floor(p.u / BLOCK) * BLOCK + 50 + lane;
  const door = p.u + p.w * .42 + 15;
  const approach = p.v + p.d + 35 + lane;
  const start: Point = via === 'train' ? [158 + lane * 2, layout.frontage + 163] : busStop(p);
  const road = via === 'train' ? layout.frontage + 50 + lane : start[1];
  return [start, [start[0], road], [sidewalk, road], [sidewalk, approach], [door, approach], [door, p.v + p.d + 14]];
}
/** Decorative employees borrow actual harness colors. Population never changes real counts or status. */
export function cityCommuters(buildings: readonly CityBuilding[], layout: CityLayout): Commute[] {
  const counts = commuterCounts(buildings);
  return buildings.flatMap((p, i) => {
    const sources = p.count > 0 ? p.members.filter((m) => m.live) : p.schedules;
    return Array.from({ length: counts[i] }, (_, local) => {
      const via = local % 3 === 0 ? 'bus' : 'train';
      const route = commuteRoute(p, layout, via, local % 3 - 1);
      const distance = routeLength(route), speed = 18 + local % 7;
      return { projectId: p.id, color: harnessStyle(sources[local % sources.length]?.harness).color, via, route, distance, speed,
        offset: local * .618 + p.lot * .137 };
    });
  });
}
export function commuterPosition(c: Commute, elapsed: number): { point: Point; walking: boolean } {
  // A repeated workday: arrive, walk to the office, linger, walk back to transit.
  const leg = c.distance / c.speed, dwell = 5;
  const cycle = leg * 2 + dwell * 2;
  const phase = ((elapsed + c.offset * cycle) % cycle + cycle) % cycle;
  const distance = phase < leg ? phase * c.speed : phase < leg + dwell ? c.distance
    : phase < leg * 2 + dwell ? c.distance - (phase - leg - dwell) * c.speed : 0;
  return { point: alongRoute(c.route, distance), walking: phase < leg || (phase >= leg + dwell && phase < leg * 2 + dwell) };
}
/** Each building gets a bus that visibly dwells at its own stop before continuing along the road. */
export function commuterBus(p: CityBuilding, layout: CityLayout, elapsed: number) {
  const [stopU, stopV] = busStop(p), span = layout.width - 70, stop = Math.min(stopU - 28, span);
  const phase = ((elapsed + p.lot * 5) % BUS_PERIOD + BUS_PERIOD) % BUS_PERIOD;
  const arrival = 13, departure = 21;
  const u = phase < arrival ? 8 + (stop - 8) * phase / arrival : phase < departure ? stop
    : stop + (span - stop) * (phase - departure) / (BUS_PERIOD - departure);
  return { u, v: stopV - 31, stopped: phase >= arrival && phase < departure };
}
