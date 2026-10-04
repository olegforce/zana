// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import React from 'react';
import { ANALYTICS_CONSENT_KEY } from '../../lib/analytics';
import { GoogleAnalytics } from './GoogleAnalytics';

const route = vi.hoisted(() => ({ path: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => route.path }));
vi.mock('next/script', () => ({ default: ({ src }: { src: string }) => <script data-testid="google-tag" src={src} /> }));
const id = 'G-ABC1234567';
const target = window as Window & { dataLayer?: IArguments[]; gtag?: (...args: unknown[]) => void };
beforeEach(() => { route.path = '/'; localStorage.clear(); delete target.gtag; delete target.dataLayer; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('sends nothing and renders no script or choice without a valid ID', () => {
  const view = render(<GoogleAnalytics />);
  expect(view.container.innerHTML).toBe('');
  view.rerender(<GoogleAnalytics measurementId="invalid" />);
  expect(view.container.innerHTML).toBe('');
  expect(target.dataLayer).toBeUndefined();
});
it('waits for acceptance, tracks navigation once, and handles download clicks', async () => {
  const view = render(<GoogleAnalytics measurementId={id} />);
  await screen.findByRole('button', { name: 'Accept analytics' });
  expect(screen.queryByTestId('google-tag')).toBeNull();
  expect(target.dataLayer).toBeUndefined();
  fireEvent.click(screen.getByRole('button', { name: 'Accept analytics' }));
  await screen.findByTestId('google-tag');
  expect(localStorage.getItem(ANALYTICS_CONSENT_KEY)).toBe('granted');
  const events = () => target.dataLayer!.map(args => Array.from(args)).filter(args => args[0] === 'event');
  expect(events()).toHaveLength(1);
  view.rerender(<GoogleAnalytics measurementId={id} />);
  expect(events()).toHaveLength(1);
  route.path = '/docs/'; view.rerender(<GoogleAnalytics measurementId={id} />);
  expect(events()).toHaveLength(2);
  const link = document.createElement('a'); link.dataset.analytics = 'download'; document.body.append(link);
  fireEvent.click(link); expect(events().at(-1)?.[1]).toBe('download_click'); link.remove();
  fireEvent.click(document.body); expect(events()).toHaveLength(3);
  route.path = '/connect/'; view.rerender(<GoogleAnalytics measurementId={id} />);
  expect(screen.queryByTestId('google-tag')).toBeNull();
  expect(events()).toHaveLength(3);
  expect((window as unknown as Record<string, unknown>)[`ga-disable-${id}`]).toBe(true);
  route.path = '/'; view.rerender(<GoogleAnalytics measurementId={id} />);
  expect(events()).toHaveLength(4);
  fireEvent.click(screen.getByRole('button', { name: 'Analytics cookies' }));
  fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
  expect(screen.queryByTestId('google-tag')).toBeNull();
  expect(localStorage.getItem(ANALYTICS_CONSENT_KEY)).toBe('denied');
});
it('keeps declined visits untracked and permits changing the choice', async () => {
  localStorage.setItem(ANALYTICS_CONSENT_KEY, 'denied');
  render(<GoogleAnalytics measurementId={id} />);
  await screen.findByRole('button', { name: 'Analytics cookies' });
  expect(screen.queryByTestId('google-tag')).toBeNull();
  expect(target.dataLayer).toBeUndefined();
  fireEvent.click(screen.getByRole('button', { name: 'Analytics cookies' }));
  fireEvent.click(screen.getByRole('button', { name: 'Accept analytics' }));
  await screen.findByTestId('google-tag');
});
it('restores acceptance without destroying the returning visitor cookie', async () => {
  localStorage.setItem(ANALYTICS_CONSENT_KEY, 'granted');
  document.cookie = '_ga=returning; Path=/';
  render(<GoogleAnalytics measurementId={id} />);
  await screen.findByTestId('google-tag');
  expect(document.cookie).toContain('_ga=returning');
});
it('never loads Google on a private account page even with saved acceptance', async () => {
  route.path = '/connect/'; localStorage.setItem(ANALYTICS_CONSENT_KEY, 'granted');
  const view = render(<GoogleAnalytics measurementId={id} />);
  await waitFor(() => expect((window as unknown as Record<string, unknown>)[`ga-disable-${id}`]).toBe(true));
  expect(view.container.innerHTML).toBe('');
  expect(target.dataLayer).toBeUndefined();
});
