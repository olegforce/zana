import { persistSlackSurface } from "./src/interaction-surface.js";
import { accessView, featureEnabled, setFeature } from "./src/access.js";
import type { ZccPluginApi } from "@zana-ai/zcc-plugin-sdk/server";
import { Bridge } from "./src/bridge.js";
import { Store } from "./src/store.js";
import { createSlack } from "./src/slack.js";
import { object, string } from "./src/model.js";
import { richResultSchema } from "./src/rich-result.js";
import { questionSchema } from "./src/slack-forms.js";
import { ConnectTransport } from "./src/connect.js";
import {
  SlackCapabilities,
  builtInCapabilities,
  slackCommands,
  type SlackCapability,
  type SlackCapabilityService,
} from "./src/capabilities.js";
import { SlackbotJobs } from "./src/slackbot.js";

export default async function plugin(zcc: ZccPluginApi) {
  const directDescriptors = {
    appId: {
      type: "string",
      label: "Slack app ID",
      description: "The A… identifier under Basic Information.",
    },
    appToken: {
      type: "string",
      label: "App-level token",
      secret: true,
      description: "xapp-… with connections:write.",
    },
    botToken: {
      type: "string",
      label: "Bot user token",
      secret: true,
      description: "xoxb-… for the installed Slack app.",
    },
  } as const;
  const store = new Store(zcc.storage.database());
  const remote = new ConnectTransport(zcc.storage);
  await remote.init();
  const directChoice = await zcc.storage.kv.get<boolean>("directSetup");
  let directSetup =
    !remote.configured() &&
    (directChoice === true ||
      (directChoice === undefined && !!store.config().identity));
  if (remote.configured()) await zcc.storage.kv.set("directSetup", false);
  let settings = zcc.settings.define(directSetup ? directDescriptors : {});
  const defineSettings = () => {
    settings = zcc.settings.define(
      directSetup && !remote.configured() ? directDescriptors : {},
    );
  };
  const bridge = new Bridge(
    zcc,
    store,
    {
      get: () => settings.get(),
      onChange: (listener) => settings.onChange(listener),
    },
    createSlack,
    () => remote.connection(),
    () => remote.embedBase(),
  );
  const capabilities = new SlackCapabilities(bridge);
  const services = (
    zcc as typeof zcc & {
      services?: { provide(value: SlackCapabilityService): void };
    }
  ).services;
  services?.provide({
    register: (pluginId: string, capability: SlackCapability) =>
      capabilities.register(pluginId, capability),
  });
  const jobs = new SlackbotJobs(bridge, capabilities);
  remote.setTools((input) => jobs.handle(input));
  remote.setEmbeds((input) => bridge.embeds.hostedRead(input));
  zcc.http.route("POST", "/connect", (request) => remote.handle(request.body));
  zcc.onDispose(async () => {
    capabilities.dispose();
    await bridge.dispose();
    await remote.dispose();
  });
  settings.onChange(() => {
    if (!remote.configured()) void bridge.disconnect().catch(() => {});
  });
  const method = (name: string, handler: (args: unknown) => unknown) =>
    zcc.rpc.method(name, async (args) => {
      try {
        return (await handler(args)) ?? null;
      } catch (error) {
        return {
          bridgeError:
            error instanceof Error
              ? error.message.replace(
                  /x(?:ox[baprs]|app)-[\w-]+/g,
                  "[redacted]",
                )
              : "Action failed.",
        };
      }
    });
  method("snapshot", async () => ({
    ...object(await bridge.snapshot()),
    connect: remote.snapshot(),
    directSetup: directSetup && !remote.configured(),
    capabilities: {
      features: accessView(bridge.config),
      builtins: builtInCapabilities,
      commands: slackCommands,
      plugins: capabilities.list(true),
      extensible: !!services,
    },
  }));
  method("linkConnect", async (args) => {
    const input = object(args);
    await bridge.disconnect();
    await remote.link(input.origin, input.code);
    directSetup = false;
    await zcc.storage.kv.set("directSetup", false);
    defineSettings();
    await bridge.connect();
  });
  method("unlinkConnect", async () => {
    await bridge.disconnect();
    await remote.unlink();
    await bridge.resetOwner();
    directSetup = false;
    await zcc.storage.kv.set("directSetup", false);
    defineSettings();
  });
  method("enableDirectSetup", async () => {
    if (remote.configured())
      throw new Error("Unlink Zana Connect before using your own Slack app.");
    directSetup = true;
    await zcc.storage.kv.set("directSetup", true);
    defineSettings();
  });
  method("configureHostedEmbed", (args) =>
    bridge.embeds.configureHosted(object(args).enabled === true),
  );
  method("setRichResults", (args) => {
    const enabled = object(args).enabled;
    if (typeof enabled !== "boolean")
      throw new Error("Choose whether to share rich results.");
    bridge.config.richResultsEnabled = enabled;
    bridge.save();
  });
  method("setSurface", (args) => {
    const { surface, enabled } = object(args);
    if (
      ![
        "agentChatEnabled",
        "canvasEnabled",
        "questionsEnabled",
        "inboxEnabled",
      ].includes(surface) ||
      typeof enabled !== "boolean"
    )
      throw new Error("Choose a valid Slack surface.");
    if (
      surface === "inboxEnabled" &&
      enabled &&
      (!zcc.sdk.assistant?.complete ||
        !zcc.sdk.inbox.search ||
        !zcc.sdk.inbox.read)
    )
      throw new Error("Update Zana to enable the conversational report inbox.");
    bridge.config[
      surface as
        | "agentChatEnabled"
        | "canvasEnabled"
        | "questionsEnabled"
        | "inboxEnabled"
    ] = enabled;
    bridge.save();
  });
  method("previewEmbed", () => bridge.embeds.preview());
  method("configureEmbed", (args) =>
    bridge.embeds.configure(object(args).origin, object(args).port),
  );
  method("refreshHome", () => bridge.home.publish(true));
  method("cleanupStatuses", () => bridge.cleanupStatuses());
  method("removeTaskPreview", (args) =>
    bridge.removeTaskPreview(string(object(args).id, 100)),
  );
  method("dismissHomeRequest", (args) =>
    bridge.home.dismiss(string(object(args).id, 100)),
  );
  method("connect", () => bridge.connect());
  method("disconnect", () => bridge.disconnect());
  method("pair", (args) => bridge.pair(object(args).user));
  method("resetOwner", async () => {
    if (remote.configured()) throw new Error("Unlink Zana Connect first.");
    await bridge.resetOwner();
  });
  method("channels", () => bridge.channels());
  method("testChannel", (args) => bridge.testChannel(object(args).channel));
  method("mute", (args) => {
    const a = object(args);
    if (typeof a.muted !== "boolean") throw new Error("Choose mute or unmute.");
    return bridge.mute(string(a.key, 300), a.muted);
  });
  method("models", (args) => bridge.models(args));
  method("addRoute", (args) => bridge.addRoute(args));
  method("setMentionDefault", (args) => bridge.setMentionDefault(args));
  method("configureProjectSync", (args) => bridge.configureProjectSync(args));
  method("syncProjects", () => bridge.syncProjects());
  method("importProjects", (args) => bridge.importProjects(args));
  method("setSlackAccess", (args) => {
    setFeature(bridge.config, object(args).id, object(args).enabled);
    bridge.embeds.revoke();
    bridge.save();
  });
  method("enableCapability", (args) =>
    capabilities.enable(object(args).id, object(args).enabled),
  );
  method("removeRoute", (args) => bridge.removeRoute(object(args).channel));
  method("stop", (args) => bridge.stop(string(object(args).key, 300)));
  method("resolve", (args) => bridge.resolve(string(object(args).id, 100)));
  method("resolveDelivery", (args) =>
    bridge.resolveDelivery(string(object(args).id, 100)),
  );
  method("publish", (args) => {
    const a = object(args);
    return bridge.publish(
      string(a.threadId, 100),
      string(a.projectId, 100),
      string(a.text),
      true,
      a.result,
    );
  });
  for (const name of [
    "thread.active",
    "thread.idle",
    "thread.failed",
    "thread.archived",
    "thread.deleted",
  ] as const)
    zcc.events.on(name, (e) =>
      bridge.event(e).catch(() => {
        zcc.log.warn("Slack lifecycle update needs attention.");
      }),
    );
  zcc.agents.registerTool({
    name: "slack_bridge_publish",
    description:
      "Share one final answer with its fixed Slack conversation. Keep text under 2000 characters. When rich results are enabled, put longer code/diffs in result.sections: each section requires type, title and text (not code or diff fields); code may also have language. Never publish secrets, arbitrary files or raw tool output.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: 2000 },
        result: richResultSchema,
      },
      required: ["text"],
      additionalProperties: false,
    },
    execute(input, ctx) {
      return bridge.publish(
        ctx.threadId,
        ctx.projectId,
        string(object(input).text),
        false,
        object(input).result,
      );
    },
  });
  zcc.agents.registerTool({
    name: "slack_bridge_ask",
    description:
      "Ask one to three ordinary preference or clarification questions in this fixed Slack conversation. The owner can choose an option or write an answer. End the turn after asking; answers arrive as a follow-up. This cannot grant tool execution permissions.",
    parameters: {
      type: "object",
      properties: { questions: questionSchema },
      required: ["questions"],
      additionalProperties: false,
    },
    execute(input, ctx) {
      return bridge.forms.ask(
        ctx.threadId,
        ctx.projectId,
        object(input).questions,
      );
    },
  });
  zcc.agents.configure(async (ctx) => {
    const binding = bridge.store
      .list("binding")
      .find((b) => b.threadId === ctx.threadId);
    const metadata = (
      ctx as { pluginMetadata?: { slackConversation?: string } }
    ).pluginMetadata;
    const pending = metadata?.slackConversation
      ? bridge.store
          .list("receipt", ["dispatching"])
          .find((r) => r.key === metadata.slackConversation)
      : undefined;
    const channel = binding?.channel || pending?.channel;
    if (!channel && !metadata?.slackConversation) return;
    // Context is independent of whether the owner permits answer sharing.
    // Persist for legacy bindings; subsequent core gates survive plugin unload.
    if (ctx.threadId) await persistSlackSurface(zcc, ctx.threadId);
    const canShare =
      !!channel &&
      featureEnabled(bridge.config, "answers") &&
      !!bridge.destinationRoute(channel, binding?.root || pending?.root || "")
        ?.summaries;
    const canAsk =
      canShare &&
      bridge.config.questionsEnabled === true &&
      featureEnabled(bridge.config, "followups");
    return {
      tools: canShare
        ? ["slack_bridge_publish", ...(canAsk ? ["slack_bridge_ask"] : [])]
        : [],
      instructions:
        "The user is interacting through Slack and cannot see Zana's desktop panels. Do not open files, browsers, visualizations, terminals or plugin panels in Zana to present results. Background work and hidden browser automation remain available. A localhost URL or local path is not a remote preview. " +
        (canShare
          ? "Use slack_bridge_publish for one concise final answer at the end of each turn. Standard Markdown is formatted automatically for Slack. Mermaid code fences are rendered locally into image previews when Slack uploads are available; include a short readable text overview as a fallback. Share Mermaid directly in your answer or a rich code section with language mermaid; do not upload repository files or use an external diagram service. Its destination is fixed by the host. A queued result is not proof of Slack delivery. "
          : "Answer sharing is disabled for this destination; do not claim an answer or file was delivered to Slack. ") +
        (canShare && bridge.config.richResultsEnabled === true
          ? "Rich results are enabled: keep the top-level text summary under 2000 characters and put longer excerpts in result.sections. Every section requires a title; text/code/diff sections use a text field, never code or diff fields. For example: {title:'Review',sections:[{type:'diff',title:'Changes',text:'...'}, {type:'code',title:'Revised code',language:'apex',text:'...'}]}. Each code/diff excerpt is limited to 2800 characters. Use text, code, diff, table, chart or tasks sections. A tasks board is your reported snapshot, not a live editable task system. Share bounded code/diff excerpts only when the user requested them; do not read or upload arbitrary files for display. Reports are labelled as agent-supplied, not host-verified. "
          : "Rich results are disabled; publish only the concise text answer. ") +
        "Do not include credentials, private file contents, or raw tool output. Full-file sharing is unavailable; provide a suitable summary or verified source link. " +
        (canAsk
          ? "Use slack_bridge_ask for ordinary preferences or clarifications, then end this turn and wait for the owner's follow-up. Never use it for execution approval. "
          : "Structured questions require Zana. ") +
        "Execution permission requests stay in Zana. Follow-ups use Slack mentions in channels or messages in private agent chat.",
    };
  });
  zcc.cli.register({
    name: "slack-bridge-2ff2",
    summary: "Inspect the Zana for Slack connection and delivery log",
    commands: [
      {
        name: "status",
        summary: "Show connection and recent delivery states",
        usage: "zcc slack-bridge-2ff2 status",
      },
    ],
    async run(argv) {
      if (argv[0] !== "status")
        return { exitCode: 1, stderr: "Usage: zcc slack-bridge-2ff2 status" };
      const s = (await bridge.snapshot()) as any;
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          {
            connection: s.connection,
            embed: s.embed,
            home: s.home,
            homeLaunches: s.homeLaunches,
            tasks: s.bindings
              .filter((b: any) => !["deleted", "archived"].includes(b.state))
              .map((b: any) => ({
                threadId: b.threadId,
                state: b.state,
                muted: !!b.paused,
                slackUrl: b.slackUrl,
              })),
            owner: s.config.owner,
            channels: s.config.routes.map((r: any) => ({
              channel: r.channel,
              projectId: r.projectId,
              hostId: r.hostId,
              providerId: r.providerId,
              model: r.model,
              summaries: r.summaries,
            })),
            requests: s.requests.map((r: any) => ({
              id: r.id,
              state: r.state,
              note: r.note,
            })),
            deliveries: s.deliveries.map((d: any) => ({
              id: d.id,
              state: d.state,
              note: d.note,
            })),
          },
          null,
          2,
        ),
      };
    },
  });
  await bridge.init();
}
