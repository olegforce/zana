// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { InboxMobileActions } from './InboxMobileActions.js';
import { InboxMobileDocument } from './InboxMobileDocument.js';
import { useEffect } from 'react';

afterEach(cleanup);

it('opens labeled actions, honors disabled state, and returns focus after selection', () => {
  const selected = vi.fn();
  render(<InboxMobileActions actions={[
    { label: 'Keep', icon: <span aria-hidden="true">★</span>, onSelect: selected, pressed: true },
    { label: 'Saved', icon: null, onSelect: selected, disabled: true },
    { label: 'Delete', icon: null, onSelect: selected, danger: true }
  ]} />);
  const trigger = screen.getByRole('button', { name: 'Message actions' });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(trigger);
  expect(screen.getByRole('dialog', { name: 'Message actions' })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close message actions' }));
  expect(screen.getByRole('button', { name: 'Keep' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Saved' }));
  expect(selected).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
  expect(selected).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('traps focus and closes with Escape, Close or the backdrop without running an action', () => {
  const selected = vi.fn();
  render(<InboxMobileActions actions={[{ label: 'Delete', icon: null, onSelect: selected }]} />);
  const trigger = screen.getByRole('button', { name: 'Message actions' });
  fireEvent.click(trigger);
  const close = screen.getByRole('button', { name: 'Close message actions' });
  fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete' }));
  fireEvent.keyDown(window, { key: 'Tab' });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('button', { name: 'Close message actions' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(trigger);
  fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(selected).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
});

it.each(['.zcc/library/findings/report.md', 'C:\\docs\\report.md'])('lazily reveals %s by filename and collapses it accessibly', (path) => {
  const loaded = vi.fn();
  const disposed = vi.fn();
  function Preview() { useEffect(() => { loaded(); return disposed; }, []); return <p>Document content</p>; }
  render(<InboxMobileDocument path={path}><Preview /></InboxMobileDocument>);
  const toggle = screen.getByRole('button', { name: 'report.md' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(toggle.title).toBe(path);
  expect(loaded).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(document.getElementById(toggle.getAttribute('aria-controls')!)?.textContent).toBe('Document content');
  expect(loaded).toHaveBeenCalledOnce();
  fireEvent.click(toggle);
  expect(screen.queryByText('Document content')).toBeNull();
  expect(disposed).toHaveBeenCalledOnce();
});

it('keeps a root-like attachment path labeled', () => {
  render(<InboxMobileDocument path="/"><span>Root document</span></InboxMobileDocument>);
  expect(screen.getByRole('button', { name: '/' })).toBeTruthy();
});
