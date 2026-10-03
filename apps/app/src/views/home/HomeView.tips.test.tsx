// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { HomeView } from './HomeView.js';
import { HelpProvider } from '../../components/help/HelpProvider.js';

const mocks = vi.hoisted(() => ({ sections: [] as unknown[], composer: vi.fn() }));
vi.mock('@/components/AuroraGrid', () => ({ AuroraGrid: () => <div /> }));
vi.mock('@/components/HomeAgentComposer', () => ({ HomeAgentComposer: (props: unknown) => {
  mocks.composer(props);
  return <input aria-label="Launcher draft" />;
} }));
vi.mock('@/plugins/PluginNewThreadActions', () => ({ PluginNewThreadActions: () => <button>Plugin action</button> }));
vi.mock('@/plugins/plugin-slots', () => ({
  subscribePluginSlots: () => () => undefined,
  listHomepageSections: () => mocks.sections
}));
vi.mock('@/plugins/PluginSlotBoundary', () => ({ PluginSlotBoundary: ({ children }: { children: React.ReactNode }) => children }));
afterEach(() => { cleanup(); mocks.sections = []; vi.clearAllMocks(); });

it('offers tips around the launcher and plugin shortcuts while preserving prompt seeding', () => {
  render(<MemoryRouter initialEntries={['/?prompt=Explain%20this%20project&focus=1']}><HelpProvider><HomeView /></HelpProvider></MemoryRouter>);
  expect(screen.getByRole('button', { name: /Need a few tips/ })).toBeTruthy();
  expect(mocks.composer).toHaveBeenCalledWith({ allowLegacyAgent: true, initialText: 'Explain this project', autoFocus: true });
  expect(screen.getByRole('button', { name: 'Plugin action' }).closest('.contextual-help-surface'))
    .toBe(screen.getByLabelText('Launcher draft').closest('.contextual-help-surface'));
  expect(document.querySelector('.home-plugin-sections')).toBeNull();
});

it('keeps plugin homepage sections outside the launcher guide', () => {
  mocks.sections = [{ id: 'example', generation: 1, title: 'Useful links', component: () => <button>Homepage tool</button> }];
  render(<MemoryRouter><HelpProvider><HomeView /></HelpProvider></MemoryRouter>);
  expect(screen.getByRole('heading', { name: 'Useful links' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Homepage tool' }).closest('.home-launcher-tips')).toBeNull();
});
