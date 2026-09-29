// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ThreadSecondaryPanel } from './ThreadSecondaryPanel.js';
import { emptySecondaryPanelState, openSecondaryPanel } from './threadSecondaryPanelState.js';

vi.mock('../../../hooks/useCompactLayout.js', () => ({ useCompactLayout: () => true }));
afterEach(cleanup);

function fixture(pins = true) {
  const handlers = {
    onSelectInfo: vi.fn(), onSelectDiff: vi.fn(), onSelectPlan: vi.fn(),
    onNewTab: vi.fn(), onCloseTab: vi.fn(), onActivateTab: vi.fn(),
    onToggleMaximized: vi.fn(), onHide: vi.fn(), onResize: vi.fn()
  };
  const state = { ...openSecondaryPanel(emptySecondaryPanelState()), tabs: [
    { id: 'file', kind: 'file-preview' as const, title: 'Project notes' },
    { id: 'other', kind: 'new-tab' as const, title: 'Other tab' }
  ] };
  const ui = (next = state) => <ThreadSecondaryPanel state={next} showInfoPin={pins} showDiffPin={pins} showPlanPin={pins} {...handlers}>
    <input aria-label="Keep draft" defaultValue="Unsaved work" />
  </ThreadSecondaryPanel>;
  return { ...render(ui()), handlers, state, ui };
}

it('shows one labeled header, switches views and preserves the hidden content', () => {
  const { handlers, rerender, state, ui } = fixture();
  const toggle = screen.getByRole('button', { name: 'Choose panel view' });
  expect(toggle.textContent).toBe('Overview');
  expect(screen.queryByRole('separator')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Maximize panel' })).toBeNull();
  const draft = screen.getByRole('textbox', { name: 'Keep draft' });
  fireEvent.change(draft, { target: { value: 'Retained draft' } });
  fireEvent.keyDown(draft, { key: 'Escape' });
  expect(handlers.onHide).not.toHaveBeenCalled();
  for (const [name, handler] of [['Changes', handlers.onSelectDiff], ['Plan', handlers.onSelectPlan], ['Overview', handlers.onSelectInfo]] as const) {
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByRole('textbox', { name: 'Keep draft' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name, exact: true }));
    expect(handler).toHaveBeenCalledOnce();
    expect(screen.queryByRole('navigation', { name: 'Panel views' })).toBeNull();
    expect(document.activeElement).toBe(toggle);
    expect(screen.getByRole('textbox', { name: 'Keep draft' })).toBe(draft);
    expect((draft as HTMLInputElement).value).toBe('Retained draft');
  }
  rerender(ui({ ...state, activeId: 'other' }));
  expect(toggle.textContent).toBe('Tools & files');
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole('button', { name: 'Project notes', exact: true }));
  expect(handlers.onActivateTab).toHaveBeenCalledWith('file');
  rerender(ui({ ...state, activeId: 'file' }));
  expect(toggle.textContent).toBe('Project notes');
});

it('searches available views, closes tabs, opens tools and returns with Escape', () => {
  const { handlers } = fixture();
  const toggle = screen.getByRole('button', { name: 'Choose panel view' });
  fireEvent.click(toggle);
  const search = screen.getByRole('searchbox', { name: 'Search panel views' });
  fireEvent.change(search, { target: { value: 'notes' } });
  expect(screen.queryByRole('button', { name: 'Changes', exact: true })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Close Project notes' }));
  expect(handlers.onCloseTab).toHaveBeenCalledWith('file');
  fireEvent.change(search, { target: { value: 'no match' } });
  expect(screen.getByRole('status').textContent).toBe('No matching views or tabs.');
  fireEvent.keyDown(search, { key: 'Escape' });
  expect(handlers.onHide).not.toHaveBeenCalled();
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(toggle);
  expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
  expect(handlers.onNewTab).toHaveBeenCalledOnce();
  expect(screen.queryByRole('navigation')).toBeNull();
  fireEvent.keyDown(toggle, { key: 'Escape' });
  expect(handlers.onHide).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
  expect(handlers.onHide).toHaveBeenCalledTimes(2);
});

it('omits unavailable pinned views', () => {
  fixture(false);
  fireEvent.click(screen.getByRole('button', { name: 'Choose panel view' }));
  const nav = screen.getByRole('navigation');
  for (const name of ['Overview', 'Changes', 'Plan']) expect(within(nav).queryByRole('button', { name, exact: true })).toBeNull();
});
