import { describe, expect, it } from 'vitest';
import { alongRoute, routeLength, cityCommuters, commuterCounts, commuterPosition, commuteRoute, commuterBus, busStop, harnessStyle, harnessLegend, withThreadHarnesses, MAX_COMMUTERS, BUS_PERIOD } from './commuters.js';
import { cityBuildings, cityLayout, projectCity } from './model.js';
import type { PluginFleetMember, PluginSidebarThread } from '@zana-ai/zcc-plugin-sdk/app';
const member = (id: string, harness = 'Codex'): PluginFleetMember => ({ key: `thread:${id}`, kind: 'thread', title: id, projectId: id, harness, live: true, status: 'idle', scheduled: false, detail: 'Idle' });
function buildings(n = 1, populations = Array.from({ length: n }, () => 1)) {
  const projects = Array.from({ length: n }, (_, i) => ({ id: String(i), name: String(i) }));
  return cityBuildings(projectCity({ projects, members: projects.flatMap((p, i) => Array.from({ length: populations[i] }, () => member(p.id))), schedules: [], executions: [], searchQuery: '' }), new Map());
}
describe('Ambient commuters', () => {
  it('scales garage, office and tower traffic with live population and adapts when the team changes', () => {
    const b = buildings(6, [1, 2, 3, 4, 5, 10]);
    expect(commuterCounts(b)).toEqual([8, 16, 24, 32, 40, 80]);
    const crowd = cityCommuters(b, cityLayout(b));
    expect(b.map((p) => crowd.filter((c) => c.projectId === p.id).length)).toEqual(commuterCounts(b));
    expect(commuterCounts(buildings(1, [5]))).toEqual([40]);
    expect(commuterCounts(buildings(1, [1]))).toEqual([8]);
    expect(commuterCounts([])).toEqual([]);
    const quiet = { ...b[0], count: 0, members: [{ ...member('0', 'Claude Code'), live: false }] };
    expect(commuterCounts([quiet])).toEqual([0]);
    expect(cityCommuters([quiet], cityLayout([quiet]))).toEqual([]);
    const live = { ...b[0], members: [...quiet.members, member('0', 'Codex')] };
    expect(cityCommuters([live], cityLayout([live])).every((c) => c.color === harnessStyle('Codex').color)).toBe(true);
  });
  it('shares the scene cap proportionally and rounds consistently regardless of project order', () => {
    const b = buildings(3, [50, 5, 1]);
    const counts = commuterCounts(b);
    expect(counts).toEqual([196, 20, 4]);
    expect(counts.reduce((sum, n) => sum + n, 0)).toBe(MAX_COMMUTERS);
    expect(commuterCounts(b.slice().reverse()).reverse()).toEqual(counts);
    expect(cityCommuters(b, cityLayout(b))).toHaveLength(MAX_COMMUTERS);
    // Evenly populated cities still distribute a whole bounded budget with stable tie-breaking.
    const equal = buildings(30);
    const distribution = new Map(equal.map((p, i) => [p.id, commuterCounts(equal)[i]]));
    const reversed = equal.slice().reverse();
    expect(reversed.map((p, i) => commuterCounts(reversed)[i])).toEqual(reversed.map((p) => distribution.get(p.id)));
  });
  it('uses consistent harness colors across profiles and provider ids, including unknown providers', () => {
    for (const [a, b] of [['claude-yolo', 'Claude Code'], ['acp-opencode', 'OpenCode'], ['codex-resume', 'Codex'], ['provider-pi', 'Pi'], ['Cursor', 'acp-cursor'], ['grok', 'Grok Build'], ['mastracode', 'Mastra Code'], ['afcode', 'Afcode']]) expect(harnessStyle(a)).toEqual(harnessStyle(b));
    expect(new Set(['Codex', 'Claude Code', 'Cursor', 'OpenCode', 'Pi', 'Grok Build', 'Mastra Code', 'Afcode'].map((h) => harnessStyle(h).color)).size).toBe(8);
    expect(harnessStyle().name).toBe('Unknown harness');
    expect(harnessStyle('new-provider')).toEqual(harnessStyle('new-provider'));
    expect(harnessStyle('new-provider').color).toMatch(/^hsl/);
  });
  it('only enriches matching projected threads on older hosts and preserves authoritative harness metadata', () => {
    const members = [member('0'), { ...member('1'), harness: undefined }, { ...member('2'), kind: 'agent' as const, harness: undefined }, { ...member('3'), harness: undefined }, { ...member('4'), harness: undefined }];
    const threads = ['0', '1', '2', '3'].map((id) => ({ id, projectId: id === '3' ? 'other' : id, providerId: 'claude-code' } as PluginSidebarThread));
    const result = withThreadHarnesses(members, threads);
    expect(result).toHaveLength(members.length);
    expect(result.map((m) => m.harness)).toEqual(['Codex', 'claude-code', undefined, undefined, undefined]);
  });
  it('creates a busy bounded population even for one idle agent and supports scheduled-only buildings', () => {
    const b = buildings(), layout = cityLayout(b), crowd = cityCommuters(b, layout);
    expect(crowd.length).toBe(8);
    expect(crowd.some((c) => c.via === 'train')).toBe(true);
    expect(crowd.some((c) => c.via === 'bus')).toBe(true);
    expect(crowd.every((c) => c.projectId === '0' && c.color === harnessStyle('Codex').color)).toBe(true);
    const many = buildings(1000);
    expect(cityCommuters(many, cityLayout(many))).toHaveLength(MAX_COMMUTERS);
    expect(cityCommuters([], cityLayout([]))).toEqual([]);
    const plans = cityBuildings(projectCity({ projects: [{ id: 'planned', name: 'Planned' }], members: [], schedules: [{ key: 's', projectId: 'planned', title: 'Plan', enabled: false, running: false, nextRunAt: null, harness: 'Cursor' }], executions: [], searchQuery: '' }), new Map());
    expect(plans[0].count).toBe(0);
    expect(cityCommuters(plans, cityLayout(plans))[0].color).toBe(harnessStyle('Cursor').color);
    expect(harnessLegend([...b, ...plans, ...b])).toEqual([harnessStyle('Codex'), harnessStyle('Cursor')]);
  });
  it('walks connected sidewalks between the station or bus stop and the owning office door', () => {
    const b = buildings(3), layout = cityLayout(b);
    for (const p of b) for (const via of ['train', 'bus'] as const) {
      const route = commuteRoute(p, layout, via);
      expect(route[0]).toEqual(via === 'train' ? [158, layout.frontage + 163] : busStop(p));
      expect(route.at(-1)).toEqual([p.u + p.w * .42 + 15, p.v + p.d + 14]);
      for (let i = 1; i < route.length; i++) expect(route[i][0] === route[i - 1][0] || route[i][1] === route[i - 1][1]).toBe(true);
    }
    const route = [[0, 0], [0, 0], [30, 0], [30, 40]] as const;
    expect(routeLength(route)).toBe(70);
    expect(alongRoute(route, -1)).toEqual([0, 0]);
    expect(alongRoute(route, 45)).toEqual([30, 15]);
    expect(alongRoute(route, 90)).toEqual([30, 40]);
  });
  it('arrives, lingers, returns and waits, with staggered repeatable motion', () => {
    const c = { ...cityCommuters(buildings(), cityLayout(buildings()))[0], offset: 0 };
    const leg = c.distance / c.speed;
    expect(commuterPosition(c, 0)).toMatchObject({ point: c.route[0], walking: true });
    expect(commuterPosition(c, leg + 2)).toEqual({ point: c.route.at(-1), walking: false });
    expect(commuterPosition(c, leg + 7).walking).toBe(true);
    expect(commuterPosition(c, leg * 2 + 7)).toEqual({ point: c.route[0], walking: false });
    expect(commuterPosition(c, leg * 2 + 10)).toEqual(commuterPosition(c, 0));
    expect(commuterPosition(c, 1).point).not.toEqual(commuterPosition(c, 2).point);
  });
  it('brings buses to the correct road, dwells at the stop, then leaves', () => {
    const b = buildings(), p = b[0], layout = cityLayout(b);
    expect(commuterBus(p, layout, 0).stopped).toBe(false);
    expect(commuterBus(p, layout, 15)).toEqual(commuterBus(p, layout, 20));
    expect(commuterBus(p, layout, 15).stopped).toBe(true);
    expect(commuterBus(p, layout, 25).u).toBeGreaterThan(commuterBus(p, layout, 20).u);
    expect(commuterBus(p, layout, 25).v).toBe(busStop(p)[1] - 31);
    expect(commuterBus(p, layout, BUS_PERIOD)).toEqual(commuterBus(p, layout, 0));
  });
});
