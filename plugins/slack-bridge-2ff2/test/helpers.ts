import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import { createFakePluginHost } from "@zana-ai/zcc-plugin-sdk/testing";
import type { PluginDatabase } from "@zana-ai/zcc-plugin-sdk/server";
import { Store } from "../src/store.js";
import { Bridge } from "../src/bridge.js";
import type { SlackConnection } from "../src/model.js";
export const identity = { team: "T123456", app: "A123456", bot: "U999999" };
export const route = {
  channel: "C123456",
  name: "agent-work",
  projectId: "p1",
  hostId: "h1",
  providerId: "codex",
  model: "demo-model",
  summaries: false,
};
export const internal = {
  id: "C123456",
  name: "agent-work",
  is_member: true,
  is_archived: false,
  is_shared: false,
  is_ext_shared: false,
  is_org_shared: false,
};
export const stamp = () => `${Math.floor(Date.now() / 1000)}.000001`;
export function body(
  text = "run hello",
  id = "Ev1",
  root = stamp(),
  user = "U123456",
) {
  return {
    type: "event_callback",
    event_id: id,
    team_id: identity.team,
    api_app_id: identity.app,
    event: {
      type: "app_mention",
      user,
      channel: route.channel,
      ts: stamp(),
      thread_ts: root,
      text: `<@${identity.bot}> ${text}`,
    },
  };
}
export function dbAdapter(db = new DatabaseSync(":memory:")) {
  const adapter: PluginDatabase = {
    runScript(sql) {
      db.exec(sql);
    },
    prepare(sql) {
      const s = db.prepare(sql);
      return {
        all: (...p) => s.all(...(p as any[])),
        get: (...p) => s.get(...(p as any[])),
        run: (...p) => ({ changes: Number(s.run(...(p as any[])).changes) }),
      };
    },
    migrate(sql) {
      for (const s of sql) db.exec(s);
    },
    transaction(fn) {
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { db, adapter };
}
export function setup() {
  const { db, adapter } = dbAdapter();
  const { zcc, harness } = createFakePluginHost({
    pluginId: "slack-bridge-2ff2",
    database: adapter,
  } as any);
  const threads = new Map<string, any>();
  const spawn = vi.fn(async (args: any) => {
    const id = "th" + (threads.size + 1);
    threads.set(id, { id, ...args, status: "running" });
    return { id };
  });
  const send = vi.fn(async ({ threadId }: any) => {
    threads.get(threadId).status = "running";
    return { id: threadId };
  });
  const stop = vi.fn(async ({ threadId }: any) => {
    threads.get(threadId).status = "idle";
    return { ok: true };
  });
  const host = zcc as any;
  host.sdk.projects.list = vi.fn(async () => [{ id: "p1", name: "Project" }]);
  host.sdk.assistant.complete = vi.fn(async ({ prompt }: any) => {
    const context = JSON.parse(prompt);
    return {
      text: JSON.stringify(
        context.currentProjectId
          ? { kind: "launch", projectId: context.currentProjectId }
          : {
              kind: "clarify",
              text: "Which connected Project?",
              intent: "task",
            },
      ),
    };
  });
  host.sdk.system.defaultHost = vi.fn(async () => ({ id: "h1" }));
  host.sdk.hosts = { list: vi.fn(async () => [{ id: "h1", name: "Mac" }]) };
  host.sdk.providers.list = vi.fn(async () => [
    { id: "codex", displayName: "Codex", available: true },
  ]);
  host.sdk.providers.models = vi.fn(async () => ({
    models: [
      { id: "demo-model", model: "demo-model", supportedReasoningEfforts: [] },
    ],
    selectedOnlyModels: [],
    modelLoadError: null,
  }));
  host.sdk.threads.updatePluginMetadata = vi.fn(
    async ({ threadId, set }: any) => {
      const thread = threads.get(threadId);
      if (thread) thread.pluginMetadata = { ...thread.pluginMetadata, ...set };
      return thread?.pluginMetadata ?? set;
    },
  );
  host.sdk.threads.spawn = spawn;
  host.sdk.threads.send = send;
  host.sdk.threads.stop = stop;
  host.sdk.threads.get = vi.fn(
    async ({ threadId }: any) => threads.get(threadId) || null,
  );
  const call = vi.fn(async (method: string, args?: any): Promise<any> => {
    if (method === "chat.getPermalink")
      return {
        ok: true,
        permalink: `https://demo.slack.com/archives/${args.channel}/p${args.message_ts.replace(".", "")}`,
      };
    if (method === "views.publish")
      return { ok: true, view: { id: "V123456" } };
    if (method === "views.open") return { ok: true, view: { id: "V654321" } };
    if (method === "auth.test")
      return {
        ok: true,
        team_id: identity.team,
        user_id: identity.bot,
        bot_id: "B123456",
      };
    if (method === "conversations.info") return { ok: true, channel: internal };
    if (method === "users.info")
      return {
        ok: true,
        user: {
          id: "U123456",
          team_id: identity.team,
          is_bot: false,
          deleted: false,
          is_restricted: false,
          is_ultra_restricted: false,
        },
      };
    return { ok: true, channel: args.channel, ts: args.ts || stamp() };
  });
  let receiver: (
    body: unknown,
    ack: () => Promise<void>,
  ) => Promise<void> = async () => {};
  const slack: SlackConnection = {
    call,
    start: vi.fn(async (receive, state) => {
      receiver = receive;
      state("Connected");
    }),
    close: vi.fn(async () => {}),
  };
  const settings = {
    get: vi.fn(async () => ({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      appId: identity.app,
    })),
    onChange: vi.fn(),
  };
  const store = new Store(adapter);
  store.configure({
    identity,
    owner: "U123456",
    routes: [route],
    enabled: false,
  });
  const bridge = new Bridge(zcc, store, settings, () => slack);
  return {
    bridge,
    store,
    db,
    zcc,
    harness,
    threads,
    spawn,
    send,
    stop,
    slack,
    call,
    settings,
    async connect() {
      await bridge.connect();
    },
    async receive(b = body()) {
      const ack = vi.fn(async (_response?: Record<string, unknown>) => {});
      await receiver(b, ack);
      return ack;
    },
    async close() {
      await bridge.dispose();
      db.close();
    },
  };
}
