import { usePersonas, useTeams } from '../../../stores/live.js';
import { registerSettingsSearchProvider } from '../registry';
import type { SettingsSearchEntry, SettingsSearchProvider } from '../types';

/**
 * Persona and Squad names + descriptions from the stores the renderer already
 * keeps in sync. Squads are `Team` records in the store.
 */
export const cataloguesSearchProvider: SettingsSearchProvider = () => {
  const out: SettingsSearchEntry[] = [];
  for (const persona of usePersonas.getState().personas) {
    out.push({
      id: `personas.persona.${persona.id}`,
      section: 'personas',
      label: persona.name,
      help: persona.description,
      keywords: ['persona', 'launch profile'],
      kind: 'setting'
    });
  }
  for (const team of useTeams.getState().teams) {
    out.push({
      id: `squads.squad.${team.id}`,
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
 * Register the provider and re-register on every store change so the corpus
 * (cached on provider-set identity) picks up renamed or new personas and squads.
 * The returned function releases both subscriptions (Rule 3).
 */
export function registerCataloguesSearchProvider(): () => void {
  let off = registerSettingsSearchProvider(cataloguesSearchProvider);
  const invalidate = () => {
    off();
    off = registerSettingsSearchProvider(cataloguesSearchProvider);
  };
  const stopPersonas = usePersonas.subscribe(invalidate);
  const stopTeams = useTeams.subscribe(invalidate);
  return () => {
    stopPersonas();
    stopTeams();
    off();
  };
}
