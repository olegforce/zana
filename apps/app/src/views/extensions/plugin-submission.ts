import { createPluginComposeNavigation } from '../../lib/compose-prompt-seed.js';
import type { HubRow } from './installed-plugins.js';

/** Catalog and built-in installs already have a publisher-owned listing. */
export function canSubmitPlugin(row: HubRow): boolean {
  if (row.plugin) return row.plugin.provenance === 'direct';
  return row.entry?.source === 'local' || row.entry?.source === 'git';
}

export function pluginSubmissionNavigation(row: HubRow, projectId?: string | null) {
  const identity = JSON.stringify({ id: row.module.id, name: row.module.title });
  return createPluginComposeNavigation({
    projectId,
    prompt: `Use the submit-a-plugin skill to prepare and submit this installed Zana plugin to a marketplace:

${identity}

Resolve its source directory from the installed plugin registry using the plugin id. The current project may differ from the plugin source. Check the configured marketplaces and their current repository instructions; confirm the target marketplace and public or internal visibility when unclear. Validate the plugin, verify a distributable Git or npm source, and prepare the listing, icon, overview, and any supported screenshots. Complete local preparation before asking for approval of release changes that have not already been authorized. Open the marketplace pull request and return its URL, source, and validation results. Do not change the installed plugin's settings or account data.`
  });
}
