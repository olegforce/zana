import { createElement } from 'react';
import { Settings } from 'lucide-react';
import type { PaletteItem } from '@/components/palette/buildItems';
import { getSettingsRoutePath, getSettingsTabRoutePath } from '../route-paths.js';
import { searchSettings } from './index';
import type { SettingsSearchHit, SettingsValueSnapshot } from './types';

/** Rows the ⌘P "All" scope shows for Settings; the rest sit behind the overflow link. */
export const PALETTE_SETTINGS_LANDING_CAP = 5;

/** Same deep link the Settings rail uses: the entry id rides in the URL hash. */
export function settingsHitPath(hit: SettingsSearchHit, projectId?: string | null): string {
  const { entry } = hit;
  const anchor = entry.kind === 'section' ? undefined : entry.id;
  if (entry.section === 'project') {
    return getSettingsTabRoutePath('project', projectId) + (anchor ? `#${encodeURIComponent(anchor)}` : '');
  }
  return getSettingsRoutePath(entry.section, anchor);
}

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
  options: { limit: number; projectId?: string | null; navigate: (path: string) => void }
): PaletteItem[] {
  if (!query.trim()) return [];
  return searchSettings(query, snapshot, { limit: options.limit }).map((hit) => ({
    key: `settings:${hit.entry.id}`,
    icon: createElement(Settings, { size: 14 }),
    label: hit.entry.label,
    hint: settingsHitHint(hit),
    category: 'Settings',
    source: 'core',
    run: () => options.navigate(settingsHitPath(hit, options.projectId))
  }));
}
