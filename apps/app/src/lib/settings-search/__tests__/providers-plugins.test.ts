// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginAppEntry, PluginSettingsSnapshot } from '@zana-ai/zcc-domain/product';

const slots = vi.hoisted(() => ({ sections: [] as unknown[] }));
vi.mock('../../../plugins/plugin-slots.js', () => ({ listSettingsSections: () => slots.sections }));
vi.mock('../../product-client.js', () => ({ product: { pluginApps: {} } }));

import { searchSettings } from '../index';
import { getSettingsSearchProviders, getSettingsSearchSourcesVersion } from '../registry';
import { findSecretValueViolations } from '../secrets';
import {
  PLUGIN_SETTING_PARAM,
  PLUGIN_VALUES_TTL_MS,
  pluginSettingHref,
  pluginSettingsSearchProvider,
  prefetchPluginSettings,
  registerPluginSettingsProvider,
  resetPluginSettingsCache,
  type DeepLinkedSettingsEntry
} from '../providers/plugins';
import { revealPluginSetting } from '../../../views/extensions/ExtensionsHub';

const SECRET_DUMMY = 'hunter2-fixture-dummy-0000';
const app = (id: string, name: string, enabled = true): PluginAppEntry => ({ id, name, enabled } as PluginAppEntry);
const snap = (): PluginSettingsSnapshot => ({
  descriptors: {
    relay: { type: 'string', label: 'Relay endpoint', description: 'Quokka gateway address.' },
    mode: { type: 'select', label: 'Delivery strategy', options: ['fast', 'thorough'] },
    flag: { type: 'boolean', label: 'Emit traces' },
    phrase: { type: 'string', label: 'Access phrase', secret: true },
    empty: { type: 'number', label: 'Retry budget' }
  },
  values: { relay: 'https://relay.test/quokka', mode: 'thorough', flag: true, phrase: SECRET_DUMMY }
} as PluginSettingsSnapshot);

const api = (apps: PluginAppEntry[] = [app('p1', 'Fixture One')]) => ({
  list: vi.fn().mockResolvedValue(apps),
  getSettings: vi.fn().mockResolvedValue(snap())
});
const config = { config: {} as never };

beforeEach(() => {
  resetPluginSettingsCache();
  slots.sections = [];
});
afterEach(() => vi.useRealTimers());

describe('plugin settings provider', () => {
  it('is empty until prefetched, then indexes label, description, options and non-secret values', async () => {
    expect(pluginSettingsSearchProvider(config)).toEqual([]);
    const a = api();
    await prefetchPluginSettings(a);
    const entries = pluginSettingsSearchProvider(config) as DeepLinkedSettingsEntry[];
    expect(entries.map((e) => e.id)).toContain('plugin.p1.relay');
    const relay = entries.find((e) => e.id === 'plugin.p1.relay')!;
    expect(relay).toMatchObject({ label: 'Relay endpoint', help: 'Quokka gateway address.', section: 'Plugins › Fixture One' });
    expect(relay.href).toContain(`?${PLUGIN_SETTING_PARAM}=Relay%20endpoint#plugin-configure`);
    expect(relay.href.endsWith('#plugin-configure')).toBe(true);
    expect(relay.value?.(config)).toBe('https://relay.test/quokka');
    expect(entries.find((e) => e.id === 'plugin.p1.flag')!.value?.(config)).toBe('On');
    expect(entries.find((e) => e.id === 'plugin.p1.mode')!.options).toEqual(['fast', 'thorough']);
    expect(entries.find((e) => e.id === 'plugin.p1.empty')!.value).toBeUndefined();
  });

  it('never reads or stores a secret descriptor value', async () => {
    await prefetchPluginSettings(api());
    const entries = pluginSettingsSearchProvider(config);
    const phrase = entries.find((e) => e.id === 'plugin.p1.phrase')!;
    expect(phrase.label).toBe('Access phrase');
    expect(phrase.value).toBeUndefined();
    expect(JSON.stringify(entries.map((e) => e.value?.(config)))).not.toContain(SECRET_DUMMY);
    expect(findSecretValueViolations(entries)).toEqual([]);
  });

  it('end to end: a secret value is unsearchable, a normal value is found, label stays findable', async () => {
    await prefetchPluginSettings(api());
    const opts = { providers: [pluginSettingsSearchProvider], entries: [] };
    expect(searchSettings(SECRET_DUMMY, config, opts)).toEqual([]);
    expect(searchSettings('hunter2', config, opts)).toEqual([]);
    expect(searchSettings('access phrase', config, opts)[0].entry.id).toBe('plugin.p1.phrase');
    const byValue = searchSettings('quokka', config, opts).map((h) => h.entry.id);
    expect(byValue).toContain('plugin.p1.relay');
    expect(searchSettings('thorough', config, opts).map((h) => h.entry.id)).toContain('plugin.p1.mode');
  });

  it('skips disabled plugins, plugins without settings and failing plugins', async () => {
    const a = {
      list: vi.fn().mockResolvedValue([app('off', 'Off', false), app('none', 'None'), app('bad', 'Bad'), app('ok', 'Ok')]),
      getSettings: vi.fn(async (id: string) => {
        if (id === 'bad') throw new Error('x');
        if (id === 'none') return { descriptors: {}, values: {} } as PluginSettingsSnapshot;
        return snap();
      })
    };
    await prefetchPluginSettings(a);
    const ids = new Set(pluginSettingsSearchProvider(config).map((e) => e.id.split('.')[1]));
    expect([...ids]).toEqual(['ok']);
    expect(a.getSettings).not.toHaveBeenCalledWith('off');
  });

  it('survives a failing list and shares one in-flight request', async () => {
    await prefetchPluginSettings({ list: vi.fn().mockRejectedValue(new Error('x')), getSettings: vi.fn() });
    expect(pluginSettingsSearchProvider(config)).toEqual([]);
    const a = api();
    await Promise.all([prefetchPluginSettings(a), prefetchPluginSettings(a)]);
    expect(a.list).toHaveBeenCalledTimes(1);
  });

  it('caches for the session and refreshes values only after the TTL', async () => {
    const a = api();
    let t = 1_000;
    await prefetchPluginSettings(a, () => t);
    await prefetchPluginSettings(a, () => t + 1);
    expect(a.getSettings).toHaveBeenCalledTimes(1);
    t += PLUGIN_VALUES_TTL_MS + 1;
    a.getSettings.mockResolvedValue({ ...snap(), values: { relay: 'https://new.test' } });
    await prefetchPluginSettings(a, () => t);
    expect(a.getSettings).toHaveBeenCalledTimes(2);
    const relay = pluginSettingsSearchProvider(config).find((e) => e.id === 'plugin.p1.relay')!;
    expect(relay.value?.(config)).toBe('https://new.test');
  });

  it('indexes live settingsSection slots and falls back to the plugin id as the name', () => {
    slots.sections = [
      { pluginId: 'p9', id: 's', title: 'Custom panel', description: 'Panel text' },
      { pluginId: 'p9', id: 'blank' }
    ];
    const entries = pluginSettingsSearchProvider(config) as DeepLinkedSettingsEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: 'plugin.p9.section.s', label: 'Custom panel', help: 'Panel text', section: 'Plugins › p9' });
    expect(entries[0].href.endsWith('#plugin-configure')).toBe(true);
    slots.sections = [{ pluginId: 'p9', id: 's', description: 'Only text' }];
    expect((pluginSettingsSearchProvider(config)[0]).label).toBe('p9');
  });

  it('registers once, bumps the sources version when new data lands, and disposes', async () => {
    const before = getSettingsSearchProviders();
    const reg = registerPluginSettingsProvider(api());
    const registered = getSettingsSearchProviders();
    expect(registered).toContain(pluginSettingsSearchProvider);
    const v0 = getSettingsSearchSourcesVersion();
    await reg.prefetch();
    expect(getSettingsSearchSourcesVersion()).toBeGreaterThan(v0);
    expect(getSettingsSearchProviders()).toBe(registered);
    reg.dispose();
    expect(getSettingsSearchProviders()).toEqual(before);
  });

  it('asks the server to omit secret values (they never reach the renderer for search)', async () => {
    const a = api();
    await prefetchPluginSettings(a);
    expect(a.getSettings).toHaveBeenCalled();
    for (const call of (a.getSettings as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1]).toEqual({ omitSecrets: true });
    }
  });

  it('evicts plugins that are no longer enabled', async () => {
    const a = api();
    await prefetchPluginSettings(a);
    expect(pluginSettingsSearchProvider(config).length).toBeGreaterThan(0);
    const v0 = getSettingsSearchSourcesVersion();
    await prefetchPluginSettings({ list: vi.fn().mockResolvedValue([]), getSettings: vi.fn() });
    expect(pluginSettingsSearchProvider(config).filter((e) => e.id.startsWith('plugin.') && !e.id.includes('.section.'))).toEqual([]);
    expect(getSettingsSearchSourcesVersion()).toBeGreaterThan(v0);
  });

  it('builds a deep link from the route helper', () => {
    expect(pluginSettingHref('x y', 'A&B')).toContain(`${PLUGIN_SETTING_PARAM}=A%26B#plugin-configure`);
  });
});

describe('ExtensionsHub revealPluginSetting', () => {
  const mount = () => {
    document.body.innerHTML = `
      <section id="plugin-configure">
        <div class="plugin-setting-row"><input aria-label="Relay endpoint" /></div>
        <div class="plugin-setting-row"><input aria-label="Other" /></div>
      </section>`;
    Element.prototype.scrollIntoView = vi.fn();
  };

  it('flashes and focuses the matching row once it mounts', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<section id="plugin-configure"></section>';
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => window.setTimeout(cb, 16));
    vi.stubGlobal('cancelAnimationFrame', (n: number) => window.clearTimeout(n));
    revealPluginSetting('Relay endpoint');
    vi.advanceTimersByTime(100);
    mount();
    vi.advanceTimersByTime(40);
    const rows = document.querySelectorAll('.plugin-setting-row');
    expect(rows[0].classList.contains('settings-search-flash')).toBe(true);
    expect(rows[1].classList.contains('settings-search-flash')).toBe(false);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Relay endpoint');
    vi.unstubAllGlobals();
  });

  it('stops retrying after 2 s and on cancel', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => window.setTimeout(cb, 16));
    vi.stubGlobal('cancelAnimationFrame', (n: number) => window.clearTimeout(n));
    document.body.innerHTML = '<section id="plugin-configure"></section>';
    const cancel = revealPluginSetting('Missing');
    vi.advanceTimersByTime(2_500);
    expect(vi.getTimerCount()).toBe(0);
    const again = revealPluginSetting('Missing');
    again();
    cancel();
    expect(vi.getTimerCount()).toBe(0);
    vi.unstubAllGlobals();
  });
});
