// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { HostInstallDrawer, HostInstallDrawerView } from '../HostInstallDrawer.js';
import { EMPTY_HOST_INSTALL_DRAWER, HOST_INSTALL_SUCCESS_CLOSE_MS } from '../../lib/host-install-drawer.js';
import { useUi } from '../../store.js';
import { copyText } from '../../lib/copy-text.js';

vi.mock('../../lib/copy-text.js', () => ({ copyText: vi.fn() }));
beforeEach(() => useUi.setState({ hostInstallDrawer: EMPTY_HOST_INSTALL_DRAWER }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

describe('HostInstallDrawerView', () => {
  it('renders live logs, the failure, and a copy-command footer', () => {
    const html = renderToStaticMarkup(
      <HostInstallDrawerView
        busy={false}
        kind="install"
        target="limited-pony"
        logs={['Installing host daemon over SSH…', 'host daemon did not report connected']}
        error="The host daemon started but never connected back. Retry, or copy the SSH command."
        pairingCommand="ssh -R 18782:127.0.0.1:8780 limited-pony 'curl …'"
        onClose={vi.fn()}
        onCopyPairing={vi.fn()}
      />
    );
    expect(html).toContain('data-testid="host-install-drawer"');
    expect(html).toContain('Install failed');
    expect(html).toContain('limited-pony');
    expect(html).toContain('host daemon did not report connected');
    expect(html).toContain('never connected back');
    expect(html).toContain('Copy install command');
    expect(html).toContain('quick-access-panel host-install-drawer');
    expect(html).toContain('Remote daemon · limited-pony');
    expect(html).toContain('role="alert"');
  });

  it('sits beside the notifications drawer in the shell', () => {
    const app = readFileSync(new NodeURL('../../App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('<HostInstallDrawer />');
    expect(app).toContain('<NotificationsDrawer />');
  });

  it('shows a waiting state and supports close and Escape without closing on other keys', () => {
    const onClose = vi.fn();
    const view = render(<HostInstallDrawerView busy kind="install" target={null} logs={[]}
      error={null} pairingCommand={null} onClose={onClose} />);
    expect(screen.getByText('Waiting for install output')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Installing…');
    expect(screen.queryByTestId('host-install-copy-command')).toBeNull();
    const close = screen.getByRole('button', { name: 'Close install log' });
    fireEvent.keyDown(close, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(close, { key: 'Escape' });
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(2);
    view.rerender(<HostInstallDrawerView busy={false} kind="install" target={null} logs={[]}
      error="Permission denied" pairingCommand="ssh box" onClose={onClose} />);
    expect(screen.getByRole('alert').textContent).toBe('Permission denied');
    expect(screen.queryByTestId('host-install-log')).toBeNull();
    expect(screen.queryByTestId('host-install-copy-command')).toBeNull();
  });

  it('follows appended output and copies the command through the shell action', () => {
    useUi.getState().openHostInstallDrawer({ kind: 'fix', target: 'remote-box' });
    const view = render(<HostInstallDrawer />);
    act(() => useUi.getState().appendHostInstallLogs(['Checking remote daemon…']));
    const log = screen.getByTestId('host-install-log');
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 200 });
    act(() => useUi.getState().appendHostInstallLogs(['Permission denied']));
    expect(log.scrollTop).toBe(200);
    act(() => useUi.getState().finishHostInstallDrawer({ ok: false, message: 'Permission denied', pairingCommand: 'ssh remote-box' }));
    fireEvent.click(screen.getByTestId('host-install-copy-command'));
    expect(copyText).toHaveBeenCalledWith('ssh remote-box');
    fireEvent.click(screen.getByRole('button', { name: 'Close install log' }));
    expect(screen.queryByTestId('host-install-drawer')).toBeNull();
    view.unmount();
  });

  it('auto-closes success, leaves failure open and keeps reopened successful logs available', () => {
    vi.useFakeTimers();
    useUi.getState().openHostInstallDrawer({ kind: 'fix', target: 'remote-box' });
    render(<HostInstallDrawer />);
    act(() => useUi.getState().finishHostInstallDrawer({ ok: true }));
    expect(screen.getByRole('status').textContent).toBe('Reconnected');
    act(() => vi.advanceTimersByTime(HOST_INSTALL_SUCCESS_CLOSE_MS));
    expect(screen.queryByTestId('host-install-drawer')).toBeNull();
    act(() => useUi.getState().setHostInstallDrawerOpen(true));
    act(() => vi.advanceTimersByTime(HOST_INSTALL_SUCCESS_CLOSE_MS));
    expect(screen.getByTestId('host-install-drawer')).toBeTruthy();
    act(() => useUi.getState().openHostInstallDrawer({ kind: 'install', target: 'remote-box' }));
    act(() => useUi.getState().finishHostInstallDrawer({ ok: false, message: 'Permission denied' }));
    act(() => vi.advanceTimersByTime(HOST_INSTALL_SUCCESS_CLOSE_MS));
    expect(screen.getByRole('alert').textContent).toBe('Permission denied');
  });

  it('cleans up the success timer if another installation starts or the panel unmounts', () => {
    vi.useFakeTimers();
    useUi.getState().openHostInstallDrawer({ kind: 'install', target: 'first' });
    const view = render(<HostInstallDrawer />);
    act(() => useUi.getState().finishHostInstallDrawer({ ok: true }));
    act(() => useUi.getState().openHostInstallDrawer({ kind: 'install', target: 'second' }));
    act(() => vi.advanceTimersByTime(HOST_INSTALL_SUCCESS_CLOSE_MS));
    expect(screen.getByRole('status').textContent).toBe('Installing…');
    act(() => useUi.getState().finishHostInstallDrawer({ ok: true }));
    view.unmount();
    act(() => vi.advanceTimersByTime(HOST_INSTALL_SUCCESS_CLOSE_MS));
    expect(useUi.getState().hostInstallDrawer.open).toBe(true);
  });
});
