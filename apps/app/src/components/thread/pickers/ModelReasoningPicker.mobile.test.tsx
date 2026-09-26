// @vitest-environment happy-dom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ModelReasoningPicker } from './ModelReasoningPicker.js';

const h = vi.hoisted(() => ({ compact: true, choose: vi.fn() }));
vi.mock('../../../hooks/useCompactLayout.js', () => ({ useCompactLayout: () => h.compact }));
const providers = ['Codex', 'Claude Code', 'Cursor', 'OpenCode', 'Pi', 'Grok', 'Mastracode'].map((label) => ({ value: label.toLowerCase(), label }));
const models = Array.from({ length: 7 }, (_, i) => ({ value: `model-${i}`, label: `Model ${i}` }));
const extra = [{ value: 'extra', label: 'Additional model' }];
function Fixture({ locked = false }: { locked?: boolean }) {
  const [provider, setProvider] = useState('codex');
  return <ModelReasoningPicker providerOptions={providers} selectedProviderId={provider}
    onSelectedProviderChange={locked ? undefined : setProvider} modelValue="model-0"
    modelOptions={models} moreModelOptions={extra} onModelChange={h.choose} />;
}
beforeEach(() => { h.compact = true; vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Provider and model' }));

it('shows named harnesses without opening the keyboard, clears search on switch, and restores focus on close', () => {
  render(<Fixture />);
  open();
  const menu = screen.getByRole('dialog');
  expect(menu.getAttribute('aria-modal')).toBe('true');
  expect(screen.getByRole('heading', { name: 'Harness & model' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Close model picker' })).toBe(document.activeElement);
  expect(screen.getAllByRole('tab').map((tab) => tab.querySelector('span')?.textContent)).toEqual(providers.map((p) => p.label));
  const search = screen.getByRole('textbox', { name: 'Search models' });
  fireEvent.change(search, { target: { value: 'missing' } });
  expect(screen.getByText('No matching models')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'Cursor' }));
  expect(screen.getByRole('tab', { name: 'Cursor' }).getAttribute('aria-selected')).toBe('true');
  expect((search as HTMLInputElement).value).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'Close model picker' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button', { name: 'Provider and model' })).toBe(document.activeElement);
});

it('expands additional models inside the mobile list, preserves focus, and selects through the existing callback', () => {
  render(<Fixture />);
  open();
  fireEvent.click(screen.getByRole('button', { name: 'More models' }));
  expect(screen.queryByRole('listbox', { name: 'More models' })).toBeNull();
  const additional = screen.getByRole('button', { name: 'Additional model' });
  expect(additional.closest('[role="dialog"]')).toBeTruthy();
  expect(additional).toBe(document.activeElement);
  fireEvent.click(additional);
  expect(h.choose).toHaveBeenCalledWith('extra');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button', { name: 'Provider and model' })).toBe(document.activeElement);
});

it('traps Tab, closes with Escape outside the search field, and keeps existing-thread harnesses locked', () => {
  render(<Fixture locked />);
  open();
  expect(screen.getByRole('heading', { name: 'Choose model' })).toBeTruthy();
  expect(screen.queryByRole('tablist')).toBeNull();
  const close = screen.getByRole('button', { name: 'Close model picker' });
  const last = screen.getByRole('button', { name: 'More models' });
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
  expect(last).toBe(document.activeElement);
  fireEvent.keyDown(last, { key: 'Tab' });
  expect(close).toBe(document.activeElement);
  fireEvent.keyDown(close, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('keeps search focus when expanding with the keyboard, then selects a filtered extra model', () => {
  render(<Fixture />);
  open();
  const search = screen.getByRole('textbox', { name: 'Search models' });
  search.focus();
  fireEvent.keyDown(search, { key: 'ArrowUp' });
  fireEvent.keyDown(search, { key: 'Enter' });
  expect(screen.getByRole('button', { name: 'Additional model' })).toBeTruthy();
  expect(search).toBe(document.activeElement);
  fireEvent.change(search, { target: { value: 'Additional' } });
  fireEvent.keyDown(search, { key: 'ArrowDown' });
  fireEvent.keyDown(search, { key: 'Enter' });
  expect(h.choose).toHaveBeenCalledWith('extra');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('fits visual viewport changes and restores desktop positioning when resized out of mobile', () => {
  const viewport = Object.assign(new EventTarget(), { height: 720, offsetTop: 0 });
  const remove = vi.spyOn(viewport, 'removeEventListener');
  vi.stubGlobal('visualViewport', viewport);
  const view = render(<Fixture />);
  open();
  const menu = screen.getByRole('dialog');
  expect(menu.style.height).toBe('720px');
  viewport.height = 340;
  viewport.offsetTop = 12;
  viewport.dispatchEvent(new Event('resize'));
  expect(menu.style.height).toBe('340px');
  expect(menu.style.top).toBe('12px');
  h.compact = false;
  view.rerender(<Fixture />);
  expect(menu.getAttribute('aria-modal')).toBeNull();
  expect(menu.style.height).toBe('');
  expect(parseFloat(menu.style.width)).toBeLessThanOrEqual(320);
  expect(screen.queryByRole('button', { name: 'Close model picker' })).toBeNull();
  expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
  expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
});
