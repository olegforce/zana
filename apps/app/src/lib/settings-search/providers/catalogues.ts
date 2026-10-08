import { usePersonas, useTeams } from '../../../stores/live.js';
import { notifySettingsSearchSourcesChanged, registerSettingsSearchProvider } from '../registry';
import type { SettingsSearchEntry, SettingsSearchProvider } from '../types';

/** Row target for one persona or squad (rendered on its list row in PersonasView / SquadsView). */
export const personaSearchId = (id: string) => `personas.persona.${id}`;
export const squadSearchId = (id: string) => `squads.squad.${id}`;

/**
 * Persona and Squad names + descriptions from the stores the renderer already
 * keeps in sync. Squads are `Team` records in the store.
 */
export const cataloguesSearchProvider: SettingsSearchProvider = () => {
  const out: SettingsSearchEntry[] = [];
  for (const persona of usePersonas.getState().personas) {
    out.push({
      id: personaSearchId(persona.id),
      section: 'personas',
      label: persona.name,
      help: persona.description,
      keywords: ['persona', 'launch profile'],
      kind: 'setting'
    });
  }
  for (const team of useTeams.getState().teams) {
    out.push({
      id: squadSearchId(team.id),
      section: 'squads',
      label: team.name,
      help: team.description,
      keywords: ['squad', 'team', 'multi-agent'],
      kind: 'setting'
    });
  }
  return out;
};

/**
 * Register the provider and bump the sources version when the persona or squad
 * lists change, so the corpus picks up renamed or new entries. The returned
 * function releases both subscriptions (Rule 3).
 */
export function registerCataloguesSearchProvider(): () => void {
  const off = registerSettingsSearchProvider(cataloguesSearchProvider);
  const stopPersonas = usePersonas.subscribe((state, prev) => {
    if (state.personas !== prev.personas) notifySettingsSearchSourcesChanged();
  });
  const stopTeams = useTeams.subscribe((state, prev) => {
    if (state.teams !== prev.teams) notifySettingsSearchSourcesChanged();
  });
  return () => {
    stopPersonas();
    stopTeams();
    off();
  };
}
