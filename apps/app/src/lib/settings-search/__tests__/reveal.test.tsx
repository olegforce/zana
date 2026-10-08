// @vitest-environment happy-dom
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLASH_CLASS, FLASH_MS, REVEAL_WAIT_MS, RevealContext, findAnchor, findTarget, revealElement, useRevealAdvanced, useSettingsTargetReveal } from '../reveal';
import { registerSettingsSearchProvider } from '../registry';
import type { SettingsSearchEntry } from '../types';

const snapshot = { config: {} as never };
const setAnchor = vi.fn();
let scrolled: Array<{ id: string; opts: unknown }> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: Element, opts?: unknown) { scrolled.push({ id: this.id || this.getAttribute('data-settings-target') || '', opts }); };
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => window.setTimeout(cb, 16));
  vi.stubGlobal('cancelAnimationFrame', (n: number) => window.clearTimeout(n));
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ROW: SettingsSearchEntry = { id: 'agents.row', section: 'agents', label: 'Row', kind: 'setting' };
const GATED: SettingsSearchEntry = { id: 'agents.gated', section: 'agents', anchor: 'agent-heartbeat', label: 'Gated', kind: 'setting' };
let offProvider: () => void;
beforeEach(() => { offProvider = registerSettingsSearchProvider(() => [ROW, GATED]); });
afterEach(() => offProvider());

const mountRow = (id: string) => {
  const row = document.createElement('div');
  row.setAttribute('data-settings-target', id);
  row.innerHTML = '<span>x</span><button>go</button>';
  document.body.appendChild(row);
  return row;
};
const run = (anchor: string | null, extra: Partial<Parameters<typeof useSettingsTargetReveal>[0]> = {}) =>
  renderHook((p: { anchor: string | null }) => useSettingsTargetReveal({ tab: 'agents', anchor: p.anchor, snapshot, setAnchor, ...extra }), { initialProps: { anchor } });

describe('revealElement', () => {
  it('scrolls to center, flashes for 1.2s and focuses the first control', () => {
    const row = mountRow('a');
    revealElement(row);
    expect(scrolled[0].opts).toEqual({ behavior: 'smooth', block: 'center' });
    expect(row.classList.contains(FLASH_CLASS)).toBe(true);
    expect(document.activeElement?.tagName).toBe('BUTTON');
    vi.advanceTimersByTime(FLASH_MS);
    expect(row.classList.contains(FLASH_CLASS)).toBe(false);
  });
  it('focuses the target itself when it is the control (ToggleSwitch)', () => {
    const btn = document.createElement('button');
    btn.setAttribute('data-settings-target', 'toggle');
    document.body.appendChild(btn);
    revealElement(btn);
    expect(document.activeElement).toBe(btn);
  });
  it('skips smooth scrolling under prefers-reduced-motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    revealElement(mountRow('b'));
    expect(scrolled[0].opts).toMatchObject({ behavior: 'auto' });
  });
  it('finds targets and anchors by id', () => {
    mountRow('x.y');
    expect(findTarget('x.y')).not.toBeNull();
    expect(findAnchor('nope')).toBeNull();
  });
});

describe('useSettingsTargetReveal', () => {
  it('does nothing without an anchor', () => {
    run(null);
    expect(setAnchor).not.toHaveBeenCalled();
  });

  it('reveals a row that is already mounted and clears the anchor', () => {
    const row = mountRow('agents.row');
    run('agents.row');
    expect(row.classList.contains(FLASH_CLASS)).toBe(true);
    expect(setAnchor).toHaveBeenCalledWith(null);
  });

  it('retries until the row mounts', () => {
    run('agents.row');
    vi.advanceTimersByTime(300);
    expect(setAnchor).not.toHaveBeenCalled();
    const row = mountRow('agents.row');
    act(() => { vi.advanceTimersByTime(40); });
    expect(row.classList.contains(FLASH_CLASS)).toBe(true);
    expect(setAnchor).toHaveBeenCalledWith(null);
  });

  it('falls back to the section anchor when the row never appears (gated off)', () => {
    const sec = document.createElement('section');
    sec.id = 'settings-anchor-agent-heartbeat';
    document.body.appendChild(sec);
    const { rerender } = run('agents.gated');
    expect(setAnchor).toHaveBeenCalledWith('agent-heartbeat');
    setAnchor.mockClear();
    rerender({ anchor: 'agent-heartbeat' });
    act(() => { vi.advanceTimersByTime(REVEAL_WAIT_MS + 100); });
    expect(scrolled.map((s) => s.id)).toEqual(['settings-anchor-agent-heartbeat']);
    expect(setAnchor).toHaveBeenCalledWith(null);
  });

  it('gives up quietly when neither row nor anchor exists', () => {
    run('agents.row');
    act(() => { vi.advanceTimersByTime(REVEAL_WAIT_MS + 100); });
    expect(scrolled).toEqual([]);
    expect(setAnchor).toHaveBeenCalledWith(null);
  });

  it('scrolls plain section anchors (and waits for them to mount)', () => {
    run('appearance');
    vi.advanceTimersByTime(100);
    expect(setAnchor).not.toHaveBeenCalled();
    const sec = document.createElement('section');
    sec.id = 'settings-anchor-appearance';
    document.body.appendChild(sec);
    act(() => { vi.advanceTimersByTime(40); });
    expect(scrolled[0]).toMatchObject({ id: 'settings-anchor-appearance', opts: { behavior: 'smooth', block: 'start' } });
    expect(setAnchor).toHaveBeenCalledWith(null);
  });

  it('gives up on a plain anchor that never mounts', () => {
    run('ghost');
    act(() => { vi.advanceTimersByTime(REVEAL_WAIT_MS + 100); });
    expect(setAnchor).toHaveBeenCalledWith(null);
    expect(scrolled).toEqual([]);
  });

  it('switches the Harness tab through the entry anchor, then reveals the row', () => {
    const entry: SettingsSearchEntry = { id: 'harness.legacy-model', section: 'harness', anchor: 'harness-legacy', label: 'Model', kind: 'setting' };
    const off = registerSettingsSearchProvider(() => [entry]);
    const row = mountRow('harness.legacy-model');
    const { rerender } = run('harness.legacy-model');
    expect(setAnchor).toHaveBeenCalledWith('harness-legacy');
    expect(row.classList.contains(FLASH_CLASS)).toBe(false);
    setAnchor.mockClear();
    rerender({ anchor: 'harness-legacy' });
    expect(row.classList.contains(FLASH_CLASS)).toBe(true);
    expect(setAnchor).toHaveBeenCalledWith(null);
    off();
  });

  it('publishes reveal:advanced through RevealContext', () => {
    const off = registerSettingsSearchProvider(() => [{ id: 'editor.adv', section: 'editor', label: 'Adv', kind: 'setting', reveal: 'advanced' }]);
    function Probe() { return <span data-testid="adv">{String(useRevealAdvanced())}</span>; }
    function Host() {
      const state = useSettingsTargetReveal({ tab: 'editor', anchor: 'editor.adv', snapshot, setAnchor });
      return <RevealContext.Provider value={state}><Probe /></RevealContext.Provider>;
    }
    const { getByTestId } = render(<Host />);
    expect(getByTestId('adv').textContent).toBe('true');
    off();
  });

  it('treats section and subsection entries as plain anchors', () => {
    const a = run('agents.section');
    expect(setAnchor).toHaveBeenCalledWith(null);
    setAnchor.mockClear();
    a.unmount();
    const sec = document.createElement('section');
    sec.id = 'settings-anchor-agent-heartbeat';
    document.body.appendChild(sec);
    const { rerender } = run('agents.agent-heartbeat');
    rerender({ anchor: 'agent-heartbeat' });
    expect(scrolled.map((s) => s.id)).toContain('settings-anchor-agent-heartbeat');
  });

  it('cancels a pending poll on unmount', () => {
    const { unmount } = run('agents.row');
    unmount();
    act(() => { vi.advanceTimersByTime(REVEAL_WAIT_MS + 100); });
    expect(setAnchor).not.toHaveBeenCalled();
  });

  it('useRevealAdvanced is false outside a provider', () => {
    expect(renderHook(() => useRevealAdvanced()).result.current).toBe(false);
  });
});

describe('isShown / hidden containers', () => {
  it('reports hidden and display:none ancestors', async () => {
    const { isShown } = await import('../reveal');
    const wrap = document.createElement('div');
    const row = document.createElement('div');
    wrap.appendChild(row);
    document.body.appendChild(wrap);
    expect(isShown(row)).toBe(true);
    wrap.hidden = true;
    expect(isShown(row)).toBe(false);
    wrap.hidden = false;
    wrap.style.display = 'none';
    expect(isShown(row)).toBe(false);
  });

  it('waits for a target in a hidden tab panel to be shown before revealing', () => {
    const panel = document.createElement('div');
    panel.hidden = true;
    document.body.appendChild(panel);
    const row = document.createElement('div');
    row.setAttribute('data-settings-target', 'agents.row');
    panel.appendChild(row);
    run('agents.row');
    vi.advanceTimersByTime(200);
    expect(row.classList.contains(FLASH_CLASS)).toBe(false);
    expect(setAnchor).not.toHaveBeenCalled();
    panel.hidden = false;
    vi.advanceTimersByTime(100);
    expect(row.classList.contains(FLASH_CLASS)).toBe(true);
    expect(setAnchor).toHaveBeenCalledWith(null);
  });
});
