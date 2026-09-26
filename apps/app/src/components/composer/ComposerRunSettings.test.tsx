// @vitest-environment happy-dom
import { useEffect, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ComposerRunSettings, composerRunSummary } from './ComposerRunSettings.js';
import { PopoverPicklist } from '../ui/PopoverPicklist.js';

const layout = vi.hoisted(() => ({ compact: true }));
vi.mock('../../hooks/useCompactLayout.js', () => ({ useCompactLayout: () => layout.compact }));
afterEach(() => { cleanup(); layout.compact = true; });

it('summarizes the actual host and workspace without calling the phone this machine', () => {
  const input = { machineName: 'MacBook.local', remote: false, foreignHost: false, workspace: 'unmanaged' as const };
  expect(composerRunSummary(input)).toBe('MacBook · Local');
  expect(composerRunSummary({ ...input, machineName: undefined })).toBe('Host unavailable · Local');
  expect(composerRunSummary({ ...input, remote: true, foreignHost: true })).toBe('MacBook · Remote project');
  expect(composerRunSummary({ ...input, foreignHost: true, workspace: 'worktree' })).toBe('MacBook · Project copy');
  expect(composerRunSummary({ ...input, workspace: 'worktree' })).toBe('MacBook · New worktree');
  expect(composerRunSummary({ ...input, workspace: 'reuse' })).toBe('MacBook · Existing worktree');
  expect(composerRunSummary({ ...input, workspace: 'personal' })).toBe('MacBook · Personal scratch');
});

it('opens a named dialog, traps focus and restores the trigger when closed', () => {
  render(<ComposerRunSettings summary="MacBook · Local"><button>Machine</button></ComposerRunSettings>);
  expect(screen.queryByRole('dialog')).toBeNull();
  const trigger = screen.getByRole('button', { name: 'Run settings: MacBook · Local' });
  fireEvent.click(trigger);
  expect(screen.getByRole('dialog', { name: 'Run settings' }).getAttribute('aria-modal')).toBe('true');
  const close = screen.getByRole('button', { name: 'Close run settings' });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(screen.getByText('Machine'));
  fireEvent.keyDown(screen.getByText('Machine'), { key: 'Tab' });
  expect(document.activeElement).toBe(close);
  fireEvent.click(close);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.keyDown(close, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('keeps controls mounted while closed and preserves a selection across opens', () => {
  const mounted = vi.fn();
  function Control() {
    const [value, setValue] = useState('Local');
    useEffect(() => { mounted(); }, []);
    return <button onClick={() => setValue('Worktree')}>{value}</button>;
  }
  render(<ComposerRunSettings summary="MacBook"><Control /></ComposerRunSettings>);
  expect(mounted).toHaveBeenCalledOnce();
  const trigger = screen.getByRole('button', { name: 'Run settings: MacBook' });
  fireEvent.click(trigger);
  fireEvent.click(screen.getByText('Local'));
  fireEvent.click(screen.getByLabelText('Close run settings'));
  fireEvent.click(trigger);
  expect(screen.getByRole('button', { name: 'Worktree' })).toBeTruthy();
  expect(mounted).toHaveBeenCalledOnce();
});

it('lets nested picklists handle Escape without closing run settings', () => {
  render(<ComposerRunSettings summary="MacBook"><PopoverPicklist
    ariaLabel="Machine" value="local" options={[{ value: 'local', label: 'MacBook' }]}
    onChange={vi.fn()} searchable={false}
  /></ComposerRunSettings>);
  fireEvent.click(screen.getByRole('button', { name: 'Run settings: MacBook' }));
  fireEvent.click(screen.getByRole('button', { name: 'Machine' }));
  fireEvent.keyDown(screen.getByRole('button', { name: 'Machine' }), { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Machine' }));
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(screen.getByRole('dialog')).toBeTruthy();
});

it('renders inline on desktop and clears the open state across viewport transitions', () => {
  layout.compact = false;
  const ui = <ComposerRunSettings summary="MacBook"><button>Machine</button></ComposerRunSettings>;
  const { rerender } = render(ui);
  expect(screen.getByRole('button', { name: 'Machine' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Run settings/ })).toBeNull();
  layout.compact = true;
  rerender(<ComposerRunSettings summary="MacBook"><button>Machine</button></ComposerRunSettings>);
  fireEvent.click(screen.getByRole('button', { name: /Run settings/ }));
  layout.compact = false;
  rerender(<ComposerRunSettings summary="MacBook"><button>Machine</button></ComposerRunSettings>);
  expect(screen.queryByRole('dialog')).toBeNull();
  layout.compact = true;
  rerender(<ComposerRunSettings summary="MacBook"><button>Machine</button></ComposerRunSettings>);
  expect(screen.queryByRole('dialog')).toBeNull();
});
