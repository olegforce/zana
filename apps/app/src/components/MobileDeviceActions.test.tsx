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

it('offers native sharing and device settings directly, with a working page reload', async () => {
  const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
  render(<MobileDeviceActions />);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Share' })));
  expect(native.request).toHaveBeenCalledWith('share', { url: window.location.href });
  fireEvent.click(screen.getByRole('button', { name: 'This device' }));
  expect(native.post).toHaveBeenCalledWith({ type: 'open-native', screen: 'device-settings' });
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  expect(reload).toHaveBeenCalledOnce();
});

it('keeps sharing disabled while the share sheet is open and allows retry after failure', async () => {
  let reject!: (error: Error) => void;
  native.request.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  render(<MobileDeviceActions />);
  const share = screen.getByRole('button', { name: 'Share' }) as HTMLButtonElement;
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
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Share' })));
  expect(share).toHaveBeenCalledWith({ url: window.location.href });
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByRole('button', { name: 'This device' })).toBeNull();
  expect(native.request).not.toHaveBeenCalled();
});

it('keeps reload usable in browsers without device or sharing APIs', () => {
  native.available = false;
  render(<MobileDeviceActions />);
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
});

it('does not report a false failure when an older native share sheet outlasts the bridge deadline', async () => {
  native.request.mockRejectedValueOnce(new Error('native request timed out'));
  render(<MobileDeviceActions />);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Share' })));
  expect(screen.queryByRole('status')).toBeNull();
  expect((screen.getByRole('button', { name: 'Share' }) as HTMLButtonElement).disabled).toBe(false);
});
