import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { AppConfig } from '@zana-ai/zcc-domain/product';
import { product } from '../../lib/product-client.js';
import { Section, CheckboxField } from '@/components/settings/FormFields';
import { AgentLauncher } from '../../components/AgentLauncher.js';
import { MOBILE_INSTALL_PROMPT, mobileRecoveryPrompt } from './mobile-install-prompt.js';
import './phone-settings.css';
import { ConnectCodePairing } from './ConnectCodePairing.js';

interface PhoneViewProps {
  config: AppConfig;
  onConfigDraft: (config: AppConfig) => void;
  onUpdate: (patch: Partial<AppConfig>) => Promise<void>;
}

type MobileStatus = Awaited<ReturnType<typeof product.mobile.status>>;
type MobileDevice = Awaited<ReturnType<typeof product.mobile.devices>>[number];

/** Phone access uses the authenticated Zana Connect tunnel exclusively. */
export function PhoneView({ config, onUpdate }: PhoneViewProps) {
  const enabled = config.mobileGatewayEnabled ?? false;
  const [status, setStatus] = useState<MobileStatus | null>(null);
  const [devices, setDevices] = useState<MobileDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [agentPrompt, setAgentPrompt] = useState<string | null>(null);
  const [installed, setInstalled] = useState(false);
  const [installQr, setInstallQr] = useState('');
  const [troubleshooting, setTroubleshooting] = useState(false);
  const [confirmedSession, setConfirmedSession] = useState<string | null>(null);
  const [statusUnavailable, setStatusUnavailable] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await product.mobile.status());
      setStatusUnavailable(false);
    } catch {
      setStatusUnavailable(true);
      setStatus(null);
    }
  }, []);
  const refreshDevices = useCallback(async () => {
    try {
      setDevices(await product.mobile.devices());
    } catch {
      setDevices([]);
    }
  }, []);

  // Poll status while enabling settles (start is async in main); also refresh
  // the paired-device list. A short poll is enough — the panel is small and the
  // listener flips within a tick of the toggle.
  useEffect(() => {
    void refreshStatus();
    void refreshDevices();
    const timer = setInterval(() => { void refreshStatus(); setNow(Date.now()); }, 2000);
    return () => clearInterval(timer);
  }, [refreshStatus, refreshDevices, enabled]);

  const testFlightUrl = status?.distribution?.testFlightUrl ?? null;
  useEffect(() => {
    let cancelled = false;
    setInstallQr('');
    if (testFlightUrl) void QRCode.toDataURL(testFlightUrl, { margin: 2, width: 200 })
      .then(url => { if (!cancelled) setInstallQr(url); }).catch(() => {});
    return () => { cancelled = true; };
  }, [testFlightUrl]);

  const running = status?.running ?? false;
  const online = status?.connection?.mode === 'connect';
  const connectionReady = online && enabled && running && !statusUnavailable && status?.relayState === 'connected';
  const readySessions = connectionReady ? (status?.readySessions ?? []).filter(session => now - session.lastSeenAt < 30_000) : [];
  const verified = readySessions.some(session => session.id === confirmedSession);
  const step = verified ? 4 : !installed && !readySessions.length ? 1 : !connectionReady ? 2 : !readySessions.length ? 3 : 4;

  const revoke = useCallback(
    async (id: string) => {
      try {
        const revoked = await product.mobile.revoke(id);
        if (!revoked) setError('Could not revoke this phone. Check again and retry.');
      } catch {
        setError('Could not revoke this phone. Check again and retry.');
      } finally {
        void refreshDevices();
      }
    },
    [refreshDevices]
  );

  return (
    <Section
      anchorId="phone"
      title="Phone"
      help="Install Zana on your phone, then sign in with GitHub to use your projects and agents on the go."
    >
      <ol className="phone-setup-progress" aria-label="Phone setup steps">
        {['Install Zana', 'Connect computer', 'Sign in on phone', 'Verify connection'].map((label, index) => (
          <li key={label} aria-current={step === index + 1 ? 'step' : undefined}>
            <span aria-hidden="true">{index + 1}</span>{label}
          </li>
        ))}
      </ol>
      <section className="phone-setup-stage" aria-labelledby="phone-install-title">
        <h2 id="phone-install-title">1. Install Zana</h2>
        <p className="settings-help">On your iPhone, you’ll install two apps: TestFlight from Apple, then Zana through its invitation. TestFlight lets you install the Zana beta without a cable or Developer Mode.</p>
        {!testFlightUrl && <p className="phone-install-notice" role="status">Zana’s TestFlight invitation is not available yet. Installing TestFlight alone will not install Zana. To install Zana now, open “Install with a USB cable” below.</p>}
        <ol className="phone-install-steps" aria-label="Install Zana on iPhone">
          <li>
            <strong>Get TestFlight on your iPhone.</strong> Open the App Store on your phone, search for “TestFlight” by Apple, and tap Get. If you already have it, skip this step.{' '}
            <a href="https://apps.apple.com/app/testflight/id899247664" target="_blank" rel="noreferrer">View TestFlight in the App Store</a>
          </li>
          <li>
            <strong>Install Zana from its invitation.</strong>{' '}
            {testFlightUrl ? <>
              Open your iPhone’s Camera app and scan this installation QR. Tap the link, choose View in TestFlight or Start Testing if prompted, then tap Accept and Install for Zana.
              <div className="phone-install-invitation">
                {installQr && <img className="phone-install-qr" src={installQr} width={200} height={200} alt="TestFlight installation QR code" />}
                <a className="btn primary" href={testFlightUrl} target="_blank" rel="noreferrer">Get Zana on TestFlight</a>
              </div>
              <span>This QR installs the app. In step 3, sign in with GitHub to connect to your computer.</span>
            </> : <span>When the invitation is available, its QR and link will appear here. Scan it with your iPhone’s Camera app, accept the invitation in TestFlight, then tap Install for Zana.</span>}
          </li>
          <li><strong>Open Zana on your iPhone.</strong> Tap Open in TestFlight or the Zana icon on your Home Screen. Keep Zana open, then return to this computer and continue below. You’ll connect your phone in the next steps.</li>
        </ol>
        <button type="button" className="btn" onClick={() => setInstalled(true)} disabled={installed}>
          {installed ? 'App installed — continue to step 2' : 'I already have Zana installed'}
        </button>
        <details className="phone-install-device-help phone-install-alternative">
          <summary>Install with a USB cable (iPhone or Android)</summary>
          <p>Use this development installation if the TestFlight invitation is unavailable or you’re using Android. It requires developer tools on this computer.</p>
          <ol className="phone-install-steps" aria-label="Install Zana with a USB cable">
            <li><strong>Prepare this computer.</strong> For iPhone, use a Mac with Xcode installed and sign in to your Apple account in Xcode → Settings → Accounts. For Android, install the Android SDK tools.</li>
            <li><strong>Connect and unlock your phone.</strong> Plug it into this computer with a USB cable. On iPhone, tap Trust if asked and enter your passcode on the phone.</li>
            <li><strong>Allow development apps.</strong> On iPhone, go to Settings → Privacy &amp; Security → Developer Mode, turn it on, restart the phone, then confirm Turn On and unlock it. On Android, enable USB debugging in Developer options and accept the authorization prompt on the phone.</li>
            <li><strong>Run the installation helper.</strong> Click Development install with AI below, choose an agent, review the request, and click Send. The agent will check your phone and tools, install or update Zana while preserving its data, and ask you to complete any steps that need your interaction. Enter Apple passwords and signing credentials only in Apple’s own prompts.</li>
            <li><strong>Open Zana and continue here.</strong> Once the installation finishes, open Zana on your phone and click “I already have Zana installed” above.</li>
          </ol>
          <button type="button" className="btn" onClick={() => setAgentPrompt(MOBILE_INSTALL_PROMPT)}>Development install with AI</button>
        </details>
      </section>
      <section className="phone-setup-stage" aria-labelledby="phone-connection-title">
        <h2 id="phone-connection-title">2. Connect this computer</h2>
        <p className="settings-help">Connect this computer to your GitHub account through Zana Connect. Your phone can reach it over Wi-Fi or cellular internet. Keep Zana open and this computer awake.</p>
        {online ? <>
          <p role="status">{connectionReady ? 'Connected to Zana Connect' : enabled ? 'Connecting to Zana Connect…' : 'Remote access is off'}</p>
          <a className="btn" href={`${status?.connection?.accountUrl}/connect/`} target="_blank" rel="noreferrer">Manage account and choose your domain</a>
          <CheckboxField label="Enable phone access" help="Allow authenticated phones on your GitHub account to use this computer through Zana Connect." checked={enabled} onChange={v => { void onUpdate({ mobileGatewayEnabled: v }).catch(() => setError('Could not update phone access. Try again.')); }} />
        </> : <ConnectCodePairing onPaired={async () => {
          await onUpdate({ mobileGatewayEnabled: true });
          setConfirmedSession(null); await refreshStatus(); await refreshDevices();
        }} />}
        {status?.error && <p role="alert">{status.error}</p>}
      </section>
      <section className="phone-setup-stage" aria-labelledby="phone-pair-title">
        <h2 id="phone-pair-title">3. Sign in on your phone</h2>
        <p className="settings-help">Open Zana Mobile → Continue with GitHub. Sign in with the same account, tap Approve phone, then return to Zana Mobile and choose this computer. Its online address appears in your computer list.</p>
        <p className="settings-help">No local-network permission or shared Wi-Fi is needed for Zana Connect.</p>
        {error && <p className="settings-help" role="alert">{error}</p>}
      </section>
      <section className="phone-setup-stage" aria-labelledby="phone-verify-title">
        <h2 id="phone-verify-title">4. Verify the connection</h2>
        <div aria-live="polite">
          {verified ? <p className="phone-setup-success">Phone connected. Setup complete.</p> :
            <p className="settings-help">{readySessions.length ? 'An authenticated phone app is open. Confirm the phone where you can see your projects.' : 'Waiting for Zana to open on your phone and connect to this computer…'}</p>}
          {readySessions.map(session => <div className="phone-ready-session" key={session.id}>
            <span>{session.label} · {session.platform === 'ios' ? 'iPhone' : 'Android'} · Zana {session.appVersion}</span>
            <button type="button" className="btn" disabled={session.id === confirmedSession} onClick={() => { setInstalled(true); setConfirmedSession(session.id); void refreshDevices(); }}>
              {session.id === confirmedSession ? 'Connection verified' : 'I see my projects on this phone'}
            </button>
          </div>)}
        </div>
        <p className="settings-help">Keep the phone app open during this check. Saved pairings alone do not confirm a live connection. Older mobile builds may need an update to report readiness.</p>
        <button type="button" className="btn" onClick={() => { void refreshStatus(); void refreshDevices(); }}>Check again</button>
      </section>

      {(error || status?.error || statusUnavailable || troubleshooting) ? <div className="phone-setup-stage">
        <p className="settings-help">{statusUnavailable ? 'Could not read the desktop connection status. Check again to retry.' : 'Check that Zana is open on both devices, this computer is awake, and both apps use the same GitHub account. Check Remote access on the computer and refresh the computer list on your phone.'}</p>
        <button type="button" className="btn" onClick={() => setAgentPrompt(mobileRecoveryPrompt({ step, enabled, running, connectionMode: status?.connection?.mode ?? 'unconfigured', hasInvitation: !!testFlightUrl, hasLivePhone: readySessions.length > 0 }))}>Ask AI for help</button>
      </div> : <button type="button" className="btn" onClick={() => setTroubleshooting(true)}>Something isn’t working</button>}

      {enabled && (
        <div className="settings-field">
          <span className="settings-label">Paired phones</span>
          {devices.length === 0 ? (
            <p className="settings-help">No phones paired yet.</p>
          ) : (
            <ul className="settings-device-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {devices.map((device) => (
                <li
                  key={device.id}
                  className="settings-device-row"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
                >
                  <span>{device.label}</span>
                  <button
                    type="button"
                    className="btn btn--danger"
                    aria-label={`Revoke ${device.label}`}
                    onClick={() => void revoke(device.id)}
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {agentPrompt && (
        <AgentLauncher
          initialPrompt={agentPrompt}
          onClose={() => setAgentPrompt(null)}
        />
      )}
    </Section>
  );
}

export { PhoneView as PhoneTab };
