import type { SettingsSearchEntry } from './types';

/**
 * Entries matching this must not expose a `value` (design 3.7 rule 2). Free-form
 * CLI args and env blocks are included: that is where people paste keys and headers.
 */
export const SECRET_ENTRY_PATTERN =
  /token|secret|password|passphrase|api[-_ ]?key|credential|cookie|auth|private[-_ ]?key|enroll|extra[-_ ]?args|\benv\b/i;

/** Entry id -> reason it is safe to index the value despite matching the pattern. */
export const SECRET_VALUE_ALLOWLIST: Readonly<Record<string, string>> = {};

export function isSecretLooking(entry: Pick<SettingsSearchEntry, 'id' | 'label' | 'anchor'>): boolean {
  return SECRET_ENTRY_PATTERN.test(entry.id) || SECRET_ENTRY_PATTERN.test(entry.label) || SECRET_ENTRY_PATTERN.test(entry.anchor ?? '');
}

/** True when `entry.value` may be read into the corpus. */
export function mayIndexValue(entry: SettingsSearchEntry): boolean {
  if (!entry.value) return false;
  return !isSecretLooking(entry) || Object.hasOwn(SECRET_VALUE_ALLOWLIST, entry.id);
}

/** Guard helper: ids of entries that define `value` on a secret-looking field without an allowlist reason. */
export function findSecretValueViolations(entries: readonly SettingsSearchEntry[]): string[] {
  return entries.filter((e) => e.value && !mayIndexValue(e)).map((e) => e.id);
}
