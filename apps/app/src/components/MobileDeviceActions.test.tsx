// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MobileDeviceActions } from './MobileDeviceActions.js';

const native = vi.hoisted(() => ({ available: true, capabilities: ['share', 'open-native'], post: vi.fn(), request: vi.fn() }));
vi.mock('../lib/native-shell.js', () => ({ getNativeShell: () => native.available ? native : null }));
beforeEach(() => {
  native.available = true;
  native.capabilities = ['share', 'open-native'];
  native.request.mockResolvedValue(undefined);
  vi.stubGlobal('navigator', {});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

const openOptions = () => fireEvent.click(screen.getByRole('button', { name: 'Device options' }));

it('keeps device actions behind the options button, with working native actions and reload', async () => {
  const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
  render(<MobileDeviceActions />);
  openOptions();
  await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: 'Share' })));
  expect(native.request).toHaveBeenCalledWith('share', { url: window.location.href });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Device options' }));
  openOptions();
  fireEvent.click(screen.getByRole('menuitem', { name: 'This device' }));
  expect(native.post).toHaveBeenCalledWith({ type: 'open-native', screen: 'device-settings' });
  expect(screen.queryByRole('menu')).toBeNull();
  openOptions();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Reload' }));
  expect(reload).toHaveBeenCalledOnce();
});

it('keeps sharing disabled while the share sheet is open and allows retry after failure', async () => {
  let reject!: (error: Error) => void;
  native.request.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  render(<MobileDeviceActions />);
  openOptions();
  const share = screen.getByRole('menuitem', { name: 'Share' }) as HTMLButtonElement;
  fireEvent.click(share);
  expect(share.disabled).toBe(true);
  expect(share.getAttribute('aria-busy')).toBe('true');
  await act(async () => reject(new Error('Unavailable')));
  expect(screen.getByRole('status').textContent).toContain('Could not open sharing');
  expect(share.disabled).toBe(false);
  await act(async () => fireEvent.click(share));
  expect(screen.queryByRole('status')).toBeNull();
});

it.each([false, true])('offers browser sharing when available and treats cancellation normally (native=%s)', async (available) => {
  native.available = available;
  native.capabilities = [];
  const share = vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
  vi.stubGlobal('navigator', { share });
  render(<MobileDeviceActions />);
  openOptions();
  await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: 'Share' })));
  expect(share).toHaveBeenCalledWith({ url: window.location.href });
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByRole('menuitem', { name: 'This device' })).toBeNull();
  expect(native.request).not.toHaveBeenCalled();
});

it('keeps reload usable in browsers without device or sharing APIs', () => {
  native.available = false;
  render(<MobileDeviceActions />);
  openOptions();
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(screen.getByRole('menuitem', { name: 'Reload' })).toBeTruthy();
});

it('does not report a false failure when an older native share sheet outlasts the bridge deadline', async () => {
  native.request.mockRejectedValueOnce(new Error('native request timed out'));
  render(<MobileDeviceActions />);
  openOptions();
  await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: 'Share' })));
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByRole('menu')).toBeNull();
  openOptions();
  expect((screen.getByRole('menuitem', { name: 'Share' }) as HTMLButtonElement).disabled).toBe(false);
});


it('starts collapsed and dismisses on toggle, Escape, outside taps and focus leaving', () => {
  render(<><MobileDeviceActions /><button>Outside</button></>);
  const trigger = screen.getByRole('button', { name: 'Device options' });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('menuitem')).toBeNull();
  openOptions();
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('menu').id).toBe(trigger.getAttribute('aria-controls'));
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Share' }));
  fireEvent.pointerDown(document.activeElement!);
  expect(screen.getByRole('menu')).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  openOptions();
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
  expect(screen.queryByRole('menu')).toBeNull();
  openOptions();
  act(() => screen.getByRole('button', { name: 'Outside' }).focus());
  expect(screen.queryByRole('menu')).toBeNull();
  openOptions();
  openOptions();
  expect(screen.queryByRole('menu')).toBeNull();
});

it('supports arrow navigation, Home and End without stealing ordinary key presses', () => {
  render(<MobileDeviceActions />);
  const trigger = screen.getByRole('button', { name: 'Device options' });
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  expect(screen.queryByRole('menu')).toBeNull();
  openOptions();
  const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });
  press('ArrowDown');
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Reload' }));
  press('Home');
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Share' }));
  press('ArrowUp');
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'This device' }));
  press('ArrowDown');
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Share' }));
  press('End');
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'This device' }));
  press('a');
  expect(screen.getByRole('menu')).toBeTruthy();
});

it('does not steal focus when sharing finishes after the user leaves the menu', async () => {
  let finish!: () => void;
  native.request.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  render(<><MobileDeviceActions /><button>Outside</button></>);
  openOptions();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Share' }));
  const outside = screen.getByRole('button', { name: 'Outside' });
  act(() => outside.focus());
  await act(async () => finish());
  expect(document.activeElement).toBe(outside);
  expect(screen.queryByRole('menu')).toBeNull();
});
