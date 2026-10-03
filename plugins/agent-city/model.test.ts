import { describe, it, expect } from 'vitest';
import { floors, buildingHeight, projectCity, cityBuildings, reconcileLots, gridPlot, cityLayout, projectPoint, labelPosition, nextRunLabel } from './model.js';
import type { PluginFleetMember } from '@zana-ai/zcc-plugin-sdk/app';
const member = (projectId: string, status: PluginFleetMember['status'], live = true): PluginFleetMember => ({ key: status, kind: 'agent', title: status, projectId, status, live, scheduled: false, detail: status });
describe('City model', () => {
  it('grows at readable thresholds and caps the skyline', () => {
    expect([0, 1, 2, 3, 5, 6, 10, 11, 20, 21, 10000].map(floors)).toEqual([1,1,1,2,2,3,3,5,5,6,6]);
    expect(buildingHeight(10000)).toBe(196);
  });
  it('keeps stable lots and counts only live members, not schedules or execution summaries', () => {
    const projects = Array.from({ length: 7 }, (_, i) => ({ id: String(i), name: `Project ${i}` }));
    const city = projectCity({ projects, members: [member('0', 'working'), member('0', 'idle'), member('0', 'done', false), member('0', 'needs-you')], schedules: [], executions: [], searchQuery: '' });
    expect(city[0]).toMatchObject({ count: 3, working: 1, needs: 1 });
    const buildings = cityBuildings(city, reconcileLots(new Map(), projects));
    expect(buildings).toHaveLength(7);
    expect(labelPosition(buildings[0], cityLayout(buildings))).toEqual({ left: expect.stringMatching(/%$/), top: expect.stringMatching(/%$/) });
  });
  it('keeps plots stable across reordered arrivals, removals and reuse, with no retained stale ids', () => {
    const initial = Array.from({ length: 10 }, (_, i) => ({ id: String(i) }));
    const lots = reconcileLots(new Map(), initial);
    const added = reconcileLots(lots, [{ id: 'new' }, ...initial.slice().reverse()]);
    for (const { id } of initial) expect(added.get(id)).toBe(lots.get(id));
    expect(added.get('new')).toBe(10);
    const removed = reconcileLots(added, initial.slice(1));
    expect(removed.size).toBe(9);
    expect(reconcileLots(removed, [...initial.slice(1), { id: 'replacement' }]).get('replacement')).toBe(0);
    expect(reconcileLots(lots, []).size).toBe(0);
  });
  it('allocates distinct plots and fits every building at city sizes from zero to 1000', () => {
    expect(gridPlot(0)).toEqual({ col: 0, row: 0 });
    expect(new Set(Array.from({ length: 1001 }, (_, i) => JSON.stringify(gridPlot(i)))).size).toBe(1001);
    for (const n of [0, 1, 3, 10, 38, 1000]) {
      const projects = Array.from({ length: n }, (_, i) => ({ id: String(i), name: String(i) }));
      const city = projectCity({ projects, members: [], schedules: [], executions: [], searchQuery: '' });
      const buildings = cityBuildings(city, new Map());
      for (const [width, height] of [[1120, 500], [300, 280]]) {
        const layout = cityLayout(buildings, width, height);
        expect(layout.scale).toBeGreaterThan(0);
        for (const p of buildings) {
          // Tallest possible roof and all footprint corners fit the viewport.
          for (const z of [0, buildingHeight(10000) + 40]) {
            const [x, y] = projectPoint(p.u + p.w / 2, p.v + p.d / 2, z);
            expect(layout.x + x * layout.scale).toBeGreaterThan(0);
            expect(layout.x + x * layout.scale).toBeLessThan(width);
            expect(layout.y + y * layout.scale).toBeGreaterThan(0);
            expect(layout.y + y * layout.scale).toBeLessThan(height);
          }
        }
      }
    }
  });
  it('retains matched names, agents, schedules and jobs under host search', () => {
    const city = projectCity({ projects: ['match','member','schedule','job','empty'].map((id) => ({ id, name: id })), members: [member('member', 'idle')], schedules: [{ key: 's', title: 'match', projectId: 'schedule', enabled: true, nextRunAt: null, running: false }], executions: [{ key: 'j', title: 'match', projectId: 'job', state: 'RUNNING', needsAttention: false }], searchQuery: 'match' });
    expect(city.map((p) => p.id)).toEqual(['match','member','schedule','job']);
  });
  it('handles missing or invalid next runs without inventing a countdown', () => {
    expect(nextRunLabel(null)).toBe('Next run not available');
    expect(nextRunLabel('nonsense')).toBe('Next run not available');
    expect(nextRunLabel('2026-10-03T18:00:00Z')).not.toContain('Invalid');
  });
});
