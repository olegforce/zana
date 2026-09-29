/** @vitest-environment happy-dom */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useInAppBrowserPanel } from './useInAppBrowserPanel.js';
import { OPEN_IN_APP_BROWSER_EVENT } from '../../../lib/in-app-browser-link-preference.js';

const mocks = vi.hoisted(() => ({
  scoped: new Set<(request: { tabId: string; url: string }) => void>(),
  legacy: new Set<(request: { url: string }) => void>(),
  automation: new Set<(request: { threadId: string; tabId: string; targetId: string; url: string }) => void>(),
  product: new Set<(request: { threadId?: string; url?: string }) => void>(),
  desktop: true,
  scopedAvailable: true
}));
vi.mock('../../../lib/desktop-browser.js', () => ({
  getDesktopBrowserApi: () => mocks.desktop ? {
    onScopedOpenTab: mocks.scopedAvailable ? (cb: never) => { mocks.scoped.add(cb); return () => mocks.scoped.delete(cb); } : undefined,
    onOpenTab: (cb: never) => { mocks.legacy.add(cb); return () => mocks.legacy.delete(cb); },
    onAutomationOpen: (cb: never) => { mocks.automation.add(cb); return () => mocks.automation.delete(cb); }
  } : null
}));
vi.mock('../../../lib/product-ws.js', () => ({
  subscribeProductEvent: (_type: string, cb: never) => { mocks.product.add(cb); return () => mocks.product.delete(cb); }
}));
afterEach(() => {
  cleanup();
  for (const listeners of [mocks.scoped, mocks.legacy, mocks.automation, mocks.product]) expect(listeners.size).toBe(0);
  mocks.desktop = true;
  mocks.scopedAvailable = true;
  localStorage.clear();
});

function panel(tabId: string) {
  return { state: { tabs: [{ id: tabId, kind: 'browser' as const, title: 'Browser' }] }, addTab: vi.fn() };
}

it('opens native popup requests only in the panel owning the source tab, with current tab membership', () => {
  const first = panel('source-a');
  const other = panel('source-b');
  const view = renderHook(({ current }) => useInAppBrowserPanel('a', current), { initialProps: { current: first } });
  renderHook(() => useInAppBrowserPanel('b', other));
  act(() => { for (const cb of mocks.scoped) cb({ tabId: 'source-a', url: 'https://example.test/child' }); });
  expect(first.addTab).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ url: 'https://example.test/child' }));
  expect(other.addTab).not.toHaveBeenCalled();
  const next = panel('source-c');
  view.rerender({ current: next });
  act(() => { for (const cb of mocks.scoped) cb({ tabId: 'source-a', url: 'https://example.test/old' }); });
  expect(next.addTab).not.toHaveBeenCalled();
  act(() => { for (const cb of mocks.scoped) cb({ tabId: 'source-c', url: 'https://example.test/new' }); });
  expect(next.addTab).toHaveBeenCalledTimes(1);
  expect(mocks.legacy.size).toBe(0);
});

it('keeps automation, product, and link requests scoped and removes listeners on unmount', () => {
  const current = panel('source');
  const view = renderHook(() => useInAppBrowserPanel('a', current));
  act(() => {
    for (const cb of mocks.automation) {
      cb({ threadId: 'other', tabId: 'wrong', targetId: 'target', url: 'https://wrong.test' });
      cb({ threadId: 'a', tabId: 'owned', targetId: 'target', url: '' });
    }
    for (const cb of mocks.product) {
      cb({ threadId: 'a' });
      cb({ threadId: 'other', url: 'https://wrong.test' });
      cb({ threadId: 'a', url: 'https://product.test' });
    }
    window.dispatchEvent(new CustomEvent(OPEN_IN_APP_BROWSER_EVENT));
    window.dispatchEvent(new CustomEvent(OPEN_IN_APP_BROWSER_EVENT, { detail: { ownerId: 'other', url: 'https://wrong.test' } }));
    const event = new CustomEvent(OPEN_IN_APP_BROWSER_EVENT, { cancelable: true, detail: { ownerId: 'a', url: 'https://link.test' } });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
  expect(current.addTab.mock.calls.map(([tab]) => tab.url)).toEqual(['', 'https://product.test', 'https://link.test']);
  view.unmount();
  window.dispatchEvent(new CustomEvent(OPEN_IN_APP_BROWSER_EVENT, { detail: { ownerId: 'a', url: 'https://closed.test' } }));
  expect(current.addTab).toHaveBeenCalledTimes(3);
});

it('supports legacy native events and web-only panels', () => {
  mocks.scopedAvailable = false;
  const current = panel('source');
  const view = renderHook(() => useInAppBrowserPanel('a', current));
  act(() => { for (const cb of mocks.legacy) cb({ url: 'https://legacy.test' }); });
  expect(current.addTab).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ url: 'https://legacy.test' }));
  view.unmount();
  mocks.desktop = false;
  renderHook(() => useInAppBrowserPanel('a', current));
  expect(mocks.legacy.size).toBe(0);
});
