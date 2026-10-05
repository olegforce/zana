import { featureEnabled } from "./access.js";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { isIP } from "node:net";
import {
  internalChannel,
  slackLink,
  type Binding,
  type Config,
  type SlackConnection,
  type SlackAck,
} from "./model.js";
import { bindingRoute, sameRoute } from "./home-view.js";
import type { Store } from "./store.js";
import { renderTask, sampleTask, type TaskView } from "./embed-view.js";

export const EMBED_PORT = 8792;
export const EMBED_TTL = 5 * 60000;
const ENTITY_TYPE = "zana_task";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FRAME_ANCESTORS =
  "https://*.slack.com https://*.slack-gov.com https://*.slack-mcps.com";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
type Grant = { key: string; entity: string; policy: string; expires: number };
type Deps = {
  routeFor?(b: Binding): ReturnType<typeof bindingRoute>;
  authorize?(b: Binding): Promise<boolean>;
  hostedBase?(): string | undefined;
  store: Store;
  config(): Config;
  client(): SlackConnection | undefined;
  save(): void;
  changed(): void;
};

export function embedOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 250)
    throw new Error("Enter a public HTTPS origin.");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(
      "Enter a public HTTPS origin, such as https://tasks.example.com.",
    );
  }
  const host = url.hostname;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    isIP(host) ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|slack\.com|slack-gov\.com|slack-mcps\.com)$/.test(
      host,
    )
  )
    throw new Error(
      "Use a public HTTPS hostname with no port, path, credentials, query, or fragment.",
    );
  return url.origin;
}

/** A separate, read-only loopback listener. Never forwards requests to the product server. */
export class TaskEmbeds {
  private server?: Server;
  private port?: number;
  private changing = false;
  private disposed = false;
  private generation = 0;
  private grants = new Map<string, Grant>();
  private triggers = new Map<string, number>();
  private inflight = 0;
  private requests = 0;
  private window = 0;
  error = "";
  metadataError = "";
  lastPresented?: number;
  constructor(private deps: Deps) {}
  snapshot() {
    return {
      origin: this.deps.config().embed?.origin || "",
      viaConnect: !!this.deps.config().embed?.viaConnect,
      port: this.port || this.deps.config().embed?.port || EMBED_PORT,
      listening: this.deps.config().embed?.viaConnect
        ? !!this.base()
        : !!this.server?.listening,
      error: this.error || this.metadataError,
      lastPresented: this.lastPresented,
    };
  }
  revoke() {
    this.generation++;
    this.grants.clear();
  }
  reset() {
    this.revoke();
    this.triggers.clear();
    this.metadataError = "";
  }
  async init() {
    const c = this.deps.config().embed;
    if (c) {
      try {
        if (c.viaConnect) await this.configureHosted(true);
        else await this.configure(c.origin, c.port);
      } catch {
        this.error =
          "Task website could not start. Check its local port and HTTPS setup.";
      }
    }
  }
  private async listen(port: number) {
    if (this.disposed) throw new Error("Plugin is stopping.");
    if (this.server?.listening && this.port === port) return;
    await this.closeServer();
    const server = createServer(
      {
        maxHeaderSize: 4096,
        requestTimeout: 5000,
        headersTimeout: 5000,
        connectionsCheckingInterval: 1000,
        keepAliveTimeout: 1000,
      },
      (req, res) => {
        try {
          this.respond(req, res);
        } catch {
          res.writeHead(500, { "Cache-Control": "no-store" });
          res.end("Preview unavailable.");
        }
      },
    );
    server.maxConnections = 32;
    server.maxRequestsPerSocket = 100;
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      if (this.disposed || this.server !== server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        throw new Error("Listener stopped.");
      }
      server.on("error", () => {
        this.error = "Task website listener failed. Save its setup again.";
        this.revoke();
        this.deps.changed();
      });
      this.port = port;
      server.unref();
    } catch {
      this.server = undefined;
      throw new Error(
        "Could not listen on that port. Choose an unused local port.",
      );
    }
  }
  private async closeServer() {
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    this.revoke();
    if (server)
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
  }
  async dispose() {
    this.disposed = true;
    await this.closeServer();
  }
  async configure(origin: unknown, port: unknown = EMBED_PORT) {
    if (this.changing || this.disposed)
      throw new Error("Task website setup is already changing.");
    const value = origin === "" ? undefined : embedOrigin(origin);
    if (
      !Number.isInteger(port) ||
      Number(port) < 1024 ||
      Number(port) > 65535 ||
      [8780, 8781].includes(Number(port))
    )
      throw new Error(
        "Choose an unused local port from 1024 to 65535, other than Zana’s product ports.",
      );
    this.changing = true;
    try {
      if (value) await this.listen(Number(port));
      else await this.closeServer();
      this.deps.config().embed = value
        ? { origin: value, port: Number(port) }
        : undefined;
      this.error = "";
      this.metadataError = "";
      this.deps.save();
    } finally {
      this.changing = false;
    }
  }
  private base() {
    const c = this.deps.config().embed;
    if (!c) return undefined;
    const hosted = this.deps.hostedBase?.();
    return c.viaConnect
      ? hosted && new URL(hosted).origin === c.origin
        ? hosted
        : undefined
      : c.origin;
  }
  async configureHosted(enabled: boolean) {
    if (this.changing || this.disposed)
      throw new Error("Task website setup is already changing.");
    const base = this.deps.hostedBase?.();
    if (enabled && !base) throw new Error("Connect your Zana account first.");
    this.changing = true;
    try {
      await this.closeServer();
      this.deps.config().embed = enabled
        ? { origin: new URL(base!).origin, port: EMBED_PORT, viaConnect: true }
        : undefined;
      this.error = this.metadataError = "";
      this.deps.save();
    } finally {
      this.changing = false;
    }
  }
  async preview() {
    if (this.changing)
      throw new Error("Task website setup is already changing.");
    this.changing = true;
    try {
      await this.listen(this.deps.config().embed?.port || EMBED_PORT);
      this.deps.changed();
      return { url: `http://127.0.0.1:${this.port}/demo` };
    } finally {
      this.changing = false;
    }
  }
  private route(b: Binding) {
    const c = this.deps.config();
    if (
      !c.enabled ||
      !c.owner ||
      !c.embed ||
      !featureEnabled(c, "status") ||
      (!c.embed.viaConnect && !this.server?.listening) ||
      !this.base() ||
      !this.deps.client() ||
      c.identity?.team !== b.team ||
      c.identity?.app !== b.app ||
      b.paused ||
      ["archived", "deleted"].includes(b.state)
    )
      return;
    return this.deps.routeFor ? this.deps.routeFor(b) : bindingRoute(c, b);
  }
  private policy(b: Binding) {
    const c = this.deps.config();
    return JSON.stringify([
      c.owner,
      c.identity,
      c.embed,
      this.base(),
      c.slackAccess,
      c.richResultsEnabled,
      c.agentChatEnabled,
      c.canvasEnabled,
      c.questionsEnabled,
      this.route(b),
    ]);
  }
  private entity(b: Binding, preview?: string) {
    return {
      url: `${this.base()}/tasks/${b.entityId}`,
      external_ref: { id: b.entityId, type: ENTITY_TYPE },
      entity_type: "slack#/entities/file",
      entity_payload: {
        attributes: {
          title: { text: (b.title || "Zana task").slice(0, 120) },
          product_name: "Zana",
          display_type: "Agent task",
          metadata_last_modified: Math.floor(b.updated / 1000),
          full_size_preview: {
            is_supported: true,
            mime_type: "application/vnd.slack-embed",
            ...(preview ? { preview_url: preview } : {}),
          },
        },
        fields: {},
      },
    };
  }
  metadata(key: string): Record<string, unknown> | undefined {
    const b = this.deps.store.get("binding", key);
    if (!b || !this.route(b) || this.metadataError) return;
    if (!b.entityId) {
      b.entityId = randomUUID();
      this.deps.store.put("binding", key, b);
    }
    return { entities: [this.entity(b)] };
  }
  rejectedMetadata() {
    this.metadataError =
      "Slack rejected the task card. Check Work Object settings, then save website setup to retry. Ordinary status messages still work.";
    this.deps.changed();
  }
  async handle(p: Record<string, any>, ack: SlackAck): Promise<boolean> {
    if (
      p.type !== "event_callback" ||
      p.event?.type !== "entity_details_requested"
    )
      return false;
    await ack();
    const c = this.deps.config(),
      e = p.event,
      slack = this.deps.client(),
      generation = this.generation;
    // Slack identity comes only from the authenticated Socket Mode envelope.
    if (
      !slack ||
      !c.enabled ||
      p.team_id !== c.identity?.team ||
      p.api_app_id !== c.identity?.app ||
      typeof e.trigger_id !== "string" ||
      e.trigger_id.length > 256 ||
      !e.trigger_id ||
      this.inflight >= 2
    )
      return true;
    const now = Date.now();
    for (const [id, expiry] of this.triggers)
      if (expiry <= now) this.triggers.delete(id);
    const trigger = digest(e.trigger_id);
    if (this.triggers.has(trigger) || this.triggers.size >= 100) return true;
    this.triggers.set(trigger, now + EMBED_TTL);
    this.inflight++;
    let tokenHash: string | undefined;
    try {
      const b =
        typeof e.external_ref?.id === "string" &&
        UUID.test(e.external_ref.id) &&
        e.external_ref.type === ENTITY_TYPE
          ? this.deps.store
              .list("binding")
              .find((b) => b.entityId === e.external_ref.id)
          : undefined;
      const permitted =
        b &&
        c.owner === e.user &&
        this.route(b) &&
        e.entity_url === this.entity(b).url;
      let allowed = false;
      if (permitted) {
        const [channel, member] = await Promise.all([
          slack.call("conversations.info", { channel: b.channel }),
          slack.call("users.info", { user: c.owner }),
        ]);
        const u = member.user;
        allowed =
          channel.ok === true &&
          (this.deps.authorize
            ? await this.deps.authorize(b)
            : internalChannel(channel.channel)) &&
          channel.channel.id === b.channel &&
          member.ok === true &&
          u?.id === c.owner &&
          u.team_id === c.identity?.team &&
          u.is_bot === false &&
          u.deleted === false &&
          u.is_restricted === false &&
          u.is_ultra_restricted === false;
      }
      if (generation !== this.generation || this.deps.client() !== slack)
        return true;
      const current = b && this.deps.store.get("binding", b.key);
      if (
        !allowed ||
        !current ||
        !this.route(current) ||
        current.entityId !== b?.entityId ||
        this.policy(current) !== this.policy(b!)
      ) {
        await slack.call("entity.presentDetails", {
          trigger_id: e.trigger_id,
          error: { status: "restricted" },
        });
        return true;
      }
      for (const [key, grant] of this.grants)
        if (grant.expires <= now) this.grants.delete(key);
      if (this.grants.size >= 256) throw new Error("Preview capacity reached.");
      const token = randomBytes(32).toString("base64url");
      tokenHash = digest(token);
      this.grants.set(tokenHash, {
        key: current.key,
        entity: current.entityId!,
        policy: this.policy(current),
        expires: now + EMBED_TTL,
      });
      const preview = `${this.base()}/view/${current.entityId}${c.embed!.viaConnect ? "#" : "?"}key=${token}`;
      const result = await slack.call("entity.presentDetails", {
        trigger_id: e.trigger_id,
        metadata: this.entity(current, preview),
      });
      if (result.ok !== true) throw new Error("Slack rejected the preview.");
      this.lastPresented = Date.now();
      this.error = "";
    } catch {
      if (tokenHash) this.grants.delete(tokenHash);
      this.error =
        "Task preview could not be opened. Check Slack’s Work Object settings and reopen the card.";
    } finally {
      this.inflight--;
      this.deps.changed();
    }
    return true;
  }
  private view(b: Binding, expires: number): TaskView {
    const route = this.route(b)!;
    const answer = featureEnabled(this.deps.config(), "answers")
      ? this.deps.store.sharedAnswer(b.key, route.summaries)
      : undefined;
    const c = this.deps.config();
    const question =
      c.questionsEnabled === true &&
      this.deps.store
        .list("question", ["waiting"], 100)
        .some(
          (q) =>
            q.key === b.key &&
            q.requestId === b.lastRequest &&
            q.ownerEpoch === c.ownerEpoch &&
            q.expires > Date.now() &&
            sameRoute(q.route, route),
        );
    const canvas =
      c.canvasEnabled === true &&
      featureEnabled(c, "answers") &&
      this.deps.store
        .canvasLinks(b.key)
        .find(
          (x) =>
            x.key === b.key &&
            x.ownerEpoch === c.ownerEpoch &&
            sameRoute(x.route, route),
        );
    return {
      title: (b.title || "Zana task").slice(0, 200),
      channel: b.sourceChannel
        ? "Private agent chat"
        : route.name.slice(0, 100),
      state: b.needsAttention
        ? "Needs your input"
        : {
            running: "Working",
            idle: "Ready",
            stopped: "Stopped",
            stopping: "Stopping",
            failed: "Failed",
            "needs-review": "Needs review",
          }[b.state] || "Waiting",
      attention: !!b.needsAttention || question,
      attentionText:
        !b.needsAttention && question
          ? "Answer the questions in this Slack conversation to continue."
          : undefined,
      canvas: canvas ? canvas.url : undefined,
      answer: answer?.text.slice(0, 2000) || "",
      result:
        this.deps.config().richResultsEnabled === true
          ? answer?.result
          : undefined,
      answerAt: answer ? answer.modified || answer.created : undefined,
      updated: b.updated,
      observed: Date.now(),
      expires,
      conversation: b.slackUrl || slackLink(b.team, b.channel, b.root),
    };
  }
  /** Only called through a signed Connect envelope; never proxies product HTTP. */
  hostedRead(input: Record<string, any>) {
    const nonce = randomBytes(18).toString("base64");
    const headers = {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src ${this.deps.config().embed?.origin || "'none'"}; frame-ancestors ${FRAME_ANCESTORS}; base-uri 'none'; form-action 'none'; object-src 'none'`,
    };
    const reply = (
      status: number,
      body: string,
      type = "text/plain; charset=utf-8",
    ) => ({ status, headers: { ...headers, "Content-Type": type }, body });
    if (
      !this.deps.config().embed?.viaConnect ||
      !this.base() ||
      !UUID.test(input.entityId || "")
    )
      return reply(403, "Task panel unavailable.");
    if (input.action === "page")
      return reply(
        200,
        renderTask(
          {
            title: "Opening your task…",
            channel: "Zana",
            state: "Connecting",
            attention: false,
            answer: "",
            updated: 0,
            observed: Date.now(),
            expires: Date.now() + EMBED_TTL,
            conversation: "",
          },
          nonce,
          false,
          true,
        ),
        "text/html; charset=utf-8",
      );
    if (input.action !== "data" || !/^[A-Za-z0-9_-]{43}$/.test(input.key || ""))
      return reply(403, "Reopen the task card in Slack.");
    const hash = digest(input.key),
      grant = this.grants.get(hash);
    if (!grant || grant.entity !== input.entityId)
      return reply(403, "Reopen the task card in Slack.");
    if (grant.expires <= Date.now()) {
      this.grants.delete(hash);
      return reply(410, "Task access expired.");
    }
    const b = this.deps.store.get("binding", grant.key);
    if (
      !b ||
      b.entityId !== input.entityId ||
      !this.route(b) ||
      this.policy(b) !== grant.policy
    ) {
      this.grants.delete(hash);
      return reply(403, "Task access ended.");
    }
    return reply(
      200,
      JSON.stringify(this.view(b, grant.expires)),
      "application/json; charset=utf-8",
    );
  }
  private respond(req: IncomingMessage, res: ServerResponse) {
    const nonce = randomBytes(18).toString("base64");
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src ${this.deps.config().embed?.origin || "'none'"}; frame-ancestors ${FRAME_ANCESTORS}; base-uri 'none'; form-action 'none'; object-src 'none'`,
    );
    const send = (
      status: number,
      text: string,
      type = "text/plain; charset=utf-8",
    ) => {
      res.writeHead(status, { "Content-Type": type });
      res.end(text);
    };
    if (Date.now() - this.window > 1000) {
      this.window = Date.now();
      this.requests = 0;
    }
    if (++this.requests > 60) {
      res.setHeader("Retry-After", "1");
      return send(429, "Please try again shortly.");
    }
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return send(405, "Read-only endpoint.");
    }
    // No Host, Origin, forwarded header, path or URL ever becomes a fetch target.
    if (
      !req.url?.startsWith("/") ||
      req.url.startsWith("//") ||
      req.url.length > 1024
    )
      return send(400, "Invalid request.");
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/health" && !url.search)
      return send(
        200,
        '{"ok":true,"service":"zana-task-embed"}',
        "application/json",
      );
    if (url.pathname === "/demo" && !url.search)
      return send(
        200,
        renderTask(sampleTask(true), nonce, true),
        "text/html; charset=utf-8",
      );
    if (/^\/tasks\/[0-9a-f-]{36}$/.test(url.pathname) && !url.search)
      return send(
        200,
        "Open this task from its Zana card in Slack. Access is granted to the linked owner there.",
      );
    const id = url.pathname.match(/^\/view\/([0-9a-f-]{36})$/)?.[1];
    if (!id || !UUID.test(id)) return send(404, "Not found.");
    res.setHeader("Access-Control-Allow-Origin", "*"); // Bearer-authenticated JSON also works in Slack's null-origin iframe. Never credentials/cookies.
    const key = url.searchParams.get("key");
    if (
      !key ||
      !/^[A-Za-z0-9_-]{43}$/.test(key) ||
      [...url.searchParams.keys()].join() !== "key"
    )
      return send(403, "Reopen the task card in Slack to request access.");
    const hash = digest(key),
      grant = this.grants.get(hash);
    if (!grant || grant.entity !== id)
      return send(403, "Reopen the task card in Slack to request access.");
    if (grant.expires <= Date.now()) {
      this.grants.delete(hash);
      return send(410, "Access expired. Reopen the task card in Slack.");
    }
    const b = this.deps.store.get("binding", grant.key);
    if (
      !b ||
      b.entityId !== id ||
      !this.route(b) ||
      this.policy(b) !== grant.policy
    ) {
      this.grants.delete(hash);
      return send(403, "Access ended. Reopen the task card in Slack.");
    }
    const view = this.view(b, grant.expires);
    return req.headers.accept === "application/json"
      ? send(200, JSON.stringify(view), "application/json; charset=utf-8")
      : send(200, renderTask(view, nonce), "text/html; charset=utf-8");
  }
}
