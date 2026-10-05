import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
  useRef,
} from "react";
import {
  definePluginApp,
  useRealtime,
  useRpc,
  useZccNavigate,
  getPluginSettings,
  setPluginSettings,
} from "@zana-ai/zcc-plugin-sdk/app";
import {
  slackLink,
  type Route,
  type Binding,
  type Config,
  type Delivery,
  type Receipt,
} from "./src/model.js";
import { restoreSetupRoute } from "./src/setup-navigation.js";
import {
  ProjectImports,
  CapabilitySettings,
  settingsCss,
  type CapabilityView,
} from "./src/imports-view.js";
import { ConnectSetup } from "./src/connect-view.js";

type Snapshot = {
  conversationalChatReady?: boolean;
  reportInboxReady?: boolean;
  directSetup?: boolean;
  capabilities?: CapabilityView;
  connect?: {
    linked: boolean;
    origin?: string;
    owner?: string;
    computer?: string;
  };
  connection: string;
  embed?: {
    viaConnect?: boolean;
    origin: string;
    port: number;
    listening: boolean;
    error: string;
    lastPresented?: number;
  };
  home?: { url?: string; lastPublished?: number; error: string };
  homeLaunches?: { id: string; title: string; state: string; note: string }[];
  surfaceLog?: {
    id: string;
    title: string;
    state: string;
    note: string;
    url?: string;
  }[];
  projectSync?: {
    state: "idle" | "syncing" | "pending" | "complete" | "error";
    created: number;
    renamed: number;
    remaining: number;
    error: string;
    lastRun?: number;
  };
  config: Config;
  projects: { id: string; name: string }[];
  hosts: { id: string; name: string; status?: string }[];
  providers: { id: string; name: string }[];
  requests: Receipt[];
  bindings: Binding[];
  deliveries: Delivery[];
};
const box: CSSProperties = {
  padding: 22,
  border: "1px solid var(--border, #42424a)",
  borderRadius: 12,
  marginBottom: 18,
  background: "var(--bg-panel, rgba(127,127,127,.05))",
};
const row: CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "center",
  flexWrap: "wrap",
};
const field: CSSProperties = {
  display: "grid",
  gap: 6,
  flex: "1 1 180px",
  fontSize: 13,
};
const input: CSSProperties = {
  padding: "9px 11px",
  borderRadius: 7,
  border: "1px solid var(--border, #62626a)",
  background: "var(--bg-input, transparent)",
  color: "inherit",
  font: "inherit",
  minWidth: 0,
};
const button: CSSProperties = { ...input, cursor: "pointer", fontWeight: 600 };
const tag: CSSProperties = {
  fontSize: 12,
  padding: "4px 9px",
  borderRadius: 20,
  background: "rgba(127,127,127,.15)",
};
function SlackPanel({ pluginId }: { pluginId: string }) {
  const subPath = new URLSearchParams(window.location.search).get("setup");
  const client = useRpc(),
    navigate = useZccNavigate();
  const rpc = useMemo(
    () => ({
      async call(method: string, args?: unknown) {
        const value = await client.call(method, args);
        if (value && typeof value === "object" && "bridgeError" in value)
          throw new Error(String(value.bridgeError));
        return value;
      },
    }),
    [client],
  );
  const [settingsOpen, setSettingsOpen] = useState(subPath === "connect");
  const [editing, setEditing] = useState(false);
  const [manualSetup, setManualSetup] = useState(false);
  const [editingChannel, setEditingChannel] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const [history, setHistory] = useState(false);
  const [modelRetry, setModelRetry] = useState(0);
  const [channelOptions, setChannelOptions] = useState<
    { id: string; name: string }[]
  >([]);
  const savedModel = useRef("");
  const [data, setData] = useState<Snapshot>();
  const loaded = !!data;
  useEffect(() => {
    if (subPath !== "connect" || !loaded) return;
    setSettingsOpen(true);
  }, [subPath, loaded]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [embedOrigin, setEmbedOrigin] = useState("");
  const [embedPort, setEmbedPort] = useState("8792");
  const [previewUrl, setPreviewUrl] = useState("");
  const [appId, setAppId] = useState(""),
    [appToken, setAppToken] = useState(""),
    [botToken, setBotToken] = useState("");
  const [member, setMember] = useState(""),
    [challenge, setChallenge] = useState<{ code: string; expires: number }>();
  const [channel, setChannel] = useState(""),
    [projectId, setProject] = useState(""),
    [hostId, setHost] = useState(""),
    [providerId, setProvider] = useState(""),
    [model, setModel] = useState(""),
    [models, setModels] = useState<{ id: string; name: string }[]>([]),
    [modelError, setModelError] = useState(""),
    [modelsLoading, setModelsLoading] = useState(false),
    [summaries, setSummaries] = useState(false),
    [sharingChosen, setSharingChosen] = useState(false);
  const [share, setShare] = useState<Binding>(),
    [message, setMessage] = useState("");
  const refetch = useCallback(() => {
    void rpc
      .call("snapshot")
      .then((v) => setData(v as Snapshot))
      .catch(() =>
        setError("Could not load Zana for Slack. Check the plugin status."),
      );
  }, [rpc]);
  useEffect(() => {
    refetch();
    const t = setInterval(refetch, 10000);
    return () => clearInterval(t);
  }, [refetch]);
  useEffect(() => {
    void getPluginSettings(pluginId)
      .then((v) => setAppId(String(v.values.appId || "")))
      .catch(() => {});
  }, [pluginId, data?.directSetup]);
  useRealtime("bridge.changed", refetch);
  useEffect(() => {
    setEmbedOrigin(data?.embed?.origin || "");
    setEmbedPort(String(data?.embed?.port || 8792));
  }, [data?.embed?.origin, data?.embed?.port]);
  async function act(work: () => Promise<unknown>, success = "") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      setNotice(success);
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }
  function saveCredentials(e: FormEvent) {
    e.preventDefault();
    void act(async () => {
      await setPluginSettings(pluginId, {
        appId,
        ...(appToken ? { appToken } : {}),
        ...(botToken ? { botToken } : {}),
      });
      setAppToken("");
      setBotToken("");
    }, "Credentials saved. Connect when ready.");
  }
  useEffect(() => {
    let current = true;
    setModel("");
    setModels([]);
    setModelError("");
    setModelsLoading(!!hostId && !!providerId);
    if (hostId && providerId)
      void rpc
        .call("models", { hostId, providerId })
        .then((value) => {
          if (current) {
            const options = value as { id: string; name: string }[];
            setModels(options);
            setModel(
              options.some((m) => m.id === savedModel.current)
                ? savedModel.current
                : "",
            );
          }
        })
        .catch((e) => {
          if (current)
            setModelError(
              e instanceof Error ? e.message : "Could not load models.",
            );
        })
        .finally(() => {
          if (current) setModelsLoading(false);
        });
    return () => {
      current = false;
    };
  }, [rpc, hostId, providerId, modelRetry]);
  function editRoute(r?: Route) {
    setEditingChannel(r?.channel || "");
    savedModel.current = r?.model || "";
    setChannel(r?.channel || "");
    setProject(r?.projectId || "");
    setHost(r?.hostId || "");
    setProvider(r?.providerId || "");
    setModel(r?.model || "");
    setSummaries(r?.summaries || false);
    setSharingChosen(!!r);
    setEditing(true);
    setModelRetry((n) => n + 1);
  }
  const paired = !!data?.config.owner;
  const configured = paired && !!data?.config.routes.length;
  const showSettings = !configured || settingsOpen;
  const visibleBindings =
    data?.bindings.filter(
      (b) => history || !["deleted", "archived"].includes(b.state),
    ) || [];
  const latestDelivery = data?.deliveries.find((d) => d.state === "sent");
  const relative = (date: number) => {
    const minutes = Math.max(0, Math.floor((Date.now() - date) / 60000));
    return minutes < 1
      ? "Just now"
      : minutes < 60
        ? `${minutes} min ago`
        : minutes < 1440
          ? `${Math.floor(minutes / 60)} hr ago`
          : `${Math.floor(minutes / 1440)} days ago`;
  };
  return (
    <div
      className="slack-bridge"
      style={{
        width: "100%",
        minWidth: 0,
        boxSizing: "border-box",
        color: "var(--text-primary, inherit)",
      }}
    >
      <style>{settingsCss}</style>
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
        <header
          style={{ ...row, justifyContent: "space-between", marginBottom: 22 }}
        >
          <div>
            <h4 style={{ fontSize: 20, margin: "0 0 6px" }}>Zana for Slack</h4>
            <p style={{ margin: 0, opacity: 0.75 }}>
              Your agents, one Slack conversation away.
            </p>
          </div>
          <div style={row}>
            <span role="status" style={tag}>
              {data?.connection || "Loading…"}
            </span>
            {configured && (
              <button style={button} onClick={() => setSettingsOpen((v) => !v)}>
                {settingsOpen ? "Close settings" : "Connection settings"}
              </button>
            )}
          </div>
        </header>
        {error && (
          <p role="alert" style={{ ...box, borderColor: "#d56a6a" }}>
            {error}
          </p>
        )}
        {notice && (
          <p role="status" style={box}>
            {notice}
          </p>
        )}
        {configured && (
          <section style={box} aria-label="Connection overview">
            <h2 style={{ fontSize: 17, marginTop: 0 }}>
              {data.config.workspaceName || "Slack workspace"} ·{" "}
              {data.config.ownerName || data.config.owner}
            </h2>
            <p>
              Only this linked owner can start and control agents. Each channel
              below chooses the Project, machine, and what is shared.
            </p>
            <div style={row}>
              {data.home?.url && (
                <a style={button} href={data.home.url}>
                  Open Zana Home in Slack
                </a>
              )}
              <button
                style={button}
                disabled={busy || !data.config.enabled}
                onClick={() =>
                  void act(
                    () => rpc.call("refreshHome"),
                    "Home refresh requested. Open Zana → Home in Slack to see the dashboard.",
                  )
                }
              >
                Refresh Slack Home
              </button>
            </div>
            <p style={{ fontSize: 13 }}>
              {data.home?.error ||
                (data.home?.lastPublished
                  ? `Slack Home updated ${relative(data.home.lastPublished)}.`
                  : data.connect?.linked
                    ? "Open Zana in Slack and choose Home to see your dashboard."
                    : "Enable the Home tab and app_home_opened event in your Slack app settings to use the dashboard.")}
            </p>
            {!!data.homeLaunches?.length && (
              <details>
                <summary>Launch requests from Slack</summary>
                {data.homeLaunches.map((l) => (
                  <p key={l.id}>
                    <strong>{l.title}</strong> · {l.state}
                    <br />
                    {l.note}
                    {["needs-review", "rejected"].includes(l.state) && (
                      <>
                        <br />
                        <button
                          style={button}
                          disabled={busy}
                          onClick={() =>
                            void act(
                              () =>
                                rpc.call("dismissHomeRequest", { id: l.id }),
                              "Marked reviewed. No message or agent was retried.",
                            )
                          }
                        >
                          I checked Slack — dismiss
                        </button>
                      </>
                    )}
                  </p>
                ))}
              </details>
            )}
            <p>
              Last confirmed delivery:{" "}
              {latestDelivery ? relative(latestDelivery.created) : "None yet"}.{" "}
              {data.deliveries.some((d) =>
                ["uncertain", "failed"].includes(d.state),
              )
                ? "Some deliveries need attention — see Diagnostics."
                : ""}
            </p>
            <p style={{ fontSize: 13 }}>
              Keep Zana and its receiver machine awake. When offline, this
              computer cannot accept agent requests. Execution permissions are
              reviewed in Zana on your computer.
            </p>
          </section>
        )}
        {data && (data.connect?.linked || data.directSetup) && (
          <section
            style={box}
            aria-label={
              data.connect?.linked ? "Custom task panel" : "Task website"
            }
          >
            <h2 style={{ fontSize: 17, marginTop: 0 }}>Slack UI surfaces</h2>
            {data.conversationalChatReady === false && (
              <p>
                Update Zana to use conversational Project selection and the
                report inbox. This core keeps the existing Project selection
                flow.
              </p>
            )}
            {(
              [
                [
                  "agentChatEnabled",
                  "Private agent chat",
                  "Message Zana naturally. It uses connected Project defaults and asks when the target is unclear. Existing tasks keep their Project and native progress and stop controls.",
                ],
                [
                  "inboxEnabled",
                  "Read report inbox",
                  "Let your linked private Slack conversation list, read, and summarize reports across your registered Projects. Browsing preserves read and archive state. Reports are not posted into shared channels.",
                ],
                [
                  "questionsEnabled",
                  "Question forms in Slack",
                  "Let agents ask short preference or clarification questions. Start a new Slack conversation after enabling this tool. Your answers continue that conversation. Execution permissions are reviewed in Zana.",
                ],
                [
                  "canvasEnabled",
                  "Publish shared answers to Canvas",
                  "Add a Publish to Canvas button to results. A confirmation shows the audience before creating a persistent snapshot. Requires Canvas scopes and a supported Slack plan.",
                ],
              ] as const
            ).map(([surface, label, description]) => (
              <div key={surface}>
                <label style={{ ...row, marginBottom: 8 }}>
                  <input
                    type="checkbox"
                    checked={data.config[surface] === true}
                    disabled={busy}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      void act(
                        () => rpc.call("setSurface", { surface, enabled }),
                        `${label} ${enabled ? "enabled" : "disabled"}.`,
                      );
                    }}
                  />
                  {label}
                </label>
                <p style={{ fontSize: 13 }}>{description}</p>
              </div>
            ))}
            <p>
              Open a focused task page inside a Slack card, with live status and
              the answer and rich result already shared to Slack.
            </p>
            <label style={{ ...row, marginBottom: 12 }}>
              <input
                type="checkbox"
                checked={data.config.richResultsEnabled === true}
                disabled={busy}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  void act(
                    () => rpc.call("setRichResults", { enabled }),
                    enabled
                      ? "Rich results enabled for destinations that allow answer sharing."
                      : "Rich results disabled. Existing panel access has ended.",
                  );
                }}
              />
              Share rich results
            </label>
            <p style={{ fontSize: 13 }}>
              Allow agents to share formatted reports, tables, charts, task
              boards and requested code excerpts or diffs. Results follow each
              channel's answer-sharing rules. Start a new Slack conversation
              after enabling rich results so its agent receives the report
              contract. Full files and transcripts stay in Zana. Previously
              posted Slack messages remain visible.
            </p>
            {!!data.surfaceLog?.length && (
              <div aria-label="Slack surface activity">
                {data.surfaceLog.slice(0, 8).map((item) => (
                  <p key={item.id} style={{ fontSize: 13 }}>
                    {item.title} · {item.state}
                    {item.note ? ` · ${item.note}` : ""}
                    {item.url && (
                      <>
                        {" "}
                        ·{" "}
                        <a href={item.url} target="_blank" rel="noreferrer">
                          Open Canvas
                        </a>
                      </>
                    )}
                  </p>
                ))}
              </div>
            )}
            <p style={{ fontSize: 13 }}>
              {data.embed?.error ||
                (data.connect?.linked
                  ? data.embed?.viaConnect
                    ? "Enabled through your Zana connection. Open a task card in Slack to view its panel."
                    : "Use your existing Zana connection. No extra domain or local port is needed."
                  : data.embed?.origin
                    ? `Local endpoint ${data.embed.listening ? "running" : "not running"} · ${data.embed.origin}. HTTPS reachability and Slack display still need verification.`
                    : "Preview the design now. An HTTPS address is needed to enable it inside Slack.")}
            </p>
            {data.connect?.linked && (
              <label style={{ ...row, marginBottom: 16 }}>
                <input
                  type="checkbox"
                  checked={!!data.embed?.viaConnect}
                  disabled={busy}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    void act(
                      () => rpc.call("configureHostedEmbed", { enabled }),
                      enabled
                        ? "Custom task panel enabled. Open a task card in Slack."
                        : "Task panel disabled. Existing access has ended.",
                    );
                  }}
                />
                Enable custom web panels
              </label>
            )}
            {!data.connect?.linked && (
              <div style={row}>
                <button
                  style={button}
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const result = (await rpc.call("previewEmbed")) as {
                        url: string;
                      };
                      setPreviewUrl(result.url);
                    }, "Sample task website ready. Open the preview below.")
                  }
                >
                  Prepare local preview
                </button>
                {previewUrl && (
                  <a
                    style={button}
                    href={previewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open sample task website ↗
                  </a>
                )}
              </div>
            )}
            {!data.connect?.linked && (
              <details style={{ marginTop: 18 }}>
                <summary>Set up the Slack website</summary>
                <ol style={{ paddingLeft: 22, fontSize: 13 }}>
                  <li>
                    Point a dedicated HTTPS address to this computer’s task
                    endpoint. The default is 127.0.0.1:8792.
                  </li>
                  <li>
                    In Slack app settings → Work Object Previews, enable the
                    File entity and allow that exact hostname. Subscribe to
                    entity_details_requested under Events.
                  </li>
                  <li>
                    Save the address below. The next task status update includes
                    its website card.
                  </li>
                </ol>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(
                      () =>
                        rpc.call("configureEmbed", {
                          origin: embedOrigin,
                          port: Number(embedPort),
                        }),
                      "Website setup saved. Verify HTTPS and Slack settings, then open a new task card.",
                    );
                  }}
                >
                  <div style={row}>
                    <label style={field}>
                      Public HTTPS address
                      <input
                        style={input}
                        type="url"
                        placeholder="https://tasks.example.com"
                        value={embedOrigin}
                        required
                        onChange={(e) => setEmbedOrigin(e.target.value)}
                      />
                    </label>
                    <label style={field}>
                      Local task port
                      <input
                        style={input}
                        type="number"
                        min="1024"
                        max="65535"
                        value={embedPort}
                        required
                        onChange={(e) => setEmbedPort(e.target.value)}
                      />
                    </label>
                  </div>
                  <div style={{ ...row, marginTop: 12 }}>
                    <button style={button} disabled={busy} type="submit">
                      Save website setup
                    </button>
                    {data.embed?.origin && (
                      <button
                        style={button}
                        disabled={busy}
                        type="button"
                        onClick={() =>
                          void act(async () => {
                            await rpc.call("configureEmbed", {
                              origin: "",
                              port: Number(embedPort),
                            });
                            setPreviewUrl("");
                          }, "Task website disabled. Existing access links have ended.")
                        }
                      >
                        Disable task website
                      </button>
                    )}
                  </div>
                </form>
                <p style={{ fontSize: 12 }}>
                  The preview is read-only. Access links last five minutes. Keep
                  the receiver awake; use Zana Home for agent controls.
                </p>
              </details>
            )}
            {!!data.embed?.lastPresented && (
              <p style={{ fontSize: 12 }}>
                Slack accepted a preview {relative(data.embed.lastPresented)}.
                This confirms the API response, not that the iframe loaded.
              </p>
            )}
          </section>
        )}
        {showSettings && (
          <>
            <ConnectSetup
              connection={data?.connect}
              disabled={busy}
              focusCode={subPath === "connect"}
              act={act}
              call={rpc.call}
            />
            {!data?.connect?.linked && !data?.directSetup && (
              <details style={box}>
                <summary>Advanced: use your own Slack app</summary>
                <p>
                  For a separately managed Slack app with Socket Mode. The
                  shared Zana app does not need app IDs or Slack tokens on this
                  computer.
                </p>
                <button
                  style={button}
                  disabled={busy}
                  onClick={() => void act(() => rpc.call("enableDirectSetup"))}
                >
                  Set up my own Slack app
                </button>
              </details>
            )}
            {(data?.connect?.linked || data?.directSetup) && (
              <section style={box}>
                <h2 style={{ fontSize: 17, marginTop: 0 }}>
                  {data?.connect?.linked
                    ? "Connection controls"
                    : "Direct connection · Your own Slack app"}
                </h2>
                {!data?.connect?.linked && (
                  <>
                    <p>
                      Slack events arrive directly over an outbound connection.
                      Keep Zana running and your machine awake. Only one Slack
                      Bridge receiver should use this Slack app.
                    </p>
                    <details>
                      <summary style={{ cursor: "pointer" }}>
                        Slack setup instructions
                      </summary>
                      <ol>
                        <li>
                          Create an app at{" "}
                          <a
                            href="https://api.slack.com/apps"
                            target="_blank"
                            rel="noreferrer"
                          >
                            Slack apps
                          </a>{" "}
                          using the included slack-app-manifest.json.
                        </li>
                        <li>
                          Enable Socket Mode and Interactivity. Generate an
                          app-level token with <code>connections:write</code>.
                        </li>
                        <li>
                          Install the app to your workspace and copy its bot
                          token and app ID here.
                        </li>
                        <li>
                          Invite the bot to an internal, unshared channel.
                          Subscribe to <code>app_mention</code> and{" "}
                          <code>app_home_opened</code>. Enable the Home tab
                          under App Home.
                        </li>
                      </ol>
                      <p>
                        Bot scopes: app_mentions:read, chat:write,
                        channels:read, groups:read, users:read. Add groups:write
                        only for automatic private Project channels. No channel
                        history is requested.
                      </p>
                    </details>
                  </>
                )}
                <form onSubmit={saveCredentials}>
                  {!data?.connect?.linked && (
                    <>
                      <div style={{ ...row, margin: "16px 0" }}>
                        <label style={field}>
                          Slack app ID
                          <input
                            style={input}
                            aria-label="Slack app ID"
                            value={appId}
                            onChange={(e) => setAppId(e.target.value)}
                            placeholder="A…"
                            required
                            autoComplete="off"
                          />
                        </label>
                        <label style={field}>
                          App-level token
                          <input
                            style={input}
                            aria-label="App-level token"
                            type="password"
                            value={appToken}
                            onChange={(e) => setAppToken(e.target.value)}
                            placeholder="xapp-… (saved value kept)"
                            autoComplete="new-password"
                          />
                        </label>
                        <label style={field}>
                          Bot token
                          <input
                            style={input}
                            aria-label="Bot token"
                            type="password"
                            value={botToken}
                            onChange={(e) => setBotToken(e.target.value)}
                            placeholder="xoxb-… (saved value kept)"
                            autoComplete="new-password"
                          />
                        </label>
                      </div>
                    </>
                  )}
                  <div style={row}>
                    {!data?.connect?.linked && (
                      <button style={button} disabled={busy}>
                        Save credentials
                      </button>
                    )}
                    <button
                      style={button}
                      type="button"
                      disabled={busy || data?.connection === "Connected"}
                      onClick={() => void act(() => rpc.call("connect"))}
                    >
                      Connect
                    </button>
                    <button
                      style={button}
                      type="button"
                      disabled={busy || !data?.config.enabled}
                      onClick={() =>
                        void act(
                          () => rpc.call("disconnect"),
                          "Disconnected. Existing agents remain in Zana.",
                        )
                      }
                    >
                      Disconnect
                    </button>
                  </div>
                </form>
                {!data?.connect?.linked && (
                  <p style={{ fontSize: 12, opacity: 0.7 }}>
                    Tokens are stored as secret plugin settings. Saving
                    credentials disconnects the bridge until you reconnect.
                  </p>
                )}
              </section>
            )}
            {!data?.connect?.linked && data?.directSetup && (
              <section style={box}>
                <h2 style={{ fontSize: 17, marginTop: 0 }}>
                  Link your Slack identity
                </h2>
                {paired ? (
                  <>
                    <p>
                      Linked owner:{" "}
                      <strong>
                        {data.config.ownerName || data.config.owner}
                      </strong>{" "}
                      · Workspace{" "}
                      {data.config.workspaceName || data.config.identity?.team}
                    </p>
                    <button
                      style={button}
                      disabled={busy || data?.connect?.linked}
                      onClick={() => setConfirmReset(true)}
                    >
                      Unlink owner and clear mappings
                    </button>
                    {confirmReset && (
                      <div role="alert" style={{ marginTop: 14 }}>
                        <p>
                          This disconnects Slack, clears Project imports,
                          channel mappings and plugin tool permissions, and
                          cancels queued requests and messages. Running agents
                          remain in Zana.
                        </p>
                        <button
                          style={button}
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              await rpc.call("resetOwner");
                              setConfirmReset(false);
                            }, "Owner and channel mappings cleared. Reconnect to pair again.")
                          }
                        >
                          Confirm unlink
                        </button>{" "}
                        <button
                          style={button}
                          onClick={() => setConfirmReset(false)}
                        >
                          Keep connection
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <p>
                      Copy your member ID from your Slack profile. Then verify
                      it by mentioning the bot with a one-time code.
                    </p>
                    <form
                      style={row}
                      onSubmit={(e) => {
                        e.preventDefault();
                        void act(async () => {
                          setChallenge(
                            (await rpc.call("pair", { user: member })) as {
                              code: string;
                              expires: number;
                            },
                          );
                        });
                      }}
                    >
                      <label style={field}>
                        Your Slack member ID
                        <input
                          style={input}
                          value={member}
                          onChange={(e) => setMember(e.target.value)}
                          placeholder="U…"
                          required
                        />
                      </label>
                      <button style={button} disabled={busy}>
                        Generate pairing code
                      </button>
                    </form>
                    {challenge && (
                      <p>
                        In your internal channel, send{" "}
                        <code>@Zana link {challenge.code}</code>. Expires at{" "}
                        {new Date(challenge.expires).toLocaleTimeString()}.
                      </p>
                    )}
                  </>
                )}
              </section>
            )}
          </>
        )}
        <section style={box} id="connect-project">
          <div style={{ ...row, justifyContent: "space-between" }}>
            <h2 style={{ fontSize: 17, marginTop: 0 }}>Connected Projects</h2>
            {configured && !editing && (
              <button style={button} onClick={() => editRoute()}>
                Connect another Project
              </button>
            )}
          </div>
          <p>
            Choose the Projects you want in Slack. Each imported Project gets a
            private channel; agent conversations stay in threads within it.
          </p>
          {paired && data && (
            <ProjectImports data={data} rpc={rpc} busy={busy} act={act} />
          )}
          {paired && data && configured && (
            <label style={{ display: "block", marginTop: 16 }}>
              Default Project for mentions
              <select
                aria-label="Default Project for mentions"
                style={input}
                value={data.config.mentionDefaultProjectId || ""}
                disabled={busy}
                onChange={(event) =>
                  void act(
                    () =>
                      rpc.call("setMentionDefault", {
                        projectId: event.target.value,
                      }),
                    "Mention default saved.",
                  )
                }
              >
                <option value="">
                  Built-in Default Project, when connected
                </option>
                {data.projects
                  .filter((p) =>
                    data.config.routes.some(
                      (r) => r.projectId === p.id && r.model,
                    ),
                  )
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
              <span style={{ display: "block", fontSize: 13, marginTop: 6 }}>
                In a channel without a mapping, @Zana uses this Project’s saved
                harness and model. Use /zana to choose another profile.
              </span>
            </label>
          )}
          {paired && !configured && !manualSetup && (
            <button style={button} onClick={() => setManualSetup(true)}>
              Connect an existing Slack channel
            </button>
          )}
          {(editing || (!configured && manualSetup)) && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  await rpc.call("addRoute", {
                    channel,
                    projectId,
                    hostId,
                    providerId,
                    model,
                    summaries,
                  });
                  setEditing(false);
                }, "Channel saved. Mention @Zana with a task to try it.");
              }}
            >
              <div style={row}>
                <label style={field}>
                  Slack channel ID
                  <input
                    style={input}
                    value={channel}
                    onChange={(e) => setChannel(e.target.value)}
                    placeholder="Choose a channel or paste its ID"
                    list="slack-channels"
                    disabled={!!editingChannel}
                    required
                  />
                </label>
                <datalist id="slack-channels">
                  {channelOptions.map((c) => (
                    <option key={c.id} value={c.id}>
                      #{c.name}
                    </option>
                  ))}
                </datalist>
                <button
                  type="button"
                  style={button}
                  disabled={busy || data?.connection !== "Connected"}
                  onClick={() =>
                    void act(async () =>
                      setChannelOptions(
                        (await rpc.call("channels")) as {
                          id: string;
                          name: string;
                        }[],
                      ),
                    )
                  }
                >
                  Find joined channels
                </button>
                <label style={field}>
                  Project
                  <select
                    style={input}
                    value={projectId}
                    onChange={(e) => setProject(e.target.value)}
                    required
                  >
                    <option value="">Choose Project</option>
                    {data?.projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={field}>
                  Machine
                  <select
                    style={input}
                    value={hostId}
                    onChange={(e) => {
                      savedModel.current = "";
                      setHost(e.target.value);
                    }}
                    required
                  >
                    <option value="">Choose machine</option>
                    {data?.hosts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={field}>
                  Agent provider
                  <select
                    style={input}
                    value={providerId}
                    onChange={(e) => {
                      savedModel.current = "";
                      setProvider(e.target.value);
                    }}
                    required
                  >
                    <option value="">Choose provider</option>
                    {data?.providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={field}>
                  Model
                  <select
                    style={input}
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    required
                    disabled={modelsLoading || !models.length}
                  >
                    <option value="">
                      {modelsLoading ? "Loading models…" : "Choose model"}
                    </option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {modelError && <p role="alert">{modelError}</p>}
              {hostId && providerId && !modelsLoading && (
                <button
                  type="button"
                  style={button}
                  onClick={() => {
                    savedModel.current = model;
                    setModelRetry((n) => n + 1);
                  }}
                >
                  Reload models
                </button>
              )}
              {hostId &&
                providerId &&
                !modelsLoading &&
                !modelError &&
                !models.length && (
                  <p>
                    No models available. Check the provider on the selected
                    machine.
                  </p>
                )}
              <fieldset
                style={{
                  border: "1px solid #8884",
                  borderRadius: 8,
                  margin: "16px 0",
                  padding: 14,
                }}
              >
                <legend>What should Slack receive?</legend>
                <label style={{ display: "block", marginBottom: 10 }}>
                  <input
                    type="radio"
                    name="sharing"
                    checked={sharingChosen && summaries}
                    onChange={() => {
                      setSummaries(true);
                      setSharingChosen(true);
                    }}
                  />{" "}
                  Concise answers in Slack (recommended)
                </label>
                <label>
                  <input
                    type="radio"
                    name="sharing"
                    checked={sharingChosen && !summaries}
                    onChange={() => {
                      setSummaries(false);
                      setSharingChosen(true);
                    }}
                  />{" "}
                  Status only — read answers in Zana
                </label>
                <p style={{ fontSize: 12 }}>
                  Everyone in the channel can read shared answers. Raw logs and
                  file contents are never copied automatically. Execution
                  permissions are reviewed in Zana.
                </p>
              </fieldset>
              <button
                style={button}
                disabled={
                  busy || !paired || !model || modelsLoading || !sharingChosen
                }
              >
                Save channel mapping
              </button>{" "}
              {configured && (
                <button
                  type="button"
                  style={button}
                  onClick={() => setEditing(false)}
                >
                  Cancel editing
                </button>
              )}
            </form>
          )}
          <details style={{ marginTop: 20 }}>
            <summary>
              Manage connected channels ({data?.config.routes.length || 0})
            </summary>
            {data?.config.routes.map((r) => (
              <div
                key={r.channel}
                style={{
                  ...row,
                  justifyContent: "space-between",
                  marginTop: 18,
                }}
              >
                <div>
                  <strong>#{r.name}</strong>
                  <div style={{ fontSize: 12 }}>
                    {data.projects.find((p) => p.id === r.projectId)?.name ||
                      r.projectId}{" "}
                    ·{" "}
                    {data.hosts.find((h) => h.id === r.hostId)?.name ||
                      r.hostId}{" "}
                    · {r.providerId} ·{" "}
                    {r.model || "Choose a model before the next launch"} ·{" "}
                    {r.summaries
                      ? "Concise answers in Slack"
                      : "Status only — answers in Zana"}
                    {" · Machine: "}
                    {data.hosts.find((h) => h.id === r.hostId)?.status ||
                      "status unavailable"}
                  </div>
                </div>
                <div style={row}>
                  <a
                    href={slackLink(
                      data.config.identity?.team || "",
                      r.channel,
                    )}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open channel
                  </a>
                  <button
                    style={button}
                    disabled={busy}
                    onClick={() => editRoute(r)}
                  >
                    Edit #{r.name}
                  </button>
                  <button
                    style={button}
                    disabled={busy || !data.config.enabled}
                    onClick={() =>
                      void act(
                        () => rpc.call("testChannel", { channel: r.channel }),
                        "Test message queued. Check Slack, then mention the bot with a task to verify the full journey.",
                      )
                    }
                  >
                    Send connection test
                  </button>
                  <button
                    style={button}
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        rpc.call("removeRoute", { channel: r.channel }),
                      )
                    }
                  >
                    Remove mapping
                  </button>
                </div>
              </div>
            ))}
          </details>
        </section>
        {data?.capabilities && (
          <CapabilitySettings
            data={data.capabilities}
            busy={busy}
            setAccess={(id, enabled) =>
              void act(
                () => rpc.call("setSlackAccess", { id, enabled }),
                enabled
                  ? "Slack functionality enabled."
                  : "Slack functionality disabled.",
              )
            }
            setEnabled={(id, enabled) =>
              void act(
                () => rpc.call("enableCapability", { id, enabled }),
                enabled
                  ? "Plugin capability enabled for Slack."
                  : "Plugin capability disabled.",
              )
            }
          />
        )}
        <section style={box}>
          <h2 style={{ fontSize: 17, marginTop: 0 }}>Conversations</h2>
          <p style={{ opacity: 0.75 }}>
            Start: <code>@Zana review the login tests</code>. In that Slack
            thread, mention the bot with a follow-up, <code>status</code>,{" "}
            <code>stop</code>, <code>mute</code>, or <code>unmute</code>. Muting
            silences updates; the agent keeps working.
          </p>
          {!data?.bindings.length && <p>No Slack conversations yet.</p>}
          {!!data?.bindings.some((b) =>
            ["deleted", "archived"].includes(b.state),
          ) && (
            <label>
              <input
                type="checkbox"
                checked={history}
                onChange={(e) => setHistory(e.target.checked)}
              />{" "}
              Show archived and deleted conversations
            </label>
          )}
          {!!data?.bindings.length && !visibleBindings.length && (
            <p>
              No active Slack conversations. Mention the bot with a task to
              start one.
            </p>
          )}
          {visibleBindings.map((b) => (
            <article
              key={b.key}
              style={{ borderTop: "1px solid #8884", padding: "14px 0" }}
            >
              <div style={{ ...row, justifyContent: "space-between" }}>
                <div>
                  <strong>
                    {b.title ||
                      data?.requests
                        .find((r) => r.key === b.key && r.command)
                        ?.command?.slice(0, 120) ||
                      "Slack conversation"}
                  </strong>{" "}
                  <span style={tag}>
                    {b.needsAttention
                      ? "Needs attention in Zana"
                      : b.state === "idle"
                        ? "Ready for follow-up"
                        : b.state}
                  </span>
                  {b.paused && <span style={tag}>Updates muted</span>}
                  <div style={{ fontSize: 12, marginTop: 8 }}>
                    {b.sourceChannel
                      ? "Private agent chat"
                      : "#" +
                        (data?.config.routes.find(
                          (r) => r.channel === b.channel,
                        )?.name || b.channel)}{" "}
                    ·{" "}
                    {data?.projects.find((p) => p.id === b.projectId)?.name ||
                      b.projectId}{" "}
                    · {relative(b.updated)}
                    {b.lastRequest && (
                      <p style={{ marginBottom: 0 }}>
                        {data?.deliveries.find(
                          (d) => d.id === `status:${b.lastRequest}`,
                        )?.text || "Waiting for status"}
                        {" · Slack delivery: "}
                        {data?.deliveries.find(
                          (d) => d.id === `status:${b.lastRequest}`,
                        )?.state || "not queued"}
                      </p>
                    )}
                    {["deleted", "archived"].includes(b.state) && (
                      <p>
                        Start a new top-level Slack mention for another agent.
                      </p>
                    )}
                  </div>
                </div>
                <div style={row}>
                  <a
                    href={b.slackUrl || slackLink(b.team, b.channel, b.root)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View in Slack
                  </a>
                  {!["deleted", "archived"].includes(b.state) && (
                    <>
                      <button
                        style={button}
                        onClick={() => navigate.toThread(b.threadId)}
                      >
                        Open in Zana
                      </button>
                      <button
                        style={button}
                        disabled={busy || !b.active || b.state === "stopping"}
                        onClick={() =>
                          void act(() => rpc.call("stop", { key: b.key }))
                        }
                      >
                        {b.state === "stopping" ? "Stopping…" : "Stop agent"}
                      </button>
                      <button
                        style={button}
                        disabled={busy}
                        onClick={() =>
                          void act(
                            () =>
                              rpc.call("mute", {
                                key: b.key,
                                muted: !b.paused,
                              }),
                            b.paused
                              ? "Updates unmuted."
                              : "Updates muted. The agent continues working.",
                          )
                        }
                      >
                        {b.paused ? "Unmute updates" : "Mute updates"}
                      </button>
                      <button
                        style={button}
                        disabled={busy || b.paused}
                        onClick={() => {
                          setShare(b);
                          setMessage("");
                        }}
                      >
                        Write Slack reply
                      </button>
                    </>
                  )}
                </div>
              </div>
            </article>
          ))}
        </section>
        {share && (
          <section style={box} aria-label="Review Slack reply">
            <h2 style={{ fontSize: 17, marginTop: 0 }}>
              Send to #
              {data?.config.routes.find((r) => r.channel === share.channel)
                ?.name || share.channel}
            </h2>
            <p>
              Destination: Slack thread {share.root}. Everyone in this channel
              can read your reply.
            </p>
            <textarea
              style={{ ...input, width: "100%", boxSizing: "border-box" }}
              rows={5}
              value={message}
              maxLength={2000}
              onChange={(e) => setMessage(e.target.value)}
              aria-label="Slack reply"
              aria-describedby="slack-reply-limit"
            />
            <p id="slack-reply-limit" style={{ fontSize: 12 }}>
              {message.length.toLocaleString()} / 2,000 characters. Share a
              concise answer or code example.
            </p>
            <div style={{ ...row, marginTop: 10 }}>
              <button
                style={button}
                disabled={busy || !message.trim()}
                onClick={() =>
                  void act(async () => {
                    await rpc.call("publish", {
                      threadId: share.threadId,
                      projectId: share.projectId,
                      text: message,
                    });
                    setShare(undefined);
                  }, "Reply queued. Check the delivery log for confirmation.")
                }
              >
                Send this reply to Slack
              </button>
              <button style={button} onClick={() => setShare(undefined)}>
                Cancel
              </button>
            </div>
          </section>
        )}
        <details style={box}>
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>
            Diagnostics · Requests and delivery
          </summary>
          <section style={{ marginTop: 20 }}>
            <h2 style={{ fontSize: 17, marginTop: 0 }}>Incoming requests</h2>
            {!data?.requests.length && <p>No requests received yet.</p>}
            {data?.requests.map((r) => (
              <article
                key={r.id}
                style={{ borderTop: "1px solid #8884", padding: "12px 0" }}
              >
                <div style={row}>
                  <span style={tag}>{r.state}</span>
                  <time style={{ fontSize: 12 }}>
                    {new Date(r.created).toLocaleString()}
                  </time>
                </div>
                <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  {r.text.slice(0, 500)}
                </p>
                <p style={{ fontSize: 12 }}>{r.note}</p>
                <a
                  href={slackLink(r.team, r.channel, r.root)}
                  target="_blank"
                  rel="noreferrer"
                >
                  View request in Slack
                </a>{" "}
                {data.bindings.some(
                  (b) =>
                    b.key === r.key &&
                    !["archived", "deleted"].includes(b.state),
                ) && (
                  <button
                    style={button}
                    onClick={() =>
                      navigate.toThread(
                        data.bindings.find((b) => b.key === r.key)!.threadId,
                      )
                    }
                  >
                    Inspect in Zana
                  </button>
                )}
                {r.state === "needs-review" && (
                  <button
                    style={button}
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () => rpc.call("resolve", { id: r.id }),
                        "Marked reviewed. This request will not be retried.",
                      )
                    }
                  >
                    I inspected Zana — dismiss this request
                  </button>
                )}
              </article>
            ))}
          </section>
          <section>
            <h2 style={{ fontSize: 17, marginTop: 0 }}>Outgoing delivery</h2>
            <p style={{ fontSize: 12, opacity: 0.75 }}>
              “Sent” means Slack confirmed receipt. “Uncertain” means you must
              check Slack before sending the message again.
            </p>
            {!data?.deliveries.length && <p>No outgoing messages yet.</p>}
            {data?.deliveries.map((d) => (
              <article
                key={d.id}
                style={{ borderTop: "1px solid #8884", padding: "12px 0" }}
              >
                <div style={row}>
                  <span style={tag}>{d.state}</span>
                  <span style={{ fontSize: 12 }}>
                    {d.channel}
                    {d.ts ? ` · ${d.ts}` : ""}
                  </span>
                </div>
                <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  {d.text}
                </p>
                <p style={{ fontSize: 12 }}>{d.note}</p>
                <a
                  href={slackLink(
                    data.config.identity?.team || "",
                    d.channel,
                    d.root || undefined,
                  )}
                  target="_blank"
                  rel="noreferrer"
                >
                  Check conversation in Slack
                </a>{" "}
                {d.state === "uncertain" && (
                  <button
                    style={button}
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () => rpc.call("resolveDelivery", { id: d.id }),
                        "Delivery marked reviewed. No retry was sent.",
                      )
                    }
                  >
                    I checked Slack — mark reviewed
                  </button>
                )}
              </article>
            ))}
          </section>
        </details>
      </div>
    </div>
  );
}
export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "connection",
    component: SlackPanel,
  });
  app.contentScripts.register({
    id: "setup-link",
    mount: ({
      pluginId,
      signal,
    }: {
      pluginId: string;
      signal: AbortSignal;
    }) => {
      // Let the host finish its initial route effects before restoring this link.
      const timer = setTimeout(() => {
        if (!signal.aborted) restoreSetupRoute(pluginId);
      }, 100);
      return () => clearTimeout(timer);
    },
  });
});
