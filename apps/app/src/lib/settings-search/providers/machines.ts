import { registerSettingsSearchProvider } from '../registry';
import type { SettingsSearchEntry, SettingsSearchProvider } from '../types';

/**
 * Paired machines: names and hostnames from the snapshot the renderer already
 * holds. A result opens the Machines page and scrolls to its machines block
 * (a `subsection` entry is a plain anchor jump).
 */
export const machinesSearchProvider: SettingsSearchProvider = (snapshot) => {
  const seen = new Map<string, number>();
  return (snapshot.machines ?? []).flatMap((machine): SettingsSearchEntry[] => {
    const name = machine.name?.trim();
    if (!name) return [];
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'machine';
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    const host = machine.host?.trim();
    return [
      {
        id: `machines.machine.${slug}${count ? `-${count}` : ''}`,
        section: 'machines',
        anchor: 'machines',
        label: name,
        help: host ? `Paired machine. Host: ${host}` : 'Paired machine.',
        keywords: host ? [host, 'machine', 'host'] : ['machine', 'host'],
        kind: 'subsection'
      }
    ];
  });
};

export function registerMachinesSearchProvider(): () => void {
  return registerSettingsSearchProvider(machinesSearchProvider);
}
