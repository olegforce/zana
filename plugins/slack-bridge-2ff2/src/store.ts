import type { PluginDatabase } from "@zana-ai/zcc-plugin-sdk/server";
import type {
  Binding,
  Config,
  Delivery,
  Receipt,
  HomeLaunch,
  LaunchConversation,
} from "./model.js";
import type { AgentChatSession } from "./agent-chat.js";
import type { ConversationTurn } from "./conversation.js";
import type { SlackQuestion, CanvasExport } from "./slack-forms.js";

type Entities = {
  receipt: Receipt;
  binding: Binding;
  delivery: Delivery;
  homeLaunch: HomeLaunch;
  launchConversation: LaunchConversation;
  agentChat: AgentChatSession;
  chatTurn: ConversationTurn;
  question: SlackQuestion;
  canvas: CanvasExport;
};
export class Store {
  constructor(private db: PluginDatabase) {
    db.migrate([
      `CREATE TABLE IF NOT EXISTS bridge_records (kind TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL, updated INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id)); CREATE INDEX IF NOT EXISTS bridge_records_state ON bridge_records(kind,state,updated); CREATE TABLE IF NOT EXISTS bridge_config (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);`,
    ]);
    // An interrupted invitation is ambiguous, just like an interrupted outbox write.
    db.prepare(
      "UPDATE bridge_records SET data=json_set(data,'$.offer','uncertain') WHERE kind='homeLaunch' AND json_extract(data,'$.offer')='sending'",
    ).run();
  }
  config(): Config {
    const row = this.db
      .prepare("SELECT data FROM bridge_config WHERE id=1")
      .get() as { data: string } | undefined;
    return row ? JSON.parse(row.data) : { routes: [], enabled: false };
  }
  configure(config: Config): void {
    this.db
      .prepare(
        "INSERT INTO bridge_config(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(JSON.stringify(config));
  }
  get<K extends keyof Entities>(kind: K, id: string): Entities[K] | undefined {
    const row = this.db
      .prepare("SELECT data FROM bridge_records WHERE kind=? AND id=?")
      .get(kind, id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  put<K extends keyof Entities>(kind: K, id: string, data: Entities[K]): void {
    this.db
      .prepare(
        "INSERT INTO bridge_records(kind,id,state,updated,data) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET state=excluded.state,updated=excluded.updated,data=excluded.data",
      )
      .run(kind, id, data.state, Date.now(), JSON.stringify(data));
  }
  insert(receipt: Receipt): boolean {
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO bridge_records(kind,id,state,updated,data) VALUES(?,?,?,?,?)",
        )
        .run(
          "receipt",
          receipt.id,
          receipt.state,
          receipt.created,
          JSON.stringify(receipt),
        ).changes === 1
    );
  }
  list<K extends keyof Entities>(
    kind: K,
    states?: string[],
    limit = 1000,
  ): Entities[K][] {
    const rows = states?.length
      ? this.db
          .prepare(
            `SELECT data FROM bridge_records WHERE kind=? AND state IN (${states.map(() => "?").join(",")}) ORDER BY updated ASC LIMIT ?`,
          )
          .all(kind, ...states, limit)
      : this.db
          .prepare(
            "SELECT data FROM bridge_records WHERE kind=? ORDER BY updated DESC LIMIT ?",
          )
          .all(kind, limit);
    return (rows as { data: string }[]).map((r) => JSON.parse(r.data));
  }
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }
  count(kind: keyof Entities, states: string[] = []): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM bridge_records WHERE kind=?${states.length ? ` AND state IN (${states.map(() => "?").join(",")})` : ""}`,
      )
      .get(kind, ...states) as { n: number };
    return Number(row.n);
  }
  makeConversationRoom() {
    this.db
      .prepare(
        "DELETE FROM bridge_records WHERE kind='chatTurn' AND state IN ('sent','failed','uncertain') AND rowid IN (SELECT rowid FROM bridge_records WHERE kind='chatTurn' AND state IN ('sent','failed','uncertain') ORDER BY updated DESC LIMIT -1 OFFSET 899)",
      )
      .run();
  }
  next<K extends "agentChat" | "canvas" | "chatTurn">(
    kind: K,
    states: string[],
    now = Date.now(),
  ): Entities[K] | undefined {
    const row = this.db
      .prepare(
        `SELECT data FROM bridge_records WHERE kind=? AND state IN (${states.map(() => "?").join(",")}) AND COALESCE(json_extract(data,'$.next'),0)<=? ORDER BY updated ASC LIMIT 1`,
      )
      .get(kind, ...states, now) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  canvasLinks(
    key?: string,
  ): Pick<
    CanvasExport,
    "id" | "key" | "state" | "ownerEpoch" | "route" | "url"
  >[] {
    // Home and panel refreshes need links and policy, never large document snapshots.
    const rows = this.db
      .prepare(
        "SELECT json_object('id',id,'key',json_extract(data,'$.key'),'state',state,'ownerEpoch',json_extract(data,'$.ownerEpoch'),'route',json_extract(data,'$.route'),'url',json_extract(data,'$.url')) AS data FROM bridge_records WHERE kind='canvas' AND state='published' AND (? IS NULL OR json_extract(data,'$.key')=?) ORDER BY updated DESC LIMIT 100",
      )
      .all(key ?? null, key ?? null) as { data: string }[];
    return rows.map((r) => {
      const v = JSON.parse(r.data);
      if (v.ownerEpoch === null) delete v.ownerEpoch;
      return v;
    });
  }
  sharedAnswer(key: string, summaries: boolean): Delivery | undefined {
    const row = this.db
      .prepare(
        "SELECT data FROM bridge_records WHERE kind='delivery' AND state='sent' AND json_extract(data,'$.key')=? AND json_extract(data,'$.questionId') IS NULL AND json_extract(data,'$.canvasId') IS NULL AND (json_extract(data,'$.origin')='operator' OR (?=1 AND json_extract(data,'$.origin')='agent')) ORDER BY updated DESC LIMIT 1",
      )
      .get(key, summaries ? 1 : 0) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  recover(): void {
    this.transaction(() => {
      for (const s of this.list("chatTurn", ["processing", "sending"], 1000))
        this.put("chatTurn", s.id, {
          ...s,
          state: "uncertain",
          note: "Conversation interrupted; inspect Slack and Zana before retrying.",
        });
      for (const s of this.list("agentChat", ["sending"]))
        this.put("agentChat", s.id, {
          ...s,
          state: "uncertain",
          note: "Welcome delivery interrupted; inspect Slack before retrying.",
        });
      for (const s of this.list("canvas", ["creating"]))
        this.put("canvas", s.id, {
          ...s,
          state: "uncertain",
          note: "Canvas creation interrupted; inspect Slack before exporting again.",
        });
      for (const r of this.list("receipt", ["dispatching"]))
        this.put("receipt", r.id, {
          ...r,
          state: "needs-review",
          note: "Interrupted during dispatch. Inspect Zana before sending a new request.",
        });
      for (const d of this.list("delivery", ["sending"]))
        this.put("delivery", d.id, {
          ...d,
          state: "uncertain",
          note: "Interrupted during posting. Check Slack before composing another message.",
        });
    });
  }
  prune(now = Date.now()): void {
    this.db
      .prepare(
        "DELETE FROM bridge_records WHERE kind='chatTurn' AND state NOT IN ('processing','sending') AND (updated < ? OR rowid IN (SELECT rowid FROM bridge_records WHERE kind='chatTurn' ORDER BY updated DESC LIMIT -1 OFFSET 1000))",
      )
      .run(now - 30 * 86400000);
    this.db
      .prepare(
        "DELETE FROM bridge_records WHERE kind='launchConversation' AND (updated < ? OR rowid IN (SELECT rowid FROM bridge_records WHERE kind='launchConversation' ORDER BY updated DESC LIMIT -1 OFFSET 1000))",
      )
      .run(now - 30 * 86400000);
    this.db
      .prepare(
        "DELETE FROM bridge_records WHERE kind IN ('agentChat','question','canvas') AND state NOT IN ('sending','creating','uncertain','queued','sharing','created') AND (updated < ? OR rowid IN (SELECT rowid FROM bridge_records WHERE kind IN ('agentChat','question','canvas') AND state NOT IN ('sending','creating','uncertain','queued','sharing','created') ORDER BY updated DESC LIMIT -1 OFFSET 1000))",
      )
      .run(now - 30 * 86400000);
    this.db
      .prepare(
        "DELETE FROM bridge_records WHERE kind='homeLaunch' AND updated < ?",
      )
      .run(now - 30 * 86400000);
    this.db
      .prepare(
        "DELETE FROM bridge_records WHERE kind='homeLaunch' AND state='draft' AND updated < ?",
      )
      .run(now - 15 * 60000);
    // Keep duplicate tombstones for 30 days; terminal payloads are bounded to 5,000 rows.
    this.db
      .prepare(
        "DELETE FROM bridge_records WHERE kind IN ('receipt','delivery') AND state IN ('settled','rejected','cancelled','sent','removed','failed','reviewed') AND (updated < ? OR rowid IN (SELECT rowid FROM bridge_records WHERE kind IN ('receipt','delivery') AND state IN ('settled','rejected','cancelled','sent','removed','failed','reviewed') ORDER BY updated DESC LIMIT -1 OFFSET 5000))",
      )
      .run(now - 30 * 86400000);
  }
}
