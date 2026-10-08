import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@zana-ai/zcc-domain/product';
import { settingsHitHint, settingsHitPath, settingsPaletteItems } from '../palette';
import type { SettingsSearchHit } from '../types';

const hit = (over: Partial<SettingsSearchHit['entry']> = {}, extra: Partial<SettingsSearchHit> = {}): SettingsSearchHit => ({
  entry: { id: 'agents.auto-close-idle', section: 'agents', label: 'Auto-close idle', kind: 'setting', ...over },
  breadcrumb: 'Agents › Idle handling', score: 1, tier: 1, ...extra
});

describe('settings palette adapter', () => {
  it('builds the deep link from the entry id, or the section alone for section entries', () => {
    expect(settingsHitPath(hit())).toBe('/settings/agents#agents.auto-close-idle');
    expect(settingsHitPath(hit({ kind: 'section' }))).toBe('/settings/agents');
  });

  it('routes project entries through the project settings path', () => {
    expect(settingsHitPath(hit({ section: 'project', id: 'project.x' }), 'p1')).toContain('/projects/p1/settings#project.x');
    expect(settingsHitPath(hit({ section: 'project', kind: 'section' }), null)).not.toContain('#');
  });

  it('hints with the breadcrumb and appends the current value only when it matched', () => {
    expect(settingsHitHint(hit())).toBe('Agents › Idle handling');
    expect(settingsHitHint(hit({}, { matchedValue: 'On' }))).toBe('Agents › Idle handling · Current: On');
  });

  it('returns nothing for a blank query', () => {
    const navigate = vi.fn();
    expect(settingsPaletteItems('  ', { config: {} as AppConfig }, { limit: 5, navigate })).toEqual([]);
  });

  it('maps engine hits to rows keyed by entry id that navigate on run, without help in keywords', () => {
    const navigate = vi.fn();
    const items = settingsPaletteItems('heartbeat', { config: {} as AppConfig }, { limit: 60, navigate });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.key.startsWith('settings:')).toBe(true);
      expect(item.category).toBe('Settings');
      expect(item.keywords).toBeUndefined();
    }
    items[0].run();
    expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/settings\//));
    expect(settingsPaletteItems('heartbeat', { config: {} as AppConfig }, { limit: 2, navigate }).length).toBeLessThanOrEqual(2);
  });
});
