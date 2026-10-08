import { getSettingsRoutePath, getSettingsTabRoutePath } from '../route-paths.js';
import type { SettingsSearchHit } from './types';

/**
 * Where a result opens. Entries that live outside /settings (plugin settings
 * on the plugin page) carry their own `href`; everything else rides the entry
 * id in the URL hash of its Settings page.
 */
export function settingsHitPath(hit: SettingsSearchHit, projectId?: string | null): string {
  const { entry } = hit;
  if (entry.href) return entry.href;
  const anchor = entry.kind === 'section' ? undefined : entry.id;
  if (entry.section === 'project') {
    return getSettingsTabRoutePath('project', projectId) + (anchor ? `#${encodeURIComponent(anchor)}` : '');
  }
  return getSettingsRoutePath(entry.section, anchor);
}
