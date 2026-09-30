// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MobileActionSheet, MobileMoreMenu, MobilePageHeader } from './MobilePageHeader.js';
import { MOBILE_THREAD_CONTROLS_ID, MOBILE_THREAD_TITLE_ID } from './useMobileThreadTitleTarget.js';

const layout = vi.hoisted(() => ({ compact: true }));
vi.mock('../hooks/useCompactLayout.js', () => ({ useCompactLayout: () => layout.compact }));
afterEach(() => { cleanup(); layout.compact = true; });

function Fixture({ enabled = true, title = 'Agents' }) {
  return <div className="app-shell">
    <div id={MOBILE_THREAD_TITLE_ID} data-testid="title" />
    <div id={MOBILE_THREAD_CONTROLS_ID} data-testid="actions" />
    <MobilePageHeader title={title} enabled={enabled} primary={<button>New agent</button>}>
      <button>Board view</button><button>List view</button>
    </MobilePageHeader>
  </div>;
}

it('lends one title and two actions to the shell, updating and releasing them on navigation', () => {
  const { rerender } = render(<Fixture />);
  expect(within(screen.getByTestId('title')).getByRole('heading').textContent).toBe('Agents');
  expect(within(screen.getByTestId('actions')).getAllByRole('button')).toHaveLength(2);
  expect(screen.queryByText('List view')).toBeNull();
  rerender(<Fixture title="Project agents" />);
  expect(screen.getByRole('heading').title).toBe('Project agents');
  rerender(<Fixture enabled={false} />);
  expect(screen.getByTestId('title').childElementCount).toBe(0);
  expect(screen.getByTestId('actions').childElementCount).toBe(0);
  rerender(<Fixture />);
  layout.compact = false;
  rerender(<Fixture />);
  expect(screen.getByTestId('title').childElementCount).toBe(0);
  expect(screen.getByTestId('actions').childElementCount).toBe(0);
});

it('renders no duplicate header without mobile shell slots, and supports a title with no actions', () => {
  const { rerender } = render(<MobilePageHeader title="Settings" />);
  expect(screen.queryByRole('heading')).toBeNull();
  rerender(<><div id={MOBILE_THREAD_TITLE_ID} /><div id={MOBILE_THREAD_CONTROLS_ID} /><MobilePageHeader title="Settings" /></>);
  expect(screen.getByRole('heading').textContent).toBe('Settings');
  expect(screen.queryByRole('button')).toBeNull();
});

it('opens a modal sheet, traps focus around enabled actions, and returns to its trigger', () => {
  render(<Fixture />);
  const trigger = screen.getByRole('button', { name: 'Agents actions' });
  trigger.focus(); fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Agents actions' });
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(document.activeElement).toBe(dialog);
  expect(document.querySelector('.app-shell')?.hasAttribute('inert')).toBe(true);
  const first = within(dialog).getByRole('button', { name: 'Close actions' });
  const last = within(dialog).getByRole('button', { name: 'List view' });
  fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: 'Tab' });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.querySelector('.app-shell')?.hasAttribute('inert')).toBe(false);
  expect(document.activeElement).toBe(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
});

it('runs the selected action once and closes, including clicks on a nested icon', () => {
  const action = vi.fn();
  render(<MobileMoreMenu title="Inbox"><button onClick={action}><span>Mark read</span></button></MobileMoreMenu>);
  fireEvent.click(screen.getByRole('button', { name: 'Inbox actions' }));
  fireEvent.click(screen.getByText('Mark read'));
  expect(action).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('keeps a filter sheet open for inputs or explicit persistent controls, and dismisses only on its backdrop', () => {
  const close = vi.fn();
  render(<MobileActionSheet title="Filters" onClose={close}>
    <input aria-label="Filter" /><div data-keep-sheet-open><button>Toggle filter</button></div><button disabled>Unavailable</button>
  </MobileActionSheet>);
  const dialog = screen.getByRole('dialog');
  fireEvent.click(screen.getByRole('textbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Toggle filter' }));
  fireEvent.click(dialog);
  fireEvent.click(screen.getByRole('button', { name: 'Unavailable' }));
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(dialog.parentElement!);
  expect(close).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Close actions' }));
  expect(close).toHaveBeenCalledTimes(2);
});

it('leaves existing modal ownership intact and does not steal focus from a newly opened dialog', () => {
  const shell = document.createElement('div'); shell.className = 'app-shell'; shell.setAttribute('inert', ''); document.body.append(shell);
  const opener = document.createElement('button'); document.body.append(opener); opener.focus();
  const { unmount } = render(<MobileActionSheet title="Actions" onClose={() => {}}><button>Rename</button></MobileActionSheet>);
  const next = document.createElement('input'); document.body.append(next); next.focus();
  unmount();
  expect(document.activeElement).toBe(next);
  expect(shell.hasAttribute('inert')).toBe(true);
  shell.remove(); opener.remove(); next.remove();
});
