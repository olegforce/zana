// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopSignIn } from './DesktopSignIn';
afterEach(cleanup);
it.each([true, false])('requires explicit desktop approval and returns to the app without any credential in the link (%s)', async approved => {
  const api = vi.fn(async () => ({ name: 'iPhone', approved: false, denied: false })); const onError = vi.fn();
  render(<DesktopSignIn code="desktop-code" api={api} onError={onError} />);
  const button = await screen.findByRole('button', { name: approved ? 'Approve desktop sign-in' : 'Decline' });
  expect(api).toHaveBeenCalledTimes(1);
  fireEvent.click(button);
  await screen.findByRole('heading', { name: approved ? 'Desktop sign-in approved' : 'Desktop sign-in declined' });
  expect(api).toHaveBeenLastCalledWith('/desktop/approve', { code: 'desktop-code', approved });
  expect(screen.getByText(/Return to Zana/)).toBeTruthy();
  expect(screen.queryByRole('link')).toBeNull();
});
it('surfaces failed loading and approval, and allows retry without duplicate submission', async () => {
  const onError = vi.fn(); const api = vi.fn().mockRejectedValueOnce(new Error('Expired'));
  const view = render(<DesktopSignIn code="expired" api={api} onError={onError} />);
  await waitFor(() => expect(onError).toHaveBeenCalled());
  api.mockResolvedValueOnce({ name: 'Android' }); view.rerender(<DesktopSignIn code="fresh" api={api} onError={onError} />);
  let fail!: (error: Error) => void;
  api.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const button = await screen.findByRole('button', { name: 'Approve desktop sign-in' }); fireEvent.click(button); fireEvent.click(button);
  expect(api).toHaveBeenCalledTimes(3); expect((button as HTMLButtonElement).disabled).toBe(true);
  fail(new Error('Network unavailable')); await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  expect(onError).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'Network unavailable' }));
});
