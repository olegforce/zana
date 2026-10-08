import { afterEach, describe, expect, it } from 'vitest';
import type { Persona, Team } from '@zana-ai/zcc-domain/product';
import { usePersonas, useTeams } from '../../../stores/live';
import { searchSettings } from '../index';
import { getSettingsSearchProviders } from '../registry';
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

  it('re-registers on store changes and releases subscriptions on dispose', () => {
    const before = getSettingsSearchProviders();
    const dispose = registerCataloguesSearchProvider();
    const first = getSettingsSearchProviders();
    usePersonas.setState({ personas: [persona('n', 'New one')] });
    const second = getSettingsSearchProviders();
    expect(second).not.toBe(first);
    useTeams.setState({ teams: [team('x', 'Squad X')] });
    expect(getSettingsSearchProviders()).not.toBe(second);
    dispose();
    expect(getSettingsSearchProviders()).toEqual(before);
    const afterDispose = getSettingsSearchProviders();
    usePersonas.setState({ personas: [] });
    expect(getSettingsSearchProviders()).toBe(afterDispose);
  });
});
