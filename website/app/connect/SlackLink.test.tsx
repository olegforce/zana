// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SlackLink } from './SlackLink';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });
beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => {}) } });
});
const computers = [{ id: 'mac', name: 'MacBook', live: true }];
it('requires choosing an owned computer and explicit approval before revealing a local activation code', async () => {
  window.history.replaceState({}, '', `/connect/?slack=${'x'.repeat(22)}`);
  const fetcher = vi.fn(async (path: string) => Response.json(path.includes('/info/') ? { team: 'Zana', user: 'Alice', userId: 'U123456' } : path.includes('/approve/') ? { activationCode: 'private-code', computer: 'MacBook' } : { links: [] }));
  vi.stubGlobal('fetch', fetcher); render(<SlackLink computers={computers} />);
  const button = await screen.findByRole('button', { name: 'Link this identity and computer' }); expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Computer'), { target: { value: 'mac' } }); fireEvent.click(button);
  expect((await screen.findByLabelText('Activation code') as HTMLInputElement).value).toBe('private-code');
  fireEvent.click(screen.getByRole('button', { name: 'Copy activation code' }));
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('private-code'));
  expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
  const open = screen.getByRole('link', { name: 'Open Zana setup' });
  expect(open.getAttribute('href')).toBe('http://127.0.0.1:8780/plugins/slack-bridge-2ff2/main/connect');
  expect(open.getAttribute('href')).not.toContain('private-code');
  expect(window.location.search).toBe('');
  expect(fetcher.mock.calls.some(([path]) => path === '/api/connect/slack/approve/')).toBe(true);
});
it('keeps manual selection available when clipboard access is blocked', async () => {
  window.history.replaceState({}, '', `/connect/?slack=${'x'.repeat(22)}`);
  vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('Denied'));
  vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path.includes('/info/') ? { team: 'Zana', user: 'Alice', userId: 'U123456', serverId: 'mac' } : path.includes('/approve/') ? { activationCode: 'private-code', computer: 'MacBook' } : { links: [] })));
  render(<SlackLink computers={computers} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Link this identity and computer' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Copy activation code' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Select the activation code');
  expect((screen.getByLabelText('Activation code') as HTMLInputElement).readOnly).toBe(true);
});
it('lists links and revokes access, keeping failures visible', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ links: [{ id: 'one', slack_user: 'U123456', team_id: 'T123456', state: 'active', computer: 'MacBook' }] })).mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(Response.json({ revoked: true }));
  vi.stubGlobal('fetch', fetcher); render(<SlackLink computers={computers} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Revoke Slack access for U123456 in T123456' })); expect((await screen.findByRole('alert')).textContent).toContain('not enabled');
  fireEvent.click(screen.getByRole('button', { name: 'Revoke Slack access for U123456 in T123456' })); await waitFor(() => expect(screen.queryByRole('button', { name: 'Revoke Slack access for U123456 in T123456' })).toBeNull());
});
it('distinguishes active and pending connections and revokes only the selected Slack identity', async () => {
  const links = [
    { id: 'active', slack_user: 'U123456', team_id: 'T123456', state: 'active', computer: 'MacBook' },
    { id: 'pending', slack_user: 'U654321', team_id: 'T654321', state: 'pending', computer: 'MacBook' },
  ];
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ links })).mockResolvedValueOnce(Response.json({ revoked: true }));
  vi.stubGlobal('fetch', fetcher); render(<SlackLink computers={computers} />);
  const list = await screen.findByRole('list', { name: 'Slack connections' });
  const rows = within(list).getAllByRole('listitem');
  expect(within(rows[0]).getByText('Connected')).toBeTruthy();
  expect(within(rows[0]).getByText('U123456')).toBeTruthy();
  expect(within(rows[0]).queryByText(/Finish connecting/)).toBeNull();
  expect(within(rows[1]).getByText('Awaiting activation')).toBeTruthy();
  expect(within(rows[1]).getByText('T654321')).toBeTruthy();
  expect(within(rows[1]).getByText('Finish connecting in Zana for Slack on this computer.')).toBeTruthy();
  expect(screen.getByLabelText('2 Slack connections')).toBeTruthy();
  fireEvent.click(within(rows[1]).getByRole('button', { name: 'Revoke Slack access for U654321 in T654321' }));
  await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1));
  expect(screen.getByText('U123456')).toBeTruthy();
  expect(fetcher).toHaveBeenLastCalledWith('/api/connect/slack/revoke/', expect.objectContaining({ body: JSON.stringify({ id: 'pending' }) }));
});
it('shows a known workspace name while preserving its ID and falling back for unknown workspaces', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ links: [
    { id: 'known', slack_user: 'U123456', team_id: 'T123456', team_name: 'Acme Engineering', state: 'active', computer: 'MacBook' },
    { id: 'unknown', slack_user: 'U654321', team_id: 'T654321', team_name: null, state: 'pending', computer: 'MacBook' },
  ] })));
  render(<SlackLink computers={computers} />);
  expect((await screen.findByText('Acme Engineering')).getAttribute('title')).toBe('T123456');
  expect(screen.queryByText('T123456')).toBeNull();
  expect(screen.getByText('T654321')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Revoke Slack access for U123456 in Acme Engineering' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Revoke Slack access for U654321 in T654321' })).toBeTruthy();
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

it('confirms the server-verified domain without permitting a different computer selection', async () => {
  window.history.replaceState({}, '', `/connect/?slack=${'x'.repeat(22)}`);
  const fetcher = vi.fn(async (path: string) => Response.json(path.includes('/info/') ? { team: 'Sandbox', user: 'Alice', userId: 'U123456', domain: 'alice-work.zana-ide.com', serverId: 'mac' } : path.includes('/approve/') ? { activationCode: 'private-code', computer: 'MacBook' } : { links: [] }));
  vi.stubGlobal('fetch', fetcher); render(<SlackLink computers={[...computers, { id: 'other', name: 'Other', live: true }]} />);
  expect(await screen.findByText('alice-work.zana-ide.com')).toBeTruthy();
  expect(screen.queryByRole('combobox')).toBeNull();
  const button = screen.getByRole('button', { name: 'Link this identity and computer' });
  expect(fetcher.mock.calls.some(([path]) => path.includes('/approve/'))).toBe(false);
  fireEvent.click(button);
  expect(await screen.findByLabelText('Activation code')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open Zana setup' }).getAttribute('href')).toBe('http://127.0.0.1:8780/plugins/slack-bridge-2ff2/main/connect');
  expect(fetcher).toHaveBeenCalledWith('/api/connect/slack/approve/', expect.objectContaining({ body: JSON.stringify({ code: 'x'.repeat(22), serverId: 'mac', approved: true }) }));
});

it('explains wrong-account domains without offering a fallback computer', async () => {
  window.history.replaceState({}, '', `/connect/?slack=${'x'.repeat(22)}`);
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.includes('/info/') ? Response.json({ error: 'domain_not_owned' }, { status: 403 }) : Response.json({ links: [] })));
  render(<SlackLink computers={computers} />);
  expect((await screen.findByRole('alert')).textContent).toContain('Sign in with its owner account');
  expect(screen.queryByRole('button', { name: 'Link this identity and computer' })).toBeNull();
});

it('shows owned domain addresses alongside computers in generic setup', async () => {
  window.history.replaceState({}, '', `/connect/?slack=${'x'.repeat(22)}`);
  vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path.includes('/info/') ? { team: 'Sandbox', user: 'Alice', userId: 'U123456' } : { links: [] })));
  render(<SlackLink computers={[{ ...computers[0], browserUrl: 'https://alice-work.zana-ide.com' }]} />);
  expect(await screen.findByRole('option', { name: 'alice-work.zana-ide.com · MacBook · Online' })).toBeTruthy();
});

it('opens the selected owned domain without putting the activation code in the URL', async () => {
  window.history.replaceState({}, '', `/connect/?slack=${'x'.repeat(22)}`);
  vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path.includes('/info/') ? { team: 'Sandbox', user: 'Alice', userId: 'U123456', domain: 'alice-work.zana-ide.com', serverId: 'mac' } : path.includes('/approve/') ? { activationCode: 'private-code', computer: 'MacBook' } : { links: [] })));
  render(<SlackLink computers={[{ ...computers[0], browserUrl: 'https://alice-work.zana-ide.com/account?ignored=1' }]} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Link this identity and computer' }));
  const href = (await screen.findByRole('link', { name: 'Open Zana setup' })).getAttribute('href');
  expect(href).toBe('https://alice-work.zana-ide.com/plugins/slack-bridge-2ff2/main/connect');
  expect(href).not.toContain('private-code');
});

it.each(['javascript:alert(1)', 'not a URL'])('falls back to the local app for an unsafe computer address: %s', async browserUrl => {
  window.history.replaceState({}, '', `/connect/?slack=${'x'.repeat(22)}`);
  vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path.includes('/info/') ? { team: 'Sandbox', user: 'Alice', userId: 'U123456', domain: 'alice-work.zana-ide.com', serverId: 'mac' } : path.includes('/approve/') ? { activationCode: 'private-code', computer: 'MacBook' } : { links: [] })));
  render(<SlackLink computers={[{ ...computers[0], browserUrl }]} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Link this identity and computer' }));
  expect((await screen.findByRole('link', { name: 'Open Zana setup' })).getAttribute('href')).toBe('http://127.0.0.1:8780/plugins/slack-bridge-2ff2/main/connect');
});
