// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SlackLink } from './SlackLink';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });
const computers = [{ id: 'mac', name: 'MacBook', live: true }];
it('requires choosing an owned computer and explicit approval before revealing a local activation code', async () => {
  window.history.replaceState({}, '', `/connect/?slack=${'x'.repeat(22)}`);
  const fetcher = vi.fn(async (path: string) => Response.json(path.includes('/info/') ? { team: 'Zana', user: 'Alice', userId: 'U123456' } : path.includes('/approve/') ? { activationCode: 'private-code', computer: 'MacBook' } : { links: [] }));
  vi.stubGlobal('fetch', fetcher); render(<SlackLink computers={computers} />);
  const button = await screen.findByRole('button', { name: 'Link this identity and computer' }); expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Computer'), { target: { value: 'mac' } }); fireEvent.click(button);
  expect((await screen.findByLabelText('Activation code') as HTMLInputElement).value).toBe('private-code');
  expect(window.location.search).toBe('');
  expect(fetcher.mock.calls.some(([path]) => path === '/api/connect/slack/approve/')).toBe(true);
});
it('lists links and revokes access, keeping failures visible', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ links: [{ id: 'one', slack_user: 'U123456', team_id: 'T123456', state: 'active', computer: 'MacBook' }] })).mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(Response.json({ revoked: true }));
  vi.stubGlobal('fetch', fetcher); render(<SlackLink computers={computers} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Revoke Slack access' })); expect((await screen.findByRole('alert')).textContent).toContain('not enabled');
  fireEvent.click(screen.getByRole('button', { name: 'Revoke Slack access' })); await waitFor(() => expect(screen.queryByRole('button', { name: 'Revoke Slack access' })).toBeNull());
});
it('shows expired and failed approvals without auto-selecting a computer', async () => {
  window.history.replaceState({}, '', `/connect/?slack=${'x'.repeat(22)}`);
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.includes('/info/') ? new Response('', { status: 410 }) : Response.json({ links: [] })));
  render(<SlackLink computers={[]} />); expect((await screen.findByRole('alert')).textContent).toContain('expired');
});
it('handles an unavailable service and a rejected approval without losing the selected computer', async () => {
  window.history.replaceState({}, '', `/connect/?slack=${'x'.repeat(22)}`);
  const fetcher = vi.fn(async (path: string) => path.includes('/info/') ? Response.json({ team: 'Zana', user: 'Alice', userId: 'U123456' }) : path.includes('/approve/') ? new Response('', { status: 403 }) : new Response('', { status: 503 }));
  vi.stubGlobal('fetch', fetcher); render(<SlackLink computers={[...computers, { id: 'other', name: 'Other Mac', live: false }]} />);
  expect((await screen.findByRole('alert')).textContent).toContain('not enabled');
  fireEvent.change(screen.getByLabelText('Computer'), { target: { value: 'mac' } });
  fireEvent.click(screen.getByRole('button', { name: 'Link this identity and computer' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not update'));
  expect((screen.getByLabelText('Computer') as HTMLSelectElement).value).toBe('mac');
});
