// @vitest-environment happy-dom
import { createElement, type ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({ default: ({ children, ...props }: ComponentProps<'a'>) => createElement('a', props, children) }));
const route = vi.hoisted(() => ({ path: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => route.path }));
import { Nav } from './Nav';

const reply = (user: { username: string } | null) => ({ ok: true, json: async () => ({ user }) });
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  route.path = '/';
  fetchMock = vi.fn().mockResolvedValue(reply(null));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('account navigation', () => {
  it('uses a neutral, working link until the session is known, then shows Log in', async () => {
    let resolve!: (value: unknown) => void;
    fetchMock.mockReturnValue(new Promise((done) => { resolve = done; }));
    render(createElement(Nav));
    expect(screen.getByRole('link', { name: 'Account' }).getAttribute('href')).toBe('/connect/');
    expect(screen.queryByRole('link', { name: 'Log in' })).toBeNull();
    await act(async () => { resolve(reply(null)); });
    expect(screen.getByRole('link', { name: 'Log in' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/session/', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
  });

  it('places Dashboard and username last after Download on both layouts using one request', async () => {
    const username = 'a-very-long-github-account-name-for-test';
    fetchMock.mockResolvedValue(reply({ username }));
    render(createElement(Nav));
    const link = await screen.findByRole('link', { name: `Dashboard · ${username}` });
    expect(link.getAttribute('href')).toBe('/connect/');
    expect(link.getAttribute('title')).toBe(`Dashboard · ${username}`);
    expect(link.previousElementSibling?.textContent).toBe('Download');
    expect(link.nextElementSibling).toBeNull();
    expect(link.querySelector('.nav-account-name')?.textContent).toBe(username);
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(screen.getAllByRole('link', { name: `Dashboard · ${username}` })).toHaveLength(2);
    const mobileAccount = document.querySelector('#mobile-menu .nav-account-link');
    expect(mobileAccount?.previousElementSibling?.textContent).toBe('Download');
    expect(mobileAccount?.nextElementSibling).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes sign-in and sign-out state when the tab returns or the route changes', async () => {
    const { rerender } = render(createElement(Nav));
    await screen.findByRole('link', { name: 'Log in' });
    fetchMock.mockResolvedValue(reply({ username: 'grebmann1' }));
    fireEvent.focus(window);
    await screen.findByRole('link', { name: 'Dashboard · grebmann1' });
    fetchMock.mockResolvedValue(reply(null));
    fireEvent(window, new Event('pageshow'));
    await screen.findByRole('link', { name: 'Log in' });
    fetchMock.mockResolvedValue(reply({ username: 'another-user' }));
    route.path = '/docs/';
    rerender(createElement(Nav));
    await screen.findByRole('link', { name: 'Dashboard · another-user' });
  });

  it('checks visible tabs and ignores hidden tabs', async () => {
    render(createElement(Nav));
    await screen.findByRole('link', { name: 'Log in' });
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue('visible');
    fetchMock.mockResolvedValue(reply({ username: 'returned' }));
    fireEvent(document, new Event('visibilitychange'));
    await screen.findByRole('link', { name: 'Dashboard · returned' });
  });

  it.each([
    { ok: false },
    { ok: true, json: async () => ({ user: {} }) },
    { ok: true, json: async () => ({ user: { username: '' } }) },
    { ok: true, json: async () => { throw new Error('invalid JSON'); } }
  ])('falls back to Account when a refresh fails instead of showing stale identity', async (response) => {
    fetchMock.mockResolvedValueOnce(reply({ username: 'old-user' })).mockResolvedValue(response);
    render(createElement(Nav));
    await screen.findByRole('link', { name: 'Dashboard · old-user' });
    fireEvent.focus(window);
    await screen.findByRole('link', { name: 'Account' });
    expect(screen.queryByText('old-user')).toBeNull();
  });

  it('deduplicates pending checks and aborts a stalled request after eight seconds', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    render(createElement(Nav));
    fireEvent.focus(window);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const signal = fetchMock.mock.calls[0][1].signal;
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    expect(signal.aborted).toBe(true);
    expect(screen.getByRole('link', { name: 'Account' })).toBeTruthy();
    fetchMock.mockResolvedValue(reply(null));
    await act(async () => { fireEvent.focus(window); });
    expect(screen.getByRole('link', { name: 'Log in' })).toBeTruthy();
  });

  it('aborts on unmount, removes listeners and ignores late replies', async () => {
    let resolve!: (value: unknown) => void;
    fetchMock.mockReturnValue(new Promise((done) => { resolve = done; }));
    const { unmount } = render(createElement(Nav));
    const signal = fetchMock.mock.calls[0][1].signal;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { resolve(reply({ username: 'late' })); });
    fireEvent.focus(window);
    fireEvent(window, new Event('pageshow'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('late')).toBeNull();
  });

  it('keeps the shared account button on Connect and marks it as the current destination on both layouts', async () => {
    route.path = '/connect/';
    fetchMock.mockResolvedValue(reply({ username: 'grebmann1' }));
    render(createElement(Nav));
    const account = await screen.findByRole('link', { name: 'Dashboard · grebmann1' });
    expect(account.getAttribute('aria-current')).toBe('page');
    expect(account.previousElementSibling?.textContent).toBe('Download');
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    for (const link of screen.getAllByRole('link', { name: 'Dashboard · grebmann1' })) {
      expect(link.getAttribute('aria-current')).toBe('page');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves pending desktop approval when Log in is used from the dashboard header', async () => {
    route.path = '/connect/';
    const returnTo = `/connect/?desktop=${'d'.repeat(22)}`;
    window.history.replaceState({}, '', returnTo);
    render(createElement(Nav));
    const login = await screen.findByRole('link', { name: 'Log in' });
    expect(login.getAttribute('href')).toBe(`/api/auth/github/login/?returnTo=${encodeURIComponent(returnTo)}`);
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    for (const link of screen.getAllByRole('link', { name: 'Log in' })) expect(link.getAttribute('href')).toBe(login.getAttribute('href'));
  });

  it('preserves the header structure when moving between the homepage and dashboard', async () => {
    fetchMock.mockResolvedValue(reply({ username: 'grebmann1' }));
    const { rerender } = render(createElement(Nav));
    await screen.findByRole('link', { name: 'Dashboard · grebmann1' });
    const header = screen.getByRole('navigation');
    const brand = header.querySelector('.brand')!.outerHTML;
    const destinations = [...header.querySelectorAll('a')].map(link => [link.getAttribute('href'), link.textContent]);
    route.path = '/connect/';
    rerender(createElement(Nav));
    expect(screen.getByRole('navigation')).toBe(header);
    expect(header.querySelector('.brand')!.outerHTML).toBe(brand);
    expect([...header.querySelectorAll('a')].map(link => [link.getAttribute('href'), link.textContent])).toEqual(destinations);
    expect(header.querySelector('.nav-account-link')?.getAttribute('aria-current')).toBe('page');
  });
});
