// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
const config = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../lib/app-surface.js', () => ({ hasDesktopBridge: () => true }));
vi.mock('../lib/product-client.js', () => ({ product: new Proxy({}, { get: (_target, group) => new Proxy({}, {
  get: (_target, method) => {
    if (method === 'groups') return { list: async () => [], onChanged: () => () => {} };
    if (group === 'config' && method === 'get') return async () => config.value;
    if (String(method).startsWith('on')) return () => () => {};
    if (method === 'history') return async () => ({ entries: [] });
    if (method === 'getReadState') return async () => ({ readIds: {}, migratedFromLocalStorage: true });
    if (method === 'consumeWhatsNew') return async () => null;
    return async () => [];
  }
}) }) }));
import { useData, useUi } from '../store.js';
afterEach(() => vi.restoreAllMocks());

it.each(['board', 'list', 'flow', 'plugin:city/world', 'invalid', undefined])('hydrates only valid saved Agents views: %s', async preferred => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  config.value = { agentsBoardView: preferred, walkthroughCompleted: true, setupDismissed: true };
  useUi.setState({ agentsBoardView: 'board' });
  await useData.getState().init();
  expect(useData.getState().configLoaded).toBe(true);
  expect(useUi.getState().agentsBoardView).toBe(['board', 'list', 'flow', 'plugin:city/world'].includes(preferred ?? '') ? preferred : 'board');
});
