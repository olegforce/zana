import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { readBooleanPreference, subscribeBooleanPreference, writeBooleanPreference } from '../../lib/boolean-preference.js';

export const HELP_ENABLED_KEY = 'zcc.contextualHelp.enabled';

interface HelpState {
  enabled: boolean;
  activeSurface: string | null;
  setEnabled: (enabled: boolean) => void;
  explore: (surface: string) => void;
  finish: (surface: string) => void;
}
const HelpContext = createContext<HelpState | null>(null);

function restoreHelpFocus() {
  if (!document.activeElement?.closest('[data-contextual-help-ui]')) return;
  const toggles = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-help-toggle]'));
  // On phones the Help toggle lives in a closed drawer; focus its entry point.
  const target = toggles.find((toggle) => toggle.getBoundingClientRect().width > 0)
    ?? document.querySelector<HTMLButtonElement>('.sidebar-trigger-overlay .sidebar-expand-control');
  target?.focus();
}

/** The saved preference is device-local; exploration lasts only on the current page. */
export function HelpProvider({ children, pageKey = '' }: { children: ReactNode; pageKey?: string }) {
  const [enabled, updateEnabled] = useState(() => readBooleanPreference(HELP_ENABLED_KEY, true));
  const lastStoredEnabled = useRef(enabled);
  const [exploration, setExploration] = useState<{ page: string; surface: string } | null>(null);
  useEffect(() => subscribeBooleanPreference(() => {
    const next = readBooleanPreference(HELP_ENABLED_KEY, true);
    // Other settings emit this event too. An unchanged saved value must not
    // undo the session choice when storage rejected our last write.
    if (next === lastStoredEnabled.current) return;
    lastStoredEnabled.current = next;
    if (!next) { restoreHelpFocus(); setExploration(null); }
    updateEnabled(next);
  }), []);
  useEffect(() => { setExploration(null); }, [pageKey]);
  const setEnabled = useCallback((next: boolean) => {
    if (!next) restoreHelpFocus();
    setExploration(null);
    writeBooleanPreference(HELP_ENABLED_KEY, next);
    // Storage may be unavailable; the toggle still works for this session.
    updateEnabled(next);
  }, []);
  const explore = useCallback((surface: string) => setExploration({ page: pageKey, surface }), [pageKey]);
  const finish = useCallback((surface: string) => {
    setExploration((current) => current?.surface === surface ? null : current);
  }, []);
  const activeSurface = enabled && exploration?.page === pageKey ? exploration.surface : null;
  const value = useMemo(() => ({ enabled, activeSurface, setEnabled, explore, finish }),
    [enabled, activeSurface, setEnabled, explore, finish]);
  return <HelpContext.Provider value={value}>{children}</HelpContext.Provider>;
}

export function useHelp() {
  const value = useContext(HelpContext);
  if (!value) throw new Error('Contextual help must be inside HelpProvider');
  return value;
}
