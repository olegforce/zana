import { SETTINGS_GROUPS, SETTINGS_SECTIONS, SETTINGS_SUBSECTIONS } from '@/views/settings/settings-navigation';
import type { SettingsSearchEntry, SettingsSearchProvider } from './types';

// Lazy-load constraint: this module (and everything under settings-search/) must
// never import a settings VIEW module. settings-navigation.ts is the light nav
// registry the rail already depends on.

type EntryModule = { default?: readonly SettingsSearchEntry[]; entries?: readonly SettingsSearchEntry[] };

/** Flatten glob-collected page modules (`default` or `entries` export) in path order. */
export function collectEntryModules(modules: Record<string, EntryModule>): SettingsSearchEntry[] {
  const out: SettingsSearchEntry[] = [];
  for (const path of Object.keys(modules).sort()) {
    const mod = modules[path];
    out.push(...(mod.entries ?? mod.default ?? []));
  }
  return out;
}

/** Section + subsection entries derived from the nav registry, never duplicated. */
export function deriveNavEntries(): SettingsSearchEntry[] {
  const groupLabel = new Map(SETTINGS_GROUPS.map((g) => [g.id as string, g.label]));
  const out: SettingsSearchEntry[] = [];
  for (const section of SETTINGS_SECTIONS) {
    out.push({
      id: `${section.id}.section`,
      section: section.id,
      label: section.label,
      help: section.desc,
      keywords: [groupLabel.get(section.group) ?? section.group],
      kind: 'section'
    });
    for (const sub of SETTINGS_SUBSECTIONS[section.id] ?? []) {
      out.push({
        id: `${section.id}.${sub.id}`,
        section: section.id,
        anchor: sub.id,
        label: sub.label,
        kind: 'subsection'
      });
    }
  }
  return out;
}

// Later page units only ADD files under ./entries/; nothing else is edited.
const pageModules = import.meta.glob<EntryModule>('./entries/*.ts', { eager: true });

let staticEntries: readonly SettingsSearchEntry[] | undefined;

/** Derived nav entries followed by every `entries/*.ts` page file. Stable identity. */
export function getStaticEntries(): readonly SettingsSearchEntry[] {
  staticEntries ??= [...deriveNavEntries(), ...collectEntryModules(pageModules)];
  return staticEntries;
}

let providers: readonly SettingsSearchProvider[] = [];

/** Register a runtime source. Returns an unregister function (release on shutdown). */
export function registerSettingsSearchProvider(provider: SettingsSearchProvider): () => void {
  providers = [...providers, provider];
  return () => {
    providers = providers.filter((p) => p !== provider);
  };
}

/** New array identity on every (un)registration: the corpus cache keys on it. */
export function getSettingsSearchProviders(): readonly SettingsSearchProvider[] {
  return providers;
}
