/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@zana-ai/zcc-domain/product';
import { PhoneTab } from './PhoneSettingsView.js';

const mobile = {
  status: vi.fn(),
  pair: vi.fn(),
  devices: vi.fn(),
  revoke: vi.fn(),
  redeemComputerCode: vi.fn()
};

vi.mock('../../lib/product-client.js', () => ({
  product: {
    get mobile() {
      return mobile;
    }
  }
}));

// happy-dom has no canvas — stub the QR renderer to a deterministic data URL.
vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,QRSTUB') }
}));

vi.mock('../../components/AgentLauncher.js', () => ({
  AgentLauncher: ({ initialPrompt, onClose }: { initialPrompt: string; onClose(): void }) => (
    <div role="dialog" aria-label="New agent">
      <textarea aria-label="Message" defaultValue={initialPrompt} />
      <button onClick={onClose}>Close composer</button>
    </div>
  )
}));

const baseConfig = (patch: Partial<AppConfig> = {}): AppConfig => ({
  version: 1,
  theme: 'system',
  shell: '/bin/zsh',
  claudeBinary: 'claude',
  fontSize: 13,
  lastProjectId: null,
  ...patch
});

const runningStatus = {
  running: true,
  publicUrl: 'https://s-aaaaaaaaaaaaaaaaaaaaaaaa.connect.example.com',
  host: '127.0.0.1',
  port: 8785,
  boundLan: false,
  relayState: 'connected',
  connection: { mode: 'connect', accountUrl: 'https://example.com', hasRelayToken: true },
  error: null
};

beforeEach(() => {
  mobile.status.mockResolvedValue({ running: false, publicUrl: null, host: null, port: null, boundLan: false, error: null });
  mobile.devices.mockResolvedValue([]);
  mobile.pair.mockResolvedValue({
    version: 1,
    serverUrl: 'http://192.168.1.42:8785',
    code: 'abc123def456ghi789jkl0',
    expiresAt: Date.now() + 5 * 60_000
  });
  mobile.revoke.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PhoneTab', () => {
  it('explains installation and phone setup before phone access is enabled', async () => {
    await act(async () => {
      render(<PhoneTab config={baseConfig()} onConfigDraft={vi.fn()} onUpdate={vi.fn()} />);
    });
    expect(within(screen.getByRole('list', { name: 'Phone setup steps' })).getAllByRole('listitem')).toHaveLength(4);
    const installation = screen.getByRole('region', { name: '1. Install Zana' });
    expect(within(installation).getByRole('list', { name: 'Install Zana on iPhone' }).children).toHaveLength(3);
    expect(within(installation).getByRole('status').textContent).toContain('Installing TestFlight alone will not install Zana');
    expect(within(installation).queryByRole('link', { name: 'Get Zana on TestFlight' })).toBeNull();
    expect(within(installation).queryByAltText('TestFlight installation QR code')).toBeNull();
    expect(within(installation).getByText('Install with a USB cable (iPhone or Android)').closest('details')).toBeTruthy();
    expect(within(installation).getByRole('list', { name: 'Install Zana with a USB cable' }).children).toHaveLength(5);
    expect(screen.getByText(/choose an agent, review the request, and click Send/)).toBeTruthy();
    expect(screen.getByText(/Developer Mode, turn it on, restart/)).toBeTruthy();
    expect(screen.getByText(/enable USB debugging/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Development install with AI' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mobile.pair).not.toHaveBeenCalled();
  });

  it('opens an editable installation prompt without enabling access or starting pairing', async () => {
    const onUpdate = vi.fn();
    await act(async () => {
      render(<PhoneTab config={baseConfig()} onConfigDraft={vi.fn()} onUpdate={onUpdate} />);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Development install with AI' }));
    const input = within(screen.getByRole('dialog', { name: 'New agent' })).getByLabelText('Message') as HTMLTextAreaElement;
    expect(input.value).toContain('Install or update the Zana mobile app on my connected physical phone');
    expect(input.value).toContain('If the target is ambiguous, ask me which phone');
    expect(input.value).toContain('docs/mobile-app.md');
    expect(input.value).toContain('existing Apple signing account');
    expect(input.value).toContain('Preserve existing app data');
    expect(input.value).toContain('Verify the installed app launches');
    fireEvent.change(input, { target: { value: 'Install Zana on my Android phone.' } });
    expect(input.value).toBe('Install Zana on my Android phone.');
    expect(onUpdate).not.toHaveBeenCalled();
    expect(mobile.pair).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close composer' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Development install with AI' }));
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toContain('Install or update the Zana mobile app');
  });

  it('persists the online enable toggle through onUpdate', async () => {
    mobile.status.mockResolvedValue(runningStatus);
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      render(<PhoneTab config={baseConfig()} onConfigDraft={vi.fn()} onUpdate={onUpdate} />);
    });
    fireEvent.click(screen.getByRole('switch', { name: 'Enable phone access' }));
    expect(onUpdate).toHaveBeenCalledWith({ mobileGatewayEnabled: true });
  });

  it('revokes a paired device', async () => {
    mobile.status.mockResolvedValue(runningStatus);
    mobile.devices.mockResolvedValue([{ id: 'd1', label: 'My iPhone', createdAt: 0, expiresAt: Date.now() + 1e9 }]);
    await act(async () => {
      render(
        <PhoneTab config={baseConfig({ mobileGatewayEnabled: true })} onConfigDraft={vi.fn()} onUpdate={vi.fn()} />
      );
    });
    await waitFor(() => expect(screen.getByText('My iPhone')).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Revoke My iPhone' }));
    });
    expect(mobile.revoke).toHaveBeenCalledWith('d1');
  });
});

it('shows the TestFlight installation QR without a connection QR', async () => {
  mobile.status.mockResolvedValue({ ...runningStatus, distribution: { testFlightUrl: 'https://testflight.apple.com/join/Abcd1234' } });
  render(<PhoneTab config={baseConfig({ mobileGatewayEnabled: true })} onConfigDraft={vi.fn()} onUpdate={vi.fn()} />);
  await waitFor(() => expect(screen.getByAltText('TestFlight installation QR code')).toBeTruthy());
  expect(screen.getByRole('link', { name: 'View TestFlight in the App Store' }).getAttribute('href')).toBe('https://apps.apple.com/app/testflight/id899247664');
  expect(screen.getByText(/search for “TestFlight” by Apple, and tap Get/)).toBeTruthy();
  expect(screen.getByText(/tap Accept and Install for Zana/)).toBeTruthy();
  expect(screen.getByText(/Tap Open in TestFlight or the Zana icon/)).toBeTruthy();
  expect(screen.queryByText(/Zana’s TestFlight invitation is not available yet/)).toBeNull();
  expect(screen.getByRole('link', { name: 'Get Zana on TestFlight' }).getAttribute('href')).toBe('https://testflight.apple.com/join/Abcd1234');
  expect(screen.queryByAltText('Zana Mobile pairing QR code')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'I already have Zana installed' }));
  expect((screen.getByRole('button', { name: /App installed/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(mobile.pair).not.toHaveBeenCalled();
});
it('does not turn a saved pairing or an expired report into a verified connection', async () => {
  mobile.status.mockResolvedValue({ ...runningStatus, readySessions: [{ id: 'old', label: 'Old phone', platform: 'ios', appVersion: '0.1.0', lastSeenAt: Date.now() - 60_000 }] });
  mobile.devices.mockResolvedValue([{ id: 'saved', label: 'Saved phone', createdAt: 0, expiresAt: Date.now() + 1e9 }]);
  render(<PhoneTab config={baseConfig({ mobileGatewayEnabled: true })} onConfigDraft={vi.fn()} onUpdate={vi.fn()} />);
  await screen.findByText('Saved phone');
  expect(screen.queryByText(/Setup complete/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'I see my projects on this phone' })).toBeNull();
});
it('requires a current authenticated shell and phone confirmation, and clears success offline', async () => {
  mobile.status.mockResolvedValue({ ...runningStatus, readySessions: [{ id: 'live', label: 'Current phone', platform: 'ios', appVersion: '2.3.0', lastSeenAt: Date.now() }] });
  render(<PhoneTab config={baseConfig({ mobileGatewayEnabled: true })} onConfigDraft={vi.fn()} onUpdate={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'I see my projects on this phone' }));
  expect(screen.getByText(/Setup complete/)).toBeTruthy();
  mobile.status.mockRejectedValueOnce(new Error('credentials-must-not-appear'));
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  await screen.findByText(/Could not read the desktop/);
  expect(screen.queryByText(/Setup complete/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Ask AI for help' }));
  const prompt = (screen.getByLabelText('Message') as HTMLTextAreaElement).value;
  expect(prompt).toContain('Do not rebuild');
  expect(prompt).not.toContain('credentials-must-not-appear');
  expect(prompt).not.toContain('192.168');
});
it('offers recovery for a retired local configuration without exposing local controls', async () => {
  mobile.status.mockResolvedValue({ running: false, connection: undefined, error: 'Local-network connections are no longer supported. Open Remote access.' });
  render(<PhoneTab config={baseConfig({ mobileGatewayEnabled: true })} onConfigDraft={vi.fn()} onUpdate={vi.fn()} />);
  await screen.findByRole('button', { name: 'Ask AI for help' });
  expect(screen.getByRole('alert').textContent).toContain('Local-network connections are no longer supported');
  expect(screen.queryByLabelText('Connection method')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Show pairing QR' })).toBeNull();
  expect(screen.queryByText('Advanced connection options')).toBeNull();
  expect(screen.getByText(/Open Zana Mobile → Continue with GitHub/)).toBeTruthy();
  expect(mobile.pair).not.toHaveBeenCalled();
});
it('does not confirm a phone while the Connect tunnel is reconnecting', async () => {
  mobile.status.mockResolvedValue({ ...runningStatus, relayState: 'reconnecting', readySessions: [{ id: 'live', lastSeenAt: Date.now() }] });
  render(<PhoneTab config={baseConfig({ mobileGatewayEnabled: true })} onConfigDraft={vi.fn()} onUpdate={vi.fn()} />);
  await screen.findByText('Connecting to Zana Connect…');
  expect(screen.queryByRole('button', { name: 'I see my projects on this phone' })).toBeNull();
});
it('connects this computer from Phone setup and enables only the authenticated account gateway', async () => {
  mobile.redeemComputerCode.mockResolvedValue(undefined);
  const onUpdate = vi.fn().mockResolvedValue(undefined);
  render(<PhoneTab config={baseConfig()} onConfigDraft={vi.fn()} onUpdate={onUpdate} />);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Connect code', exact: true }), { target: { value: 'ABCD1234ABCD1234' } });
  await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ mobileGatewayEnabled: true }));
  expect(mobile.redeemComputerCode).toHaveBeenCalled(); expect(mobile.pair).not.toHaveBeenCalled();
});
it('shows account connection status and reports a failed toggle without falling back to LAN', async () => {
  const connected = { ...runningStatus, boundLan: false, relayState: 'connected', connection: { mode: 'connect', accountUrl: 'https://zana-ide.com', publicUrl: 'https://s-example.connect.zana-ide.com', hasRelayToken: true } };
  mobile.status.mockResolvedValue(connected);
  const onUpdate = vi.fn().mockRejectedValue(new Error('offline'));
  const view = render(<PhoneTab config={baseConfig({ mobileGatewayEnabled: true })} onConfigDraft={vi.fn()} onUpdate={onUpdate} />);
  await screen.findByText('Connected to Zana Connect');
  expect(screen.getByRole('link', { name: 'Manage account and choose your domain' }).getAttribute('href')).toBe('https://zana-ide.com/connect/');
  fireEvent.click(screen.getByRole('switch', { name: 'Enable phone access' }));
  await screen.findByText('Could not update phone access. Try again.');
  view.rerender(<PhoneTab config={baseConfig()} onConfigDraft={vi.fn()} onUpdate={onUpdate} />);
  await screen.findByText('Remote access is off');
});
