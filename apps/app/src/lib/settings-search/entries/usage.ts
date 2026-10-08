import type { SettingsSearchEntry } from '../types';

// The Usage page renders no settings-row primitives (Section/Field/...): its text is
// a catalogue UI, and the page itself is reachable through the derived section
// entry. Names and descriptions arrive from a runtime provider in another unit.
// Page-text entries are added here once the page grows searchable rows.
export const entries: readonly SettingsSearchEntry[] = [];

export default entries;
