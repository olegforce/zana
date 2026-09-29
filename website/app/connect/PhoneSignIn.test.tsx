// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PhoneSignIn } from './PhoneSignIn';
afterEach(cleanup);
it.each([true, false])('requires explicit phone approval and returns to the app without any credential in the link (%s)', async approved => {
  const api = vi.fn(async () => ({ name: 'iPhone', approved: false, denied: false })); const onError = vi.fn();
  render(<PhoneSignIn code="phone-code" api={api} onError={onError} />);
  const button = await screen.findByRole('button', { name: approved ? 'Approve phone' : 'Decline' });
  expect(api).toHaveBeenCalledTimes(1);
  fireEvent.click(button);
  await screen.findByRole('heading', { name: approved ? 'Your phone is approved' : 'Phone sign-in declined' });
  expect(api).toHaveBeenLastCalledWith('/phone/approve', { code: 'phone-code', approved });
  expect(screen.getByRole('link', { name: 'Return to Zana Mobile' }).getAttribute('href')).toBe('zana://connect');
});
it('surfaces failed loading and approval, and allows retry without duplicate submission', async () => {
  const onError = vi.fn(); const api = vi.fn().mockRejectedValueOnce(new Error('Expired'));
  const view = render(<PhoneSignIn code="expired" api={api} onError={onError} />);
  await waitFor(() => expect(onError).toHaveBeenCalled());
  api.mockResolvedValueOnce({ name: 'Android' }); view.rerender(<PhoneSignIn code="fresh" api={api} onError={onError} />);
  let fail!: (error: Error) => void;
  api.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const button = await screen.findByRole('button', { name: 'Approve phone' }); fireEvent.click(button); fireEvent.click(button);
  expect(api).toHaveBeenCalledTimes(3); expect((button as HTMLButtonElement).disabled).toBe(true);
  fail(new Error('Network unavailable')); await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  expect(onError).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'Network unavailable' }));
});
