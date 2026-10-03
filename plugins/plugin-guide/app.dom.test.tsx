// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { collectTestPluginApp } from '@zana-ai/zcc-plugin-sdk/testing/app';
const navigate = vi.hoisted(() => vi.fn());
vi.mock('@zana-ai/zcc-plugin-sdk/app', async importOriginal => ({
  ...await importOriginal<object>(), useZccNavigate: () => ({ toPluginPanel: navigate })
}));
vi.mock('./src/product-map.js', () => ({ ProductMap: (props: any) => <>
  <a href={props.pluginPageHref('Agent City') ?? undefined}>Agent City listing</a>
  <a href={props.pluginPageHref('Unknown plugin') ?? undefined}>Unknown listing</a>
  <button onClick={() => props.onSlideChange('project-shell')}>Choose project map</button>
</> }));
import app from './app.tsx';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('links Agent City to its installed listing and preserves slide navigation', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ apps: [{ id: 'agent-city' }] }))));
  const Page = collectTestPluginApp(app, 'plugin-guide').navPanels[0].component;
  render(<Page subPath="project-shell" />);
  await waitFor(() => expect(screen.getByText('Agent City listing').getAttribute('href')).toBe('/extensions/plugins/agent-city'));
  expect(screen.getByText('Unknown listing').getAttribute('href')).toBeNull();
  fireEvent.click(screen.getByText('Choose project map'));
  expect(navigate).toHaveBeenCalledWith('plugin-guide', { subPath: 'project-shell', replace: true });
});
