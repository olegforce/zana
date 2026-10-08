import { createElement } from 'react';
import { Settings } from 'lucide-react';
import type { PaletteItem } from '@/components/palette/buildItems';
import { searchSettings } from './index';
import { openSettingsHit } from './links';
import { ensureSettingsSearchProviders } from './runtime';
import type { SettingsSearchHit, SettingsValueSnapshot } from './types';

/** Rows the ⌘P "All" scope shows for Settings; the rest sit behind the overflow link. */
export const PALETTE_SETTINGS_LANDING_CAP = 5;

export { settingsHitPath } from './links';

/** Breadcrumb, plus the current value when the query hit it. */
export function settingsHitHint(hit: SettingsSearchHit): string {
  return hit.matchedValue ? `${hit.breadcrumb} · Current: ${hit.matchedValue}` : hit.breadcrumb;
}

/**
 * Palette rows for a Settings query, in engine rank order. The palette calls
 * the Settings engine directly: help text is never flattened into
 * `PaletteItem.keywords`. Keys are `settings:<entryId>` so recents attach to
 * the entry. An empty query yields no rows.
 */
export function settingsPaletteItems(
  query: string,
  snapshot: SettingsValueSnapshot,
  options: {
    limit: number;
    projectId?: string | null;
    navigate: (path: string) => void;
    /** Store setter for the pending reveal target (same contract as the Settings rail). */
    setAnchor: (anchor: string | null) => void;
  }
): PaletteItem[] {
  if (!query.trim()) return [];
  ensureSettingsSearchProviders();
  return searchSettings(query, snapshot, { limit: options.limit }).map((hit) => ({
    key: `settings:${hit.entry.id}`,
    icon: createElement(Settings, { size: 14 }),
    label: hit.entry.label,
    hint: settingsHitHint(hit),
    category: 'Settings',
    source: 'core',
    run: () => openSettingsHit(hit, { projectId: options.projectId, navigate: options.navigate, setAnchor: options.setAnchor })
  }));
}
