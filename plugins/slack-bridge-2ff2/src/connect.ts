import { createHmac, timingSafeEqual } from "node:crypto";
import type { ZccPluginApi } from "@zana-ai/zcc-plugin-sdk/server";
type PluginStorage = ZccPluginApi["storage"];
type PluginHttpResponse = { status?: number; json?: unknown };
import {
  APP,
  MEMBER,
  object,
  type Identity,
  type SlackConnection,
  type SlackAck,
} from "./model.js";

type Grant = {
  origin: string;
  linkId: string;
  credential: string;
  identity: Identity;
  owner: string;
  computer: string;
};
const KEY = "connect-grant-v1";
export class ConnectTransport {
  private grant?: Grant;
  private receive?: (body: unknown, ack: SlackAck) => Promise<void>;
  private abort?: AbortController;
  private work = new Set<Promise<void>>();
  private changing = false;
  private tools?: (input: unknown) => Promise<Record<string, unknown>>;
  setTools(handler: (input: unknown) => Promise<Record<string, unknown>>) {
    this.tools = handler;
  }
  private embeds?: (input: Record<string, any>) => unknown;
  setEmbeds(handler: (input: Record<string, any>) => unknown) {
    this.embeds = handler;
  }
  embedBase() {
    return this.grant
      ? `${this.grant.origin}/api/slack/tasks/${this.grant.linkId}`
      : undefined;
  }
  constructor(
    private storage: PluginStorage,
    private fetcher: typeof fetch = fetch,
  ) {
    storage
      .database()
      .runScript(
        "CREATE TABLE IF NOT EXISTS connect_nonces (nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL)",
      );
  }
  async init() {
    this.grant = await this.storage.kv.get<Grant>(KEY);
  }
  snapshot() {
    return this.grant
      ? {
          linked: true,
          origin: this.grant.origin,
          owner: this.grant.owner,
          computer: this.grant.computer,
        }
      : { linked: false };
  }
  configured() {
    return !!this.grant;
  }
  private async request(
    origin: string,
    path: string,
    body: unknown,
    credential?: string,
  ) {
    const timeout =
      path === "call" && object(body).method === "files.uploadDiagram"
        ? 40_000
        : 10_000;
    const response = await this.fetcher(
      `${origin}/api/connect/slack/${path}/`,
      {
        method: "POST",
        redirect: "error",
        signal: this.abort
          ? AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeout)])
          : AbortSignal.timeout(timeout),
        headers: {
          "content-type": "application/json",
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        },
        body: JSON.stringify(body),
      },
    );
    if (response.status === 401 && path === "unlink") {
      await response.body?.cancel();
      return { revoked: true };
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        response.status === 401
          ? "Slack link was revoked. Link this computer again."
          : response.status === 410
            ? "Activation code expired. Start again from Zana Home in Slack."
            : "Connect could not complete this request. Check your chosen computer and service connection.",
      );
    }
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 256 * 1024) {
          await reader.cancel();
          throw new Error("Connect response too large.");
        }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally {
      reader.releaseLock();
    }
  }
  async link(originValue: unknown, code: unknown) {
    if (this.changing) throw new Error("Connection is already changing.");
    const origin = new URL(typeof originValue === "string" ? originValue : "");
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== "/"
    )
      throw new Error("Use the HTTPS origin of your Zana Connect service.");
    if (typeof code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(code))
      throw new Error("Paste the activation code from Zana Connect.");
    this.changing = true;
    try {
      const value = await this.request(origin.origin, "redeem", { code });
      if (
        !/^[a-f0-9-]{36}$/.test(value.linkId) ||
        typeof value.credential !== "string" ||
        !value.credential.startsWith(`${value.linkId}.`) ||
        !/^[A-Za-z0-9_-]{43}$/.test(value.credential.slice(37)) ||
        !APP.test(value.identity?.app) ||
        !MEMBER.test(value.identity?.bot) ||
        !/^T[A-Z0-9]{5,30}$/.test(value.identity?.team) ||
        !MEMBER.test(value.owner)
      )
        throw new Error("Invalid Connect identity.");
      const previous = this.grant;
      this.grant = {
        origin: origin.origin,
        linkId: value.linkId,
        credential: value.credential,
        identity: value.identity,
        owner: value.owner,
        computer: String(value.computer).slice(0, 100),
      };
      await this.storage.kv.set(KEY, this.grant);
      try {
        await this.request(origin.origin, "activate", {}, value.credential);
      } catch (error) {
        // Keep the candidate only if the server confirms a lost activation response.
        try {
          await this.request(origin.origin, "status", {}, value.credential);
        } catch {
          this.grant = previous;
          if (previous) await this.storage.kv.set(KEY, previous);
          else await this.storage.kv.delete(KEY);
          throw error;
        }
      }
    } finally {
      this.changing = false;
    }
  }
  async unlink() {
    if (this.changing) throw new Error("Connection is already changing.");
    this.changing = true;
    try {
      const grant = this.grant;
      // Revoke centrally before discarding the local key; failed revocation stays visible.
      if (grant)
        await this.request(grant.origin, "unlink", {}, grant.credential);
      this.grant = undefined;
      this.receive = undefined;
      await this.storage.kv.delete(KEY);
    } finally {
      this.changing = false;
    }
  }
  async connection(): Promise<
    { client: SlackConnection; identity: Identity; owner: string } | undefined
  > {
    const grant = this.grant;
    if (!grant) return;
    this.abort = new AbortController();
    const abort = this.abort;
    await this.request(grant.origin, "status", {}, grant.credential);
    return {
      identity: grant.identity,
      owner: grant.owner,
      client: {
        call: (method, args = {}) => {
          if (abort.signal.aborted) throw new Error("Connection closed.");
          return this.request(
            grant.origin,
            "call",
            { method, args },
            grant.credential,
          );
        },
        start: async (receive, state) => {
          if (abort.signal.aborted) throw new Error("Connection closed.");
          this.receive = receive;
          state("Connected");
        },
        close: async () => {
          this.receive = undefined;
          abort.abort();
          if (this.abort === abort) this.abort = undefined;
        },
      },
    };
  }
  async handle(input: unknown): Promise<PluginHttpResponse> {
    const p = object(input),
      grant = this.grant;
    const reject = (status: number, notStarted = true) => ({
      status,
      json: { accepted: false, notStarted },
    });
    if (
      !grant ||
      p.v !== 1 ||
      p.linkId !== grant.linkId ||
      !Number.isSafeInteger(p.timestamp) ||
      Math.abs(Date.now() - p.timestamp) > 60_000 ||
      typeof p.nonce !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(p.nonce) ||
      typeof p.body !== "string" ||
      Buffer.byteLength(p.body) > 256 * 1024 ||
      typeof p.signature !== "string" ||
      !/^[a-f0-9]{64}$/.test(p.signature)
    )
      return reject(401);
    const message = {
      v: 1,
      linkId: p.linkId,
      timestamp: p.timestamp,
      nonce: p.nonce,
      body: p.body,
    };
    const signature = createHmac("sha256", grant.credential.slice(37))
      .update(JSON.stringify(message))
      .digest("hex");
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(p.signature)))
      return reject(401);
    const db = this.storage.database();
    db.prepare("DELETE FROM connect_nonces WHERE expires<?").run(Date.now());
    if (
      Number(
        (
          db.prepare("SELECT COUNT(*) AS n FROM connect_nonces").get() as {
            n: number;
          }
        ).n,
      ) >= 2000
    )
      return reject(429);
    if (
      !db
        .prepare(
          "INSERT OR IGNORE INTO connect_nonces(nonce,expires) VALUES(?,?)",
        )
        .run(p.nonce, Date.now() + 120_000).changes
    )
      return reject(409, false);
    let body;
    try {
      body = object(JSON.parse(p.body));
    } catch {
      return reject(400);
    }
    if (body.kind === "probe") return { json: { linkId: grant.linkId } };
    const embed = body.kind === "embed";
    const tool = body.kind === "tool";
    if (
      (!tool && !embed && body.kind !== "event") ||
      !this.receive ||
      this.work.size >= 20 ||
      (tool && !this.tools) ||
      (embed && !this.embeds)
    )
      return reject(503);
    const payload = object(body.payload);
    const event = payload.type === "event_callback";
    if (
      (tool || embed
        ? body.team
        : event
          ? payload.team_id
          : (payload.team?.id ?? payload.team_id)) !== grant.identity.team ||
      (tool || embed ? body.app : payload.api_app_id) !== grant.identity.app ||
      (tool || embed
        ? body.user
        : event
          ? payload.event?.user
          : (payload.user?.id ?? payload.user_id)) !== grant.owner
    )
      return reject(403);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: PluginHttpResponse) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      };
      const timer = setTimeout(
        () => finish(reject(504, false)),
        tool ? 9_000 : 1400,
      );
      timer.unref?.();
      const work = Promise.resolve()
        .then(async () => {
          if (embed) {
            finish({
              json: { accepted: true, response: await this.embeds!(body) },
            });
          } else if (tool) {
            const response = await this.tools!(body);
            finish({ json: { accepted: true, response } });
          } else
            await this.receive!(payload, async (response) => {
              finish({ json: { accepted: true, response: response ?? {} } });
            });
        })
        .catch(() => finish(reject(500, false)))
        .finally(() => this.work.delete(work));
      this.work.add(work);
    });
  }
  async dispose() {
    this.receive = undefined;
    this.tools = undefined;
    this.embeds = undefined;
    this.abort?.abort();
    await Promise.allSettled([...this.work]);
  }
}
