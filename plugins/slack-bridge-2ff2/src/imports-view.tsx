import { useEffect, useId, useRef, useState } from "react";
import type { Config } from "./model.js";

type Option = { id: string; name: string };
/** Keyboard-native searchable selector, with no platform popup styling. */
export function Picker({
  label,
  value,
  options,
  onChange,
  disabled = false,
  placeholder = "Choose…",
}: {
  label: string;
  value: string;
  options: Option[];
  onChange(value: string): void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState("");
  const id = useId(),
    root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const matches = options.filter((option) =>
    `${option.name} ${option.id}`.toLowerCase().includes(query.toLowerCase()),
  );
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <div
      className="sb-field sb-picker"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setOpen(false);
          trigger.current?.focus();
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          const controls = [
            ...(root.current?.querySelectorAll<HTMLElement>(
              'input, [role="option"]',
            ) || []),
          ];
          if (open && controls.length) {
            event.preventDefault();
            const index = controls.indexOf(
              document.activeElement as HTMLElement,
            );
            controls[
              (index + (event.key === "ArrowDown" ? 1 : controls.length - 1)) %
                controls.length
            ]?.focus();
          }
        }
      }}
    >
      <span id={`${id}-label`}>{label}</span>
      <button
        ref={trigger}
        type="button"
        aria-labelledby={`${id}-label ${id}-value`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        disabled={disabled}
        className="sb-input sb-picker-trigger"
        onClick={() => {
          setOpen((v) => !v);
          setQuery("");
        }}
      >
        <span id={`${id}-value`}>
          {options.find((option) => option.id === value)?.name ||
            value ||
            placeholder}
        </span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className="sb-picker-menu">
          <input
            autoFocus
            className="sb-input"
            aria-label={`Search ${label.toLowerCase()}`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div id={`${id}-list`} role="listbox" aria-label={label}>
            {matches.map((option) => (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={value === option.id}
                onClick={() => {
                  onChange(option.id);
                  setOpen(false);
                  trigger.current?.focus();
                }}
              >
                {option.name}
                {value === option.id && <span aria-hidden="true"> ✓</span>}
              </button>
            ))}
            {!matches.length && <p className="sb-muted">No matches</p>}
          </div>
        </div>
      )}
    </div>
  );
}

type ImportData = {
  connection: string;
  config: Config;
  projects: Option[];
  hosts: Option[];
  providers: Option[];
  projectSync?: { state: string; error: string; remaining: number };
};
export function ProjectImports({
  data,
  rpc,
  busy,
  act,
}: {
  data: ImportData;
  rpc: { call(method: string, input?: unknown): Promise<unknown> };
  busy: boolean;
  act(work: () => Promise<unknown>, notice?: string): Promise<void>;
}) {
  const defaults = data.config.projectSync;
  const template = defaults || data.config.routes.find((route) => route.model);
  const [hostId, setHost] = useState(template?.hostId || ""),
    [providerId, setProvider] = useState(template?.providerId || ""),
    [model, setModel] = useState(template?.model || "");
  const [summaries, setSummaries] = useState(template?.summaries ?? false),
    [prefix, setPrefix] = useState(defaults?.channelPrefix || ""),
    [remote, setRemote] = useState(defaults?.allowSlackImport ?? true);
  const [models, setModels] = useState<Option[]>([]),
    [loading, setLoading] = useState(false),
    [modelError, setModelError] = useState(""),
    [retry, setRetry] = useState(0);
  const [query, setQuery] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [filter, setFilter] = useState<"all" | "available" | "imported">("all");
  const connected = (id: string) =>
    data.config.routes.some((route) => route.projectId === id && route.model);
  const imported = data.projects.filter((project) =>
    connected(project.id),
  ).length;
  const candidates = selected.filter(
    (id) =>
      data.projects.some((project) => project.id === id) && !connected(id),
  );
  useEffect(() => {
    let current = true;
    setLoading(!!hostId && !!providerId);
    setModels([]);
    setModelError("");
    if (hostId && providerId)
      void rpc
        .call("models", { hostId, providerId })
        .then((value) => {
          if (!current) return;
          const choices = value as Option[];
          setModels(choices);
          setModel((old) =>
            choices.some((choice) => choice.id === old) ? old : "",
          );
        })
        .catch(() => {
          if (current) {
            setModel("");
            setModelError(
              "Models could not load. Check the machine connection and retry.",
            );
          }
        })
        .finally(() => {
          if (current) setLoading(false);
        });
    return () => {
      current = false;
    };
  }, [hostId, providerId, retry, rpc]);
  const example = [
    prefix
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, ""),
    "zana",
    "project-name",
  ]
    .filter(Boolean)
    .join("-");
  const visible = data.projects.filter(
    (project) =>
      `${project.name} ${project.id}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (filter === "all" || connected(project.id) === (filter === "imported")),
  );
  return (
    <div className="sb-imports">
      <details
        className="sb-defaults"
        open={!defaults?.enabled ? true : undefined}
      >
        <summary>
          <span>
            <strong>Import defaults</strong>
            <span className="sb-muted">
              {defaults?.enabled
                ? `${defaults.providerId} · ${defaults.model}`
                : "Choose how imported Projects run"}
            </span>
          </span>
          <span className="sb-badge">
            {defaults?.enabled ? "Configured" : "Set up"}
          </span>
        </summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act(
              () =>
                rpc.call("configureProjectSync", {
                  enabled: true,
                  hostId,
                  providerId,
                  model,
                  summaries,
                  channelPrefix: prefix,
                  allowSlackImport: remote,
                }),
              "Import defaults saved. New Projects are imported only when requested.",
            );
          }}
        >
          <div className="sb-grid">
            <Picker
              label="Default machine"
              value={hostId}
              options={data.hosts}
              onChange={(value) => {
                setHost(value);
                setModel("");
              }}
              placeholder="Choose machine"
            />
            <Picker
              label="Default provider"
              value={providerId}
              options={data.providers}
              onChange={(value) => {
                setProvider(value);
                setModel("");
              }}
              placeholder="Choose provider"
            />
            <Picker
              label="Default model"
              value={model}
              options={models}
              onChange={setModel}
              disabled={loading || !models.length}
              placeholder={loading ? "Loading models…" : "Choose model"}
            />
            <label className="sb-field">
              Channel prefix <span className="sb-muted">Optional</span>
              <input
                className="sb-input"
                value={prefix}
                maxLength={24}
                placeholder="Example: team"
                onChange={(event) => setPrefix(event.target.value)}
              />
            </label>
          </div>
          {modelError && (
            <p role="alert">
              {modelError}{" "}
              <button
                type="button"
                className="sb-button"
                onClick={() => setRetry((value) => value + 1)}
              >
                Retry models
              </button>
            </p>
          )}
          <p className="sb-muted">
            Channel preview: <code>#{example}</code>. A suffix is added only if
            the name is taken. Changing the prefix renames imported managed
            channels and keeps their history.
          </p>
          <fieldset className="sb-sharing">
            <legend>Answers in Slack</legend>
            <label>
              <input
                type="radio"
                name="import-sharing"
                checked={summaries}
                onChange={() => setSummaries(true)}
              />
              <span>
                <strong>Concise answers</strong>
                <small>
                  Share the agent’s final answer in its Slack thread.
                </small>
              </span>
            </label>
            <label>
              <input
                type="radio"
                name="import-sharing"
                checked={!summaries}
                onChange={() => setSummaries(false)}
              />
              <span>
                <strong>Status only</strong>
                <small>Read answers and handle permissions in Zana.</small>
              </span>
            </label>
          </fieldset>
          <label className="sb-toggle">
            <span>
              <strong>Allow imports from Slack</strong>
              <small>
                Your linked Slack user can ask Slackbot to import a Project or
                use <code>/zana import</code>.
              </small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={remote}
              onChange={(event) => setRemote(event.target.checked)}
            />
          </label>
          <div className="sb-actions">
            <button
              className="sb-button sb-primary"
              disabled={
                busy ||
                loading ||
                !models.some((entry) => entry.id === model) ||
                !hostId ||
                !providerId
              }
            >
              Save import defaults
            </button>
            <span className="sb-muted">
              Machine, model and sharing defaults apply to future imports.
            </span>
          </div>
        </form>
      </details>
      <div className="sb-project-toolbar">
        <label className="sb-search">
          <span className="sb-sr-only">Search Projects</span>
          <input
            className="sb-input"
            type="search"
            placeholder="Search Projects…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="sb-segments" aria-label="Filter Projects">
          {(["all", "available", "imported"] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {value === "all"
                ? "All"
                : value === "available"
                  ? "Available"
                  : "Imported"}
            </button>
          ))}
        </div>
      </div>
      <div className="sb-project-list" aria-label="Projects to import">
        {visible.map((project) => {
          const route = data.config.routes.find(
              (route) => route.projectId === project.id && route.model,
            ),
            pending = defaults?.projectIds?.includes(project.id) && !route;
          return (
            <label className="sb-project-row" key={project.id}>
              <input
                type="checkbox"
                aria-label={`Import ${project.name}`}
                disabled={!!route || !!pending || busy}
                checked={!!route || !!pending || selected.includes(project.id)}
                onChange={(event) =>
                  setSelected((ids) =>
                    event.target.checked
                      ? [...ids, project.id]
                      : ids.filter((id) => id !== project.id),
                  )
                }
              />
              <span className="sb-project-icon" aria-hidden="true">
                #
              </span>
              <span className="sb-project-label">
                <strong>{project.name}</strong>
                <small>
                  {route
                    ? `#${route.name}`
                    : pending
                      ? "Import requested"
                      : "Create a private Project channel"}
                </small>
              </span>
              <span className="sb-badge">
                {route ? "Imported" : pending ? "Pending" : "Available"}
              </span>
            </label>
          );
        })}
        {!visible.length && (
          <p className="sb-empty">
            {query
              ? "No Projects match your search."
              : filter === "available"
                ? "All your Projects are imported. New Projects stay here until you choose them."
                : "No Projects to show."}
          </p>
        )}
      </div>
      <div className="sb-actions">
        <button
          className="sb-button sb-primary"
          disabled={
            busy ||
            !defaults?.enabled ||
            data.connection !== "Connected" ||
            !candidates.length
          }
          onClick={() =>
            void act(async () => {
              await rpc.call("importProjects", { projectIds: candidates });
              setSelected([]);
            }, "Selected Projects submitted for import. Their channels appear when ready.")
          }
        >
          {busy
            ? "Working…"
            : `Import selected${candidates.length ? ` (${candidates.length})` : ""}`}
        </button>
        <span className="sb-muted">
          {imported} of {data.projects.length} Projects imported · Only you and
          Zana are added.
        </span>
      </div>
      {!defaults?.enabled && (
        <p className="sb-muted">
          Save import defaults above to enable the import button.
        </p>
      )}
      {data.projectSync?.state === "error" && (
        <p role="alert" className="sb-error">
          {data.projectSync.error}{" "}
          <button
            className="sb-button"
            disabled={busy}
            onClick={() =>
              void act(
                () => rpc.call("syncProjects"),
                "Selected imports retried.",
              )
            }
          >
            Retry selected imports
          </button>
        </p>
      )}
      {data.projectSync?.state === "pending" && (
        <p role="status">
          {data.projectSync.remaining} selected imports remaining. Zana
          continues in the background.
        </p>
      )}
      <p className="sb-muted">
        New Projects are never imported automatically. In Slack, try{" "}
        <code>/zana import "Project name"</code> or ask Slackbot to import it.
      </p>
    </div>
  );
}

export type CapabilityView = {
  features?: {
    id: string;
    title: string;
    description: string;
    enabled: boolean;
    available: boolean;
    tools: string[];
  }[];
  builtins: { name: string; title: string; description: string }[];
  commands: { command: string; description: string }[];
  plugins: {
    id: string;
    title: string;
    description: string;
    pluginId: string;
    enabled: boolean;
  }[];
  extensible: boolean;
};
export function CapabilitySettings({
  data,
  busy,
  setEnabled,
  setAccess,
}: {
  data: CapabilityView;
  busy: boolean;
  setEnabled(id: string, enabled: boolean): void;
  setAccess?(id: string, enabled: boolean): void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"All" | "Enabled" | "Disabled">("All");
  const matches = (
    tool: { title: string; description: string; enabled: boolean },
    extra = "",
  ) =>
    `${tool.title} ${tool.description} ${extra}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()) &&
    (filter === "All" || tool.enabled === (filter === "Enabled"));
  const features = (data.features || []).filter((f) =>
    matches(f, f.tools.join(" ")),
  );
  const pluginAccess =
    data.features?.find((f) => f.id === "plugins")?.enabled !== false;
  const plugins = data.plugins.filter((p) =>
    matches({ ...p, enabled: pluginAccess && p.enabled }, p.pluginId),
  );
  return (
    <section className="sb-capabilities" aria-label="What Slack can do">
      <h2>What Slack can do</h2>
      <p className="sb-muted">
        Turn on the features you want to use in Slack. Changes save immediately
        and apply to Slackbot, commands and mentions.
      </p>
      <div className="sb-project-toolbar">
        <input
          className="sb-input sb-search"
          aria-label="Search Slack functionalities"
          placeholder="Search functionalities or tools…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="sb-segments" aria-label="Filter Slack functionalities">
          {(["All", "Enabled", "Disabled"] as const).map((value) => (
            <button
              key={value}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </div>
      {features.map((feature) => (
        <label className="sb-toggle" key={feature.id}>
          <span>
            <strong>{feature.title}</strong>
            <small>{feature.description}</small>
            {!feature.available && (
              <small>
                {feature.id === "imports"
                  ? "Save import defaults and enable Browse Projects first."
                  : "Enable Browse Projects first."}
              </small>
            )}
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label={`Allow ${feature.title}`}
            checked={feature.enabled}
            disabled={busy || !feature.available}
            onChange={(event) => setAccess?.(feature.id, event.target.checked)}
          />
        </label>
      ))}
      {!query && filter !== "Disabled" && (
        <div className="sb-essential">
          <strong>Always available</strong>
          <small>
            Connection setup, help, stop and mute controls. Turning off a
            functionality does not stop running agents or remove messages
            already posted in Slack.
          </small>
        </div>
      )}
      {!!plugins.length && <>
        <h3>Individual plugin tools</h3>
        <p className="sb-muted">Enable the tools you want from your installed plugins. No commands or technical setup required. New tools start turned off.</p>
      </>}
      {plugins.map((tool) => (
        <label className="sb-toggle" key={tool.id}>
          <span>
            <strong>{tool.title}</strong>
            <small>{tool.description}</small>
            <small>
              {tool.pluginId} · Read-only · Imported Projects
              {!pluginAccess ? " · Paused while plugin tools are off" : ""}
            </small>
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label={`Enable ${tool.title}`}
            checked={tool.enabled}
            disabled={busy || !pluginAccess}
            onChange={(event) => setEnabled(tool.id, event.target.checked)}
          />
        </label>
      ))}
      {!data.plugins.length && !query && filter === "All" && (
        <p className="sb-muted">
          {data.extensible
            ? "No extra Slack tools are available yet. Install a Zana plugin that supports Slack, then enable its tools here."
            : "Update Zana to enable plugin-contributed Slack tools."}
        </p>
      )}
      {!features.length && !plugins.length && (query || filter !== "All") && (
        <p className="sb-empty">No matching functionalities.</p>
      )}
      <details className="sb-tool-reference">
        <summary>
          Tools and channel shortcuts{" "}
          <span className="sb-badge">{data.builtins.length} tools</span>
        </summary>
        <div className="sb-capability-grid">
          {data.builtins.map((tool) => (
            <div key={tool.name}>
              <strong>{tool.title}</strong>
              <p>{tool.description}</p>
              <code>{tool.name}</code>
            </div>
          ))}
        </div>
        {data.commands.map((command) => (
          <p key={command.command}>
            <code>{command.command}</code> — {command.description}
          </p>
        ))}
      </details>
    </section>
  );
}

export const settingsCss = `
.slack-bridge { --sb-border: var(--border, #ffffff18); --sb-muted: var(--text-muted, #989ba7); font-size:13px; line-height:1.5; }
.slack-bridge h2 {font-size:16px;margin:0 0 8px;font-weight:650;letter-spacing:-.2px}.slack-bridge h3 {font-size:14px;margin:20px 0 8px}
.slack-bridge button,.slack-bridge input {font:inherit}.slack-bridge button:disabled {opacity:.45;cursor:not-allowed!important}.slack-bridge button:focus-visible,.slack-bridge input:focus-visible,.slack-bridge summary:focus-visible {outline:2px solid var(--accent-blue,#8595ff);outline-offset:3px}
.slack-bridge input[type=checkbox],.slack-bridge input[type=radio] {accent-color:var(--accent-blue,#8595ff);width:16px;height:16px;flex-shrink:0}.slack-bridge summary {cursor:pointer}.slack-bridge small {display:block;color:var(--sb-muted);font-size:12px}
.sb-muted {color:var(--sb-muted);font-size:12px}.sb-badge {background:var(--bg-elevated,#ffffff08);border:1px solid var(--sb-border);padding:3px 8px;border-radius:6px;font-size:11px;white-space:nowrap;color:var(--sb-muted)}
.sb-grid {display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:18px;margin:20px 0}.sb-field {display:flex;flex-direction:column;gap:7px;font-size:12px;font-weight:600;min-width:0}.sb-field>.sb-muted {display:inline;font-weight:400}
.sb-input {width:100%;min-width:0;box-sizing:border-box;background:var(--bg-input,#17181e);border:1px solid var(--sb-border);border-radius:8px;padding:10px 12px;color:inherit;font-size:13px;font-weight:400;line-height:20px}
.sb-button {background:var(--bg-elevated,#ffffff08);color:inherit;border:1px solid var(--sb-border);border-radius:8px;padding:9px 14px;cursor:pointer;font-weight:600}.sb-button:hover:not(:disabled) {background:var(--bg-hover,#ffffff10)}.sb-primary {background:var(--accent-blue,#7887ee);color:var(--text-on-accent,#fff);border-color:transparent}.sb-primary:hover:not(:disabled) {filter:brightness(1.08);background:var(--accent-blue,#7887ee)}
.sb-picker {position:relative}.sb-picker-trigger {display:flex;justify-content:space-between;gap:10px;text-align:left;cursor:pointer}.sb-picker-trigger>span:first-child {overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sb-picker-menu {position:absolute;top:100%;margin-top:5px;left:0;right:0;z-index:20;padding:8px;background:var(--bg-panel,#202128);border:1px solid var(--sb-border);border-radius:10px;box-shadow:0 12px 32px #0006}.sb-picker-menu [role=listbox] {max-height:220px;overflow:auto;margin-top:6px}.sb-picker-menu [role=option] {display:block;width:100%;text-align:left;background:transparent;border:0;color:inherit;padding:9px;border-radius:5px;cursor:pointer}.sb-picker-menu [role=option]:hover,.sb-picker-menu [aria-selected=true] {background:var(--bg-hover,#ffffff10)}
.sb-defaults {border:1px solid var(--sb-border);border-radius:10px;padding:15px 18px;margin:20px 0}.sb-defaults>summary {display:flex;justify-content:space-between;align-items:center;gap:12px}.sb-defaults>summary strong {margin-right:12px}.sb-defaults>summary::after {content:'⌄';color:var(--sb-muted)}
.sb-sharing {display:flex;gap:12px;padding:0;border:0;margin:20px 0}.sb-sharing legend {font-size:12px;font-weight:600;margin-bottom:8px}.sb-sharing label {display:flex;align-items:center;gap:10px;flex:1;border:1px solid var(--sb-border);padding:12px;border-radius:8px}.sb-toggle {display:flex;justify-content:space-between;align-items:center;gap:16px;border-top:1px solid var(--sb-border);padding:16px 0}.sb-toggle small {margin-top:4px}
.sb-toggle input[role=switch] {appearance:none;width:38px;height:22px;border-radius:12px;background:var(--border-strong,#777);position:relative;cursor:pointer;transition:background .15s}.sb-toggle input[role=switch]::before {content:"";position:absolute;left:3px;top:3px;width:16px;height:16px;border-radius:50%;background:white;transition:transform .15s}.sb-toggle input[role=switch]:checked {background:var(--accent-blue,#0969da)}.sb-toggle input[role=switch]:checked::before {transform:translateX(16px)}
.sb-actions {display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin-top:16px}.sb-project-toolbar {display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:20px 0 12px}.sb-search {flex:1;min-width:180px}.sb-segments {display:flex;gap:2px;border:1px solid var(--sb-border);border-radius:8px;padding:3px}.sb-segments button {background:transparent;border:0;border-radius:5px;color:var(--sb-muted);padding:6px 10px;cursor:pointer}.sb-segments [aria-pressed=true] {background:var(--bg-hover,#ffffff10);color:inherit}
.sb-project-list {max-height:340px;overflow:auto;border:1px solid var(--sb-border);border-radius:10px}.sb-project-row {display:flex;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid var(--sb-border);cursor:pointer}.sb-project-row:last-child {border-bottom:0}.sb-project-row:hover {background:var(--bg-hover,#ffffff06)}.sb-project-label {flex:1;min-width:0}.sb-project-label strong,.sb-project-label small {overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sb-project-icon {display:grid;place-items:center;border:1px solid var(--sb-border);border-radius:7px;width:32px;height:32px;color:var(--sb-muted);font-size:18px}
.sb-empty {padding:30px 16px;text-align:center;color:var(--sb-muted)}.sb-error {padding:12px;border:1px solid #c8636366;border-radius:8px}.sb-sr-only {position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
.sb-essential {padding:14px;background:var(--bg-elevated,#ffffff08);border:1px solid var(--sb-border);border-radius:8px;margin-top:12px}.sb-tool-reference {margin-top:20px}.sb-toggle input:disabled {opacity:.4;cursor:not-allowed}.sb-capabilities {padding:22px;border:1px solid var(--sb-border);border-radius:12px;margin-bottom:18px}.sb-capability-grid {display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin:16px 0}.sb-capability-grid>div {padding:14px;border:1px solid var(--sb-border);border-radius:8px}.sb-capability-grid p {font-size:12px;color:var(--sb-muted)}.sb-capability-grid code {font-size:11px}
@media(max-width:600px) {.sb-sharing {flex-direction:column}.sb-defaults>summary .sb-muted {display:none}.sb-project-icon {display:none}}
`;
