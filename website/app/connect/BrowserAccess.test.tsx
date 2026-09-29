// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AddressPicker, BrowserLink, BrowserSignIn } from './BrowserAccess';

afterEach(cleanup);
const computers = [{ id: 'mac', name: 'MacBook' }, { id: 'studio', name: 'Studio' }];
it('opens the clicked domain through its authenticated handoff with one click', async () => {
  let complete!: (result: unknown) => void;
  const api = vi.fn(() => new Promise(resolve => { complete = resolve; }));
  const navigate = vi.fn(), onError = vi.fn();
  render(<BrowserLink serverId="mac" browserUrl="https://alice.example.com" api={api} navigate={navigate} onError={onError}>alice.example.com</BrowserLink>);
  const link = screen.getByRole('link');
  expect(link.getAttribute('href')).toBe('https://alice.example.com');
  fireEvent.click(link); fireEvent.click(link);
  expect(api).toHaveBeenCalledExactlyOnceWith('/browser/open', { serverId: 'mac' });
  expect(link.getAttribute('aria-busy')).toBe('true');
  const location = 'https://alice.example.com/_connect/login?intent=fixture';
  complete({ location });
  await waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith(location));
  expect(onError).not.toHaveBeenCalled();
});
it('reports an opening failure without navigating and allows another attempt', async () => {
  const error = new Error('Sign-in expired');
  const api = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce({ location: 'https://alice.example.com/_connect/login?intent=retry' });
  const onError = vi.fn(), navigate = vi.fn();
  render(<BrowserLink serverId="mac" browserUrl="https://alice.example.com" api={api} onError={onError} navigate={navigate}>alice.example.com</BrowserLink>);
  fireEvent.click(screen.getByRole('link'));
  await waitFor(() => expect(onError).toHaveBeenCalledWith(error));
  expect(navigate).not.toHaveBeenCalled();
  expect(screen.getByRole('link').getAttribute('aria-busy')).toBe('false');
  fireEvent.click(screen.getByRole('link'));
  await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
});
it('preserves the real domain for modified clicks and normal browser link actions', () => {
  const api = vi.fn(), navigate = vi.fn();
  render(<BrowserLink serverId="mac" browserUrl="https://alice.example.com" api={api} onError={vi.fn()} navigate={navigate}>alice.example.com</BrowserLink>);
  const link = screen.getByRole('link');
  // Prevent jsdom's unimplemented navigation after React has handled the event.
  document.addEventListener('click', event => event.preventDefault(), { once: true });
  fireEvent.click(link, { ctrlKey: true });
  expect(api).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
});
function picker(api = vi.fn(async () => ({ available: true })), extra = {}) {
  const onChanged = vi.fn(async () => {}), onError = vi.fn();
  const props = { computers, domain: 'connect.example.com', api, onChanged, onError, disabled: false, ...extra };
  const view = render(<AddressPicker {...props} />);
  return { ...view, ...props };
}
it('validates input, previews availability and claims the selected computer explicitly', async () => {
  const { api, onChanged } = picker();
  const input = screen.getByLabelText('Your address');
  const claim = screen.getByRole('button', { name: 'Claim your address' }) as HTMLButtonElement;
  fireEvent.change(input, { target: { value: 'UPPER' } }); expect(claim.disabled).toBe(true);
  expect(screen.getByRole('status').textContent).toContain('valid address');
  fireEvent.change(input, { target: { value: 'my-studio' } });
  await screen.findByText('Available: https://my-studio.connect.example.com');
  fireEvent.change(screen.getByLabelText('Computer'), { target: { value: 'studio' } });
  await waitFor(() => expect(claim.disabled).toBe(false));
  fireEvent.click(claim);
  await waitFor(() => expect(api).toHaveBeenCalledWith('/address', { serverId: 'studio', label: 'my-studio' }));
  expect(onChanged).toHaveBeenCalledOnce();
});
it('blocks a taken address and handles a claim lost to another owner', async () => {
  const api = vi.fn(async (path: string) => {
    if (path === '/address') throw new Error('That address is taken.');
    return { available: !path.includes('taken') };
  });
  const { onError } = picker(api);
  fireEvent.change(screen.getByLabelText('Your address'), { target: { value: 'taken-name' } });
  await screen.findByText('That address is taken. Try another name.');
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Your address'), { target: { value: 'alice-mac' } });
  await screen.findByText('Available: https://alice-mac.connect.example.com');
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'That address is taken.' })));
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
});
it('ignores stale availability replies and handles service failure', async () => {
  let resolve!: (value: unknown) => void;
  const api = vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockRejectedValueOnce(new Error('Unavailable'));
  const { onError } = picker(api);
  fireEvent.change(screen.getByLabelText('Your address'), { target: { value: 'alice-mac' } });
  await waitFor(() => expect(api).toHaveBeenCalledOnce());
  fireEvent.change(screen.getByLabelText('Your address'), { target: { value: 'alice-air' } });
  resolve({ available: true });
  await waitFor(() => expect(onError).toHaveBeenCalledOnce());
  expect(screen.queryByText(/Available:/)).toBeNull();
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
});
it('hides the picker once all computers have an address and disables it during a refresh', () => {
  const view = picker(undefined, { computers: [{ ...computers[0], browserUrl: 'https://alice-mac.connect.example.com' }] });
  expect(screen.queryByRole('heading')).toBeNull(); view.unmount();
  picker(undefined, { computers: [computers[0]], disabled: true });
  expect(screen.queryByLabelText('Computer')).toBeNull();
  expect(screen.getByText('MacBook')).toBeTruthy();
  expect((screen.getByLabelText('Your address') as HTMLInputElement).disabled).toBe(true);
});
it('opens the requested computer only after explicit browser sign-in approval', async () => {
  const navigate = vi.fn(), onError = vi.fn();
  const api = vi.fn().mockResolvedValueOnce({ name: 'MacBook', browserUrl: 'https://alice.connect.example.com' }).mockResolvedValueOnce({ location: 'https://alice.connect.example.com/_connect/callback?code=abc' });
  render(<BrowserSignIn code="abc" api={api} onError={onError} navigate={navigate} />);
  expect(screen.getByRole('status').textContent).toContain('Checking browser');
  const open = await screen.findByRole('button', { name: 'Open Zana' });
  expect(api).toHaveBeenCalledTimes(1);
  fireEvent.click(open);
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://alice.connect.example.com/_connect/callback?code=abc'));
  expect(api).toHaveBeenLastCalledWith('/browser/approve', { code: 'abc' });
});
it.each(['info', 'approve'])('reports a browser %s failure without navigating', async stage => {
  const navigate = vi.fn(), onError = vi.fn();
  const api = vi.fn().mockRejectedValue(new Error('Expired'));
  if (stage === 'approve') api.mockResolvedValueOnce({ name: 'Mac', browserUrl: 'https://alice.connect.example.com' });
  render(<BrowserSignIn code="abc" api={api} onError={onError} navigate={navigate} />);
  if (stage === 'approve') fireEvent.click(await screen.findByRole('button', { name: 'Open Zana' }));
  await waitFor(() => expect(onError).toHaveBeenCalledOnce());
  expect(navigate).not.toHaveBeenCalled();
});
