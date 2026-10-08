import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { buildCorpus } from './corpus';
import { getStaticEntries } from './registry';
import type { SettingsSearchEntry, SettingsValueSnapshot } from './types';

export const REVEAL_WAIT_MS = 2_000;
export const FLASH_MS = 1_200;
export const FLASH_CLASS = 'settings-search-flash';

const FOCUSABLE = 'input:not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface RevealState {
  /** Entry id currently being revealed (null when idle). */
  target: string | null;
  /** Container the target lives in that collapsibles should expand. */
  reveal: SettingsSearchEntry['reveal'] | null;
}

const IDLE: RevealState = { target: null, reveal: null };

/** Collapsibles read this: `useRevealAdvanced()` is true while an `advanced` target is being revealed. */
export const RevealContext = createContext<RevealState>(IDLE);

export function useRevealAdvanced(): boolean {
  return useContext(RevealContext).reveal === 'advanced';
}

export function findTarget(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-settings-target="${CSS.escape(id)}"]`);
}

export function findAnchor(anchor: string): HTMLElement | null {
  return document.getElementById(`settings-anchor-${anchor}`);
}

function lookupEntry(id: string, snapshot: SettingsValueSnapshot): SettingsSearchEntry | undefined {
  return getStaticEntries().find((e) => e.id === id) ?? buildCorpus(snapshot).entries.find((r) => r.entry.id === id)?.entry;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Scroll to, flash (self-removing) and focus a located row. */
export function revealElement(el: HTMLElement): void {
  el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
  el.classList.add(FLASH_CLASS);
  // ToggleSwitch puts the target attribute on the control itself.
  (el.matches(FOCUSABLE) ? el : el.querySelector<HTMLElement>(FOCUSABLE))?.focus({ preventScroll: true });
  window.setTimeout(() => el.classList.remove(FLASH_CLASS), FLASH_MS);
}

interface Args {
  tab: string;
  anchor: string | null;
  snapshot: SettingsValueSnapshot;
  setAnchor: (anchor: string | null) => void;
}

/**
 * Resolve the URL-hash target (an entry id, or a plain section anchor id) once
 * its page has rendered: switch the container (Harness tab through its anchor,
 * `advanced` through RevealContext), retry up to 2 s, scroll to center, flash,
 * focus; fall back to the section anchor, then clear the pending anchor.
 */
export function useSettingsTargetReveal({ tab, anchor, snapshot, setAnchor }: Args): RevealState {
  const [state, setState] = useState<RevealState>(IDLE);
  const pending = useRef<SettingsSearchEntry | null>(null);

  useEffect(() => {
    if (!anchor) return;
    let entry = pending.current?.anchor === anchor ? pending.current : lookupEntry(anchor, snapshot);
    if (entry && entry.id === anchor && entry.anchor && entry.anchor !== anchor) {
      // The page switches its own container (e.g. Harness tab) off the anchor.
      pending.current = entry;
      setAnchor(entry.anchor);
      return;
    }
    pending.current = null;
    if (entry?.kind === 'section') {
      setAnchor(null); // the route already switched pages: nothing to scroll to
      return;
    }

    // Sections/subsections are plain anchor blocks; only settings/actions carry a target row.
    const targetId = entry && entry.kind !== 'subsection' ? entry.id : null;
    const anchorId = entry?.anchor ?? anchor;
    setState({ target: targetId, reveal: entry?.reveal ?? null });
    const started = Date.now();
    let cancelled = false;
    let frame = 0;
    const finish = () => {
      setAnchor(null);
    };
    const attempt = () => {
      if (cancelled) return;
      const row = targetId ? findTarget(targetId) : null;
      if (row) {
        revealElement(row);
        return finish();
      }
      if (Date.now() - started < REVEAL_WAIT_MS) {
        frame = window.requestAnimationFrame(attempt);
        return;
      }
      const section = findAnchor(anchorId);
      if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      finish();
    };
    // Plain section anchors have no target row: scroll as soon as the block mounts.
    const attemptPlain = () => {
      if (cancelled) return;
      const section = findAnchor(anchorId);
      if (section) {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return finish();
      }
      if (Date.now() - started < REVEAL_WAIT_MS) {
        frame = window.requestAnimationFrame(attemptPlain);
        return;
      }
      finish();
    };
    (targetId ? attempt : attemptPlain)();
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
    // snapshot intentionally omitted: config churn must not restart a reveal in flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, tab, setAnchor]);

  return state;
}
