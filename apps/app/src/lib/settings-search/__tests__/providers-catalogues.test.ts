import { afterEach, describe, expect, it } from 'vitest';
import type { Persona, Team } from '@zana-ai/zcc-domain/product';
import { usePersonas, useTeams } from '../../../stores/live';
import { searchSettings } from '../index';
import { getSettingsSearchProviders, getSettingsSearchSourcesVersion } from '../registry';
import { cataloguesSearchProvider, registerCataloguesSearchProvider } from '../providers/catalogues';

const config = { config: {} as never };
const persona = (id: string, name: string, description?: string) => ({ id, name, description }) as Persona;
const team = (id: string, name: string, description?: string) => ({ id, name, description, slots: [] }) as unknown as Team;

afterEach(() => {
  usePersonas.setState({ personas: [] });
  useTeams.setState({ teams: [] });
});

describe('catalogues provider', () => {
  it('maps personas and squads to their pages', () => {
    usePersonas.setState({ personas: [persona('builtin:rev', 'Reviewer', 'Reviews diffs')] });
    useTeams.setState({ teams: [team('t1', 'Release squad', 'Ships releases')] });
    const entries = cataloguesSearchProvider(config);
    expect(entries.map((e) => [e.id, e.section])).toEqual([
      ['personas.persona.builtin:rev', 'personas'],
      ['squads.squad.t1', 'squads']
    ]);
    expect(entries[0]).toMatchObject({ label: 'Reviewer', help: 'Reviews diffs' });
  });

  it('is found by description and ranks under the right page', () => {
    usePersonas.setState({ personas: [persona('p', 'Triager', 'Sorts incoming bug reports')] });
    const hits = searchSettings('bug reports', config, { entries: [], providers: [cataloguesSearchProvider] });
    expect(hits[0].entry.id).toBe('personas.persona.p');
    expect(hits[0].breadcrumb).toBe('Personas');
  });

  it('is empty with empty stores', () => {
    expect(cataloguesSearchProvider(config)).toEqual([]);
  });

  it('bumps the sources version on list changes (not other store churn) and releases subscriptions on dispose', () => {
    const before = getSettingsSearchProviders();
    const dispose = registerCataloguesSearchProvider();
    const registered = getSettingsSearchProviders();
    expect(registered).toContain(cataloguesSearchProvider);
    const v0 = getSettingsSearchSourcesVersion();
    usePersonas.setState({ personas: [persona('n', 'New one')] });
    const v1 = getSettingsSearchSourcesVersion();
    expect(v1).toBeGreaterThan(v0);
    useTeams.setState({ teams: [team('x', 'Squad X')] });
    expect(getSettingsSearchSourcesVersion()).toBeGreaterThan(v1);
    // Registered once: data changes move the version, not the provider set.
    expect(getSettingsSearchProviders()).toBe(registered);
    const v2 = getSettingsSearchSourcesVersion();
    usePersonas.setState({ ...usePersonas.getState() }); // same list identity
    expect(getSettingsSearchSourcesVersion()).toBe(v2);
    dispose();
    expect(getSettingsSearchProviders()).toEqual(before);
    const afterDispose = getSettingsSearchSourcesVersion();
    usePersonas.setState({ personas: [] });
    expect(getSettingsSearchSourcesVersion()).toBe(afterDispose);
  });

  it('gives each persona and squad a row target the list renders', () => {
    usePersonas.setState({ personas: [persona('p1', 'Reviewer')] });
    useTeams.setState({ teams: [team('t1', 'Ship it')] });
    const ids = cataloguesSearchProvider(config).map((e) => e.id);
    expect(ids).toEqual(['personas.persona.p1', 'squads.squad.t1']);
  });
});
