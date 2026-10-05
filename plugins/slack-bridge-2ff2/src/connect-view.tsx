import { useEffect, useRef, useState } from "react";

export function ConnectSetup({
  connection,
  disabled,
  focusCode = false,
  act,
  call,
}: {
  connection?: {
    linked: boolean;
    origin?: string;
    owner?: string;
    computer?: string;
  };
  disabled: boolean;
  focusCode?: boolean;
  act: (work: () => Promise<unknown>, success?: string) => Promise<void>;
  call: (method: string, args?: unknown) => Promise<unknown>;
}) {
  const [origin, setOrigin] = useState(
    connection?.origin ?? "https://zana-ide.com",
  );
  const [code, setCode] = useState("");
  const codeInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusCode && !connection?.linked) codeInput.current?.focus();
  }, [focusCode, connection?.linked]);
  return (
    <section
      aria-label="Slack account connection"
      style={{
        padding: 22,
        border: "1px solid var(--border, #42424a)",
        borderRadius: 12,
        marginBottom: 18,
      }}
    >
      <h2 style={{ fontSize: 17, marginTop: 0 }}>
        Connect your Slack account
      </h2>
      {connection?.linked ? (
        <>
          <p>
            <strong>{connection.computer}</strong> is linked to Slack user{" "}
            {connection.owner} through {connection.origin}.
          </p>
          <p>
            Use the connection controls to pause or reconnect. Unlinking also
            clears Project imports, channel mappings, and plugin tool permissions. Existing tasks remain in Zana.
          </p>
          <button
            className="settings-btn"
            disabled={disabled}
            onClick={() =>
              void act(
                () => call("unlinkConnect"),
                "Slack access revoked and mappings cleared.",
              )
            }
          >
            Unlink Zana Connect
          </button>
        </>
      ) : (
        <>
          <ol aria-label="Connection steps" style={{ paddingLeft: 22, lineHeight: 1.7 }}>
            <li><strong>Connect your computer.</strong> In Zana, open <strong>Settings → Remote access</strong> and connect your account.</li>
            <li><strong>Link Slack.</strong> Open <strong>Zana → Home → Connect my computer</strong> in Slack, sign in, and choose this computer.</li>
            <li><strong>Approve here.</strong> Paste the one-time activation code below.</li>
          </ol>
          <form
            style={{ maxWidth: 520 }}
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                await call("linkConnect", { origin, code: code.trim() });
                setCode("");
              }, "Connected. Choose the Projects and channels below.");
            }}
          >
            <details style={{ marginBottom: 16 }}>
              <summary>Advanced connection settings</summary>
              <div className="settings-field">
                <label>
                  <span className="settings-label">Connect service</span>
                  <input
                    type="url"
                    required
                    value={origin}
                    onChange={(event) => setOrigin(event.target.value)}
                  />
                </label>
              </div>
            </details>
            <div className="settings-field">
              <label>
                <span className="settings-label">Activation code</span>
                <input
                  ref={codeInput}
                  type="password"
                  required
                  autoComplete="off"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </label>
            </div>
            <button
              className="settings-btn settings-btn--primary"
              disabled={disabled || !code.trim()}
              type="submit"
            >
              Approve Slack access on this computer
            </button>
          </form>
          <p style={{ fontSize: 13 }}>
            No API keys or Slack tokens to configure. After connecting, choose your
            Projects below and enable any optional plugin tools under What Slack can do.
            Permissions and agent questions are answered in Zana.
          </p>
        </>
      )}
    </section>
  );
}
