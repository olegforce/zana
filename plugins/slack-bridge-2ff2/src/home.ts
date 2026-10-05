import { featureEnabled, accessMessage } from "./access.js";
import { createHash, randomUUID } from "node:crypto";
import {
  HOME_CALLBACK,
  LAUNCH_CALLBACK,
  homeView,
  launchView,
  queuedView,
  sameRoute,
  matchesRoute,
  ownsBinding,
  bindingRoute,
  destinationBlock,
  harnessBlock,
  modelBlock,
  validLaunch,
  pt,
  connectView,
} from "./home-view.js";
import {
  object,
  TIMESTAMP,
  CHANNEL,
  DIRECT,
  conversationKey,
  slackCall,
  type Config,
  type HomeLaunch,
  type Mention,
  type SlackAck,
  type SlackConnection,
} from "./model.js";
import type { Store } from "./store.js";

import {
  parseSlash,
  resolveSlashProject,
  slashReply,
  SLASH_HELP,
} from "./slash.js";

type HomeDeps = {
  store: Store;
  config(): Config;
  client(): SlackConnection | undefined;
  projects(): Promise<{ id: string; name: string }[]>;
  providers(): Promise<{ id: string; name: string }[]>;
  models(
    hostId: string,
    providerId: string,
  ): Promise<{ id: string; name: string }[]>;
  authorize(channel: string, source: string): Promise<boolean>;
  importProject?(projectId: string): Promise<unknown>;
  accept(m: Mention, ack: SlackAck): Promise<void>;
  enqueue(l: HomeLaunch): void;
  changed(): void;
  setupUrl?: string;
};
/** Home is a replaceable snapshot. Launch requests and channel posts remain durable. */
export class SlackHome {
  private dirty = true;
  private publishing = false;
  private nextPublish = 0;
  private project = "";
  private modelCache = new Map<
    string,
    { time: number; models: { id: string; name: string }[] }
  >();
  private modelLoads = new Map<
    string,
    Promise<{ id: string; name: string }[]>
  >();
  private loadModels(host: string, provider: string) {
    const key = JSON.stringify([host, provider]),
      cached = this.modelCache.get(key);
    if (cached && Date.now() - cached.time < 300000)
      return Promise.resolve(cached.models);
    const pending = this.modelLoads.get(key);
    if (pending) return pending;
    if (this.modelLoads.size >= 4)
      return Promise.reject(new Error("Model lookups busy"));
    const work = this.deps
      .models(host, provider)
      .then((models) => {
        const bounded = models.filter((m) => m.id.length <= 150).slice(0, 2000);
        if (this.modelCache.size >= 100)
          this.modelCache.delete(this.modelCache.keys().next().value!);
        this.modelCache.set(key, { time: Date.now(), models: bounded });
        return bounded;
      })
      .finally(() => this.modelLoads.delete(key));
    this.modelLoads.set(key, work);
    return work;
  }
  private providers: { id: string; name: string }[] = [];
  private projects: { id: string; name: string }[] = [];
  private viewToken = randomUUID();
  private viewId = "";
  private epoch = 0;
  private notice = "";
  lastPublished?: number;
  error = "";
  constructor(private deps: HomeDeps) {}
  changed() {
    this.dirty = true;
  }
  reset() {
    this.epoch++;
    this.viewToken = randomUUID();
    this.viewId = "";
    this.project = "";
    this.nextPublish = 0;
    this.notice = "";
    this.error = "";
    this.dirty = true;
  }
  private authorized(p: Record<string, any>, event = false) {
    const c = this.deps.config();
    return (
      !!c.enabled &&
      !!c.owner &&
      !!c.identity &&
      (event ? p.team_id : p.team?.id) === c.identity.team &&
      p.api_app_id === c.identity.app &&
      (event ? p.event?.user : p.user?.id) === c.owner
    );
  }
  deliveryRoute(id: string) {
    const l = this.deps.store.get("homeLaunch", id),
      c = this.deps.config();
    if (
      !l?.route ||
      !l.source ||
      l.state !== "queued" ||
      l.user !== c.owner ||
      l.ownerEpoch !== c.ownerEpoch ||
      l.team !== c.identity?.team ||
      l.app !== c.identity?.app ||
      !c.routes.some((r) => sameRoute(r, l.source!))
    )
      return undefined;
    return l.route;
  }
  conversation(channel: string, root: string) {
    const c = this.deps.config();
    const l = this.deps.store.get(
      "launchConversation",
      `${c.identity?.team}:${c.identity?.app}:${channel}:${root}`,
    );
    return l && validLaunch(c, l) ? l : undefined;
  }
  async offer(m: Mention, ack: SlackAck) {
    const c = this.deps.config();
    if (
      !c.enabled ||
      m.user !== c.owner ||
      m.team !== c.identity?.team ||
      m.app !== c.identity?.app ||
      !TIMESTAMP.test(m.ts) ||
      Math.abs(Date.now() - Number(m.ts) * 1000) > 300000 ||
      m.text.length > 2000 ||
      !featureEnabled(c, "launch")
    ) {
      await ack();
      return;
    }
    const id = `mention:${m.id}`;
    if (!this.deps.store.get("homeLaunch", id)) {
      const draft = this.prepareLaunch(
        id,
        m.text.replace(/^run\s+/i, ""),
        m.channel,
        m.root,
      );
      if (typeof draft !== "string")
        this.deps.store.put("homeLaunch", id, { ...draft, offer: "queued" });
    }
    await ack();
    this.deps.changed();
  }
  private modalDraft(p: Record<string, any>) {
    const d = this.deps.store.get(
      "homeLaunch",
      String(p.view?.private_metadata || ""),
    );
    return this.authorized(p) &&
      featureEnabled(this.deps.config(), "launch") &&
      p.view?.callback_id === LAUNCH_CALLBACK &&
      d?.state === "draft" &&
      d.expires >= Date.now() &&
      d.user === p.user.id &&
      d.team === p.team.id &&
      d.app === p.api_app_id &&
      d.ownerEpoch === this.deps.config().ownerEpoch &&
      d.viewId === p.view.id
      ? d
      : undefined;
  }
  async handle(p: Record<string, any>, ack: SlackAck): Promise<boolean> {
    if (p.type === "block_suggestion" && p.action_id === "launch_model") {
      const d = this.modalDraft(p),
        values = object(p.view?.state?.values);
      const project =
        values.project?.launch_project?.selected_option?.value ||
        d?.selection?.project;
      const channel =
        values[destinationBlock(project)]?.channel?.selected_option?.value ||
        d?.selection?.channel;
      const source =
        d?.routes.find(
          (r) => r.projectId === project && r.channel === channel,
        ) || d?.routes.find((r) => r.projectId === project);
      const provider =
        values[harnessBlock(project)]?.launch_harness?.selected_option?.value ||
        d?.selection?.provider ||
        source?.providerId;
      if (
        !d ||
        !source ||
        !d.providers?.some((x) => x.id === provider) ||
        p.block_id !== modelBlock(project, provider) ||
        !this.deps.config().routes.some((r) => sameRoute(r, source))
      ) {
        await ack({ options: [] });
        return true;
      }
      try {
        const models = (
          await boundedModels(() => this.loadModels(source.hostId, provider))
        )
          .filter((m) => m.id.length <= 150)
          .slice(0, 2000);
        const current = this.modalDraft(p);
        if (!current) {
          await ack({ options: [] });
          return true;
        }
        const query =
          typeof p.value === "string"
            ? p.value.slice(0, 150).toLowerCase()
            : "";
        const offered = models
          .filter((m) => m.name.toLowerCase().includes(query))
          .slice(0, 100);
        const key = catalogKey(project, provider);
        const allowed = [
          ...new Map(
            [...(current.catalog?.[key] || []), ...offered].map((m) => [
              m.id,
              { id: m.id, name: m.name.slice(0, 75) },
            ]),
          ).values(),
        ].slice(-500);
        this.deps.store.put("homeLaunch", d.id, {
          ...current,
          catalog: { [key]: allowed },
        });
        await ack({
          options: offered.map((m) => ({
            text: pt(m.name.slice(0, 75)),
            value: m.id,
          })),
        });
      } catch {
        await ack({ options: [] });
      }
      return true;
    }
    if (
      p.type === "block_actions" &&
      p.actions?.length === 1 &&
      p.actions[0]?.action_id === "launch_here"
    ) {
      await ack();
      const d = this.deps.store.get(
        "homeLaunch",
        String(p.actions[0].value || ""),
      );
      if (
        !this.authorized(p) ||
        !d ||
        d.state !== "draft" ||
        d.expires < Date.now() ||
        d.user !== p.user.id ||
        d.ownerEpoch !== this.deps.config().ownerEpoch ||
        d.team !== p.team.id ||
        d.app !== p.api_app_id ||
        d.offer !== "sent" ||
        d.offerTs !== p.container?.message_ts ||
        d.callerChannel !== p.container?.channel_id ||
        (p.message?.thread_ts || p.container.message_ts) !== d.replyRoot ||
        !p.trigger_id
      )
        return true;
      await this.openLaunch(
        p.trigger_id,
        d,
        d.routes.find((r) => r.channel === d.callerChannel)?.projectId || "",
        d.callerChannel!,
        () => this.authorized(p),
      );
      return true;
    }
    if (p.command === "/zana") return this.handleSlash(p, ack);
    if (p.type === "event_callback" && p.event?.type === "app_home_opened") {
      await ack();
      if (p.event.tab === "home" && this.authorized(p, true)) {
        this.dirty = true;
        await this.publish();
      }
      return true;
    }
    if (
      p.type === "view_submission" &&
      p.view?.callback_id === LAUNCH_CALLBACK
    ) {
      if (!this.authorized(p)) {
        await ack({ response_action: "clear" });
        return true;
      }
      const id = p.view.private_metadata;
      const draft =
        typeof id === "string" && id.length < 100
          ? this.deps.store.get("homeLaunch", id)
          : undefined;
      const error = async (block: string, text: string) =>
        ack({ response_action: "errors", errors: { [block]: text } });
      if (
        !draft ||
        draft.ownerEpoch !== this.deps.config().ownerEpoch ||
        draft.user !== p.user.id ||
        draft.team !== p.team.id ||
        draft.app !== p.api_app_id ||
        (draft.viewId && draft.viewId !== p.view.id)
      ) {
        await error(
          "task",
          "This form is no longer available. Close it and choose New agent again.",
        );
        return true;
      }
      if (!featureEnabled(this.deps.config(), "launch")) {
        await error("task", accessMessage);
        return true;
      }
      if (draft.state !== "draft") {
        await ack({
          response_action: "update",
          view: queuedView(draft.state !== "queued" ? draft.note : undefined),
        });
        return true;
      }
      if (draft.expires < Date.now()) {
        await error(
          "task",
          "This form expired. Close it and choose New agent again.",
        );
        return true;
      }
      const values = object(p.view.state?.values),
        project = values.project?.launch_project?.selected_option?.value;
      if (
        typeof project !== "string" ||
        !draft.routes.some((r) => r.projectId === project && r.model)
      ) {
        await error(
          "task",
          "Choose a connected Project. If this is an older form, close it and choose New agent again.",
        );
        return true;
      }
      const block = destinationBlock(project);
      const channel = values[block]?.channel?.selected_option?.value;
      const source =
        draft.routes.find(
          (r) => r.channel === channel && r.projectId === project,
        ) ||
        (channel === draft.callerChannel
          ? draft.routes.find((r) => r.projectId === project && r.model)
          : undefined);
      const provider =
        values[harnessBlock(project)]?.launch_harness?.selected_option?.value ||
        source?.providerId;
      const model =
        values[modelBlock(project, provider)]?.launch_model?.selected_option
          ?.value ||
        (provider === source?.providerId ? source?.model : undefined);
      const route = source
        ? {
            ...source,
            channel,
            sourceChannel:
              channel !== source.channel ? source.channel : undefined,
            providerId: provider,
            model,
          }
        : undefined;
      if (
        !route ||
        !route.model ||
        !source ||
        !this.deps.config().routes.some((r) => sameRoute(r, source))
      ) {
        await error(
          Array.isArray(p.view.blocks) &&
            p.view.blocks.some((b: any) => b.block_id === block)
            ? block
            : "project",
          "This destination changed. Close this form and choose New agent again.",
        );
        return true;
      }
      if (
        !draft.providers?.some((p) => p.id === provider) ||
        typeof model !== "string" ||
        (!(provider === source.providerId && model === source.model) &&
          !draft.catalog?.[catalogKey(project, provider)]?.some(
            (m) => m.id === model,
          ))
      ) {
        await error(
          modelBlock(project, provider),
          "Choose an available model for this harness.",
        );
        return true;
      }
      const task = values.task?.prompt?.value;
      if (typeof task !== "string" || !task.trim() || task.length > 2000) {
        await error("task", "Enter a task of 1–2000 characters.");
        return true;
      }
      if (
        this.deps.store.list("homeLaunch", ["queued", "needs-review"], 101)
          .length >= 100
      ) {
        await error(
          "task",
          "The request queue needs attention in Zana before more work can be accepted.",
        );
        return true;
      }
      // No network awaits between dedupe, validation, and the durable write.
      this.deps.store.put("homeLaunch", id, {
        ...draft,
        state: "queued",
        route,
        source,
        task: task.trim(),
        note: "Waiting to create a Slack conversation.",
      });
      this.dirty = true;
      this.deps.changed();
      await ack({ response_action: "update", view: queuedView() });
      return true;
    }
    if (
      p.type === "block_actions" &&
      Array.isArray(p.actions) &&
      p.actions.length === 1 &&
      ["launch_project", "launch_harness", "launch_connect"].includes(
        p.actions[0]?.action_id,
      )
    ) {
      await ack();
      const id = p.view?.private_metadata;
      const draft =
        typeof id === "string" && id.length < 100
          ? this.deps.store.get("homeLaunch", id)
          : undefined;
      const client = this.deps.client();
      if (
        !this.authorized(p) ||
        !featureEnabled(this.deps.config(), "launch") ||
        !client ||
        p.view?.type !== "modal" ||
        p.view.callback_id !== LAUNCH_CALLBACK ||
        !draft ||
        draft.ownerEpoch !== this.deps.config().ownerEpoch ||
        draft.state !== "draft" ||
        draft.expires < Date.now() ||
        draft.user !== p.user.id ||
        draft.team !== p.team.id ||
        draft.app !== p.api_app_id ||
        !draft.viewId ||
        draft.viewId !== p.view.id
      )
        return true;
      const a = object(p.actions[0]);
      if (a.action_id === "launch_connect") {
        await this.openSetup(p, true);
        return true;
      }
      const project =
        a.action_id === "launch_harness"
          ? p.view.state?.values?.project?.launch_project?.selected_option
              ?.value
          : a.selected_option?.value;
      const provider =
        a.action_id === "launch_harness" ? a.selected_option?.value : "";
      if (provider && !draft.providers?.some((x) => x.id === provider))
        return true;
      if (
        typeof project !== "string" ||
        typeof p.view.hash !== "string" ||
        p.view.hash.length > 100 ||
        !draft.routes.some(
          (r) =>
            r.projectId === project &&
            r.model &&
            this.deps.config().routes.some((current) => sameRoute(r, current)),
        )
      )
        return true;
      if (provider) {
        const source = draft.routes.find((r) => r.projectId === project);
        if (source)
          void this.loadModels(source.hostId, provider).catch(() => {});
      }
      const epoch = this.epoch;
      try {
        const view = launchView(
          draft,
          this.projects,
          project,
          p.view.state?.values?.[destinationBlock(project)]?.channel
            ?.selected_option?.value || "",
          provider,
        );
        const result = await client.call("views.update", {
          view_id: draft.viewId,
          hash: p.view.hash,
          view,
        });
        if (!result.ok) throw new Error("Modal update rejected");
        const current = this.modalDraft(p);
        if (current && epoch === this.epoch)
          this.deps.store.put("homeLaunch", draft.id, {
            ...current,
            selection: viewSelection(view),
          });
      } catch {
        if (epoch === this.epoch) {
          this.notice =
            "The Project picker could not update. Close the form and choose New agent again.";
          this.dirty = true;
        }
      }
      return true;
    }
    if (
      p.type !== "block_actions" ||
      !Array.isArray(p.actions) ||
      p.actions.length !== 1 ||
      !String(p.actions[0]?.action_id).startsWith("home_")
    )
      return false;
    const a = object(p.actions[0]);
    if (!this.authorized(p)) {
      await ack();
      return true;
    }
    if (
      p.view?.type !== "home" ||
      p.view.callback_id !== HOME_CALLBACK ||
      p.view.private_metadata !== this.viewToken ||
      p.view.id !== this.viewId ||
      !this.viewId
    ) {
      await ack();
      this.dirty = true;
      await this.publish();
      return true;
    }
    if (["home_stop", "home_mute", "home_unmute"].includes(a.action_id)) {
      const b =
        typeof a.value === "string" && a.value.length <= 300
          ? this.deps.store.get("binding", a.value)
          : undefined;
      if (
        b &&
        ownsBinding(this.deps.config(), b) &&
        !["archived", "deleted"].includes(b.state) &&
        !!bindingRoute(this.deps.config(), b) &&
        TIMESTAMP.test(a.action_ts)
      ) {
        await this.deps.accept(
          {
            id:
              "home-action:" +
              createHash("sha256")
                .update(`${b.key}:${a.action_id}:${a.action_ts}`)
                .digest("hex"),
            team: b.team,
            app: b.app,
            user: p.user.id,
            channel: b.channel,
            root: b.root,
            ts: a.action_ts,
            text: a.action_id.slice(5),
          },
          ack,
        );
      } else await ack();
      return true;
    }
    await ack();
    if (!this.authorized(p)) return true;
    if (a.action_id === "home_connect") {
      await this.openSetup(p);
    } else if (["home_new", "home_project_new"].includes(a.action_id)) {
      const c = this.deps.config(),
        client = this.deps.client();
      const project =
        a.action_id === "home_project_new" ? a.value : this.project;
      if (
        !client ||
        typeof p.trigger_id !== "string" ||
        p.trigger_id.length > 300 ||
        !c.routes.some((r) => r.model) ||
        (a.action_id === "home_project_new" &&
          !c.routes.some((r) => r.projectId === project && r.model))
      )
        return true;
      const draft = this.prepareLaunch();
      if (typeof draft === "string") {
        this.notice = draft;
        this.dirty = true;
        return true;
      }
      await this.openLaunch(p.trigger_id, draft, project, "", () =>
        this.authorized(p),
      );
    } else if (a.action_id === "home_project") {
      const selected = a.selected_option?.value;
      if (
        selected === "all" ||
        this.deps.config().routes.some((r) => r.projectId === selected)
      ) {
        this.project = selected === "all" ? "" : selected;
        this.dirty = true;
        await this.publish();
      }
    } else if (a.action_id === "home_refresh") {
      this.notice = "";
      this.dirty = true;
      await this.publish();
    }
    return true;
  }
  private slashAuthorized(p: Record<string, any>) {
    const c = this.deps.config();
    // Socket Mode authenticates the app connection. Some slash payloads omit api_app_id;
    // when present it must still match. This method is never an HTTP webhook verifier.
    return (
      !!c.enabled &&
      !!c.owner &&
      !!c.identity &&
      p.team_id === c.identity.team &&
      p.user_id === c.owner &&
      (p.api_app_id === undefined || p.api_app_id === c.identity.app)
    );
  }
  private async handleSlash(
    p: Record<string, any>,
    ack: SlackAck,
  ): Promise<boolean> {
    const c = this.deps.config();
    const reply = (text: string | string[]) => ack(slashReply(text, c));
    if (!this.slashAuthorized(p)) {
      await ack({
        response_type: "ephemeral",
        text: "Zana commands are available to the linked owner while Zana for Slack is connected.",
      });
      return true;
    }
    const command = parseSlash(p.text);
    if ("error" in command) {
      await reply(command.error);
      return true;
    }
    const feature = {
      run: "launch",
      projects: "projects",
      import: "imports",
      status: "status",
      help: undefined,
      connect: undefined,
    }[command.action] as
      "launch" | "projects" | "imports" | "status" | undefined;
    if (feature && !featureEnabled(c, feature)) {
      await reply(accessMessage);
      return true;
    }
    if (command.action === "help") {
      await reply(SLASH_HELP);
      return true;
    }
    if (command.action === "import") {
      if (
        !c.projectSync?.enabled ||
        !c.projectSync.allowSlackImport ||
        !this.deps.importProject
      ) {
        await reply(
          "Save import defaults and enable imports from Slack in Zana → Plugins → Zana for Slack first.",
        );
        return true;
      }
      if (!command.project) {
        await reply([
          'Available Projects — use /zana import "Project name" or its exact ID',
          ...this.projects
            .slice(0, 40)
            .map(
              (p) =>
                `${p.name} · ${p.id}${c.routes.some((r) => r.projectId === p.id) ? " · imported" : ""}`,
            ),
          ...(this.projects.length > 40
            ? [
                "More Projects are available in Zana for Slack settings or through Slackbot’s zana_list_projects.",
              ]
            : []),
        ]);
        return true;
      }
      const matches = this.projects.filter(
        (project) =>
          project.id === command.project ||
          project.name.toLowerCase() === command.project.toLowerCase(),
      );
      if (matches.length !== 1) {
        await reply(
          matches.length
            ? "That name is ambiguous. Use the exact Project ID from /zana import."
            : "No registered Project matches. Use /zana import for names and IDs.",
        );
        return true;
      }
      // ACK immediately; provisioning can exceed Slack's three-second deadline.
      await reply(
        "Import requested. Zana Home will show the result. No agent will be started.",
      );
      if (!this.slashAuthorized(p)) return true;
      const epoch = this.epoch;
      try {
        await this.deps.importProject(matches[0].id);
        if (epoch === this.epoch && this.slashAuthorized(p))
          this.notice = `Project import processed: ${matches[0].name}. Its channel appears below when ready.`;
      } catch (error) {
        if (epoch === this.epoch && this.slashAuthorized(p))
          this.notice =
            error instanceof Error
              ? error.message
              : "Import failed. Check Zana for Slack settings.";
      }
      if (epoch === this.epoch && this.slashAuthorized(p)) {
        this.dirty = true;
        await this.publish(true);
      }
      return true;
    }
    const name = (id: string) =>
      this.projects.find((project) => project.id === id)?.name.slice(0, 150) ||
      "Configured Project";
    if (command.action === "projects") {
      const ids = [...new Set(c.routes.map((r) => r.projectId))];
      await reply(
        ids.length
          ? [
              "Connected Projects",
              ...ids.map(
                (id) =>
                  `${name(id)} · ${id}\n${c.routes
                    .filter((r) => r.projectId === id)
                    .map((r) => `#${r.name}`)
                    .join(
                      " · ",
                    )}${c.routes.some((r) => r.projectId === id && r.model) ? "" : "\nChoose a model in Zana before launching."}`,
              ),
              "Use /zana run <project> <task>, or /zana run . <task> in a connected channel. Only connected Projects are listed.",
            ]
          : "No Projects connected yet. Use /zana connect to get started.",
      );
      return true;
    }
    let project = "";
    if (
      (command.action === "run" || command.action === "status") &&
      command.project
    ) {
      const result = resolveSlashProject(
        command.project,
        p.channel_id,
        c.routes,
        this.projects,
      );
      if ("error" in result) {
        await reply(result.error);
        return true;
      }
      project = result.project;
    }
    if (command.action === "status") {
      const routes = c.routes.filter(
        (r) => !project || r.projectId === project,
      );
      const bindings = this.deps.store
        .list("binding")
        .filter(
          (b) =>
            ownsBinding(c, b) &&
            !["archived", "deleted"].includes(b.state) &&
            !!bindingRoute(c, b) &&
            routes.some((r) =>
              b.launch
                ? sameRoute(b.launch.source, r)
                : matchesRoute(
                    { ...b, channel: b.sourceChannel || b.channel },
                    r,
                  ),
            ),
        );
      const attention = bindings.filter(
        (b) =>
          b.needsAttention ||
          ["failed", "needs-review", "unknown"].includes(b.state),
      );
      const running = bindings.filter(
        (b) =>
          !attention.includes(b) &&
          (b.active || ["running", "stopping"].includes(b.state)),
      );
      await reply([
        `${project ? name(project) : "Connected Projects"}: ${running.length} running · ${attention.length} need attention · ${bindings.length - running.length - attention.length} recent conversations`,
        "Zana received this command. Activity is the latest local snapshot, limited to 1,000 stored conversations. Open Home for tasks and Stop controls. Questions and permissions stay in Zana.",
      ]);
      return true;
    }
    if (
      !this.deps.client() ||
      typeof p.trigger_id !== "string" ||
      !p.trigger_id ||
      p.trigger_id.length > 300
    ) {
      await reply(
        "The form could not open. Try /zana again, or open Zana Home.",
      );
      return true;
    }
    if (command.action === "connect") {
      await reply(
        "Opening Project setup. If it does not open, go to Zana → Zana for Slack → Connect another Project on your machine.",
      );
      if (this.slashAuthorized(p)) await this.openSetup(p);
      return true;
    }
    if (
      !c.routes.some((r) => r.model && (!project || r.projectId === project))
    ) {
      await reply(
        "No launch-ready destination for this Project. Connect a Project and choose its model in Zana → Zana for Slack.",
      );
      return true;
    }
    if (!project)
      project =
        c.routes.find((r) => r.channel === p.channel_id && r.model)
          ?.projectId || "";
    // A deterministic durable draft consumes a retried trigger exactly once, including after restart.
    const id =
      "slash:" +
      createHash("sha256")
        .update(
          JSON.stringify([
            c.identity!.team,
            c.identity!.app,
            c.owner,
            p.trigger_id,
          ]),
        )
        .digest("hex");
    if (this.deps.store.get("homeLaunch", id)) {
      await reply(
        "This command was already received. Use the open launch form, or issue /zana again for a new form.",
      );
      return true;
    }
    const draft = this.prepareLaunch(
      id,
      command.task,
      CHANNEL.test(p.channel_id) || DIRECT.test(p.channel_id)
        ? p.channel_id
        : undefined,
    );
    if (typeof draft === "string") {
      await reply(draft);
      return true;
    }
    await reply(
      "Opening the launch form. Confirm the Project, conversation, harness and model, then choose Start agent. If it does not open, use /zana again or Zana → Home → New agent.",
    );
    if (this.slashAuthorized(p))
      await this.openLaunch(p.trigger_id, draft, project, p.channel_id, () =>
        this.slashAuthorized(p),
      );
    return true;
  }
  private prepareLaunch(
    id = randomUUID() as string,
    task = "",
    callerChannel?: string,
    replyRoot?: string,
  ): HomeLaunch | string {
    if (!featureEnabled(this.deps.config(), "launch")) return accessMessage;
    if (
      this.deps.store.list("homeLaunch", ["draft"], 51).length >= 50 ||
      this.deps.store.list("homeLaunch", undefined, 1001).length >= 1000
    )
      return "Too many saved launch forms. Close unused forms and try again later.";
    const c = this.deps.config();
    const draft: HomeLaunch = {
      id,
      ownerEpoch: c.ownerEpoch,
      callerChannel,
      replyRoot,
      providers: (this.providers.length
        ? this.providers
        : [...new Set(c.routes.map((r) => r.providerId))].map((id) => ({
            id,
            name: id,
          }))
      ).slice(0, 100),
      team: c.identity!.team,
      app: c.identity!.app,
      user: c.owner!,
      state: "draft",
      routes: c.routes.map((r) => ({ ...r })),
      created: Date.now(),
      expires: Date.now() + 15 * 60000,
      task,
      note: "",
    };
    this.deps.store.put("homeLaunch", draft.id, draft);
    return draft;
  }
  private async openLaunch(
    trigger: string,
    draft: HomeLaunch,
    project: string,
    channel: string,
    authorized: () => boolean,
  ) {
    const client = this.deps.client(),
      epoch = this.epoch;
    if (
      !client ||
      !authorized() ||
      !featureEnabled(this.deps.config(), "launch")
    )
      return;
    try {
      const source =
        draft.routes.find((r) => r.projectId === project) ||
        (new Set(draft.routes.map((r) => r.projectId)).size === 1
          ? draft.routes[0]
          : undefined);
      if (source)
        void this.loadModels(source.hostId, source.providerId).catch(() => {});
      const view = launchView(draft, this.projects, project, channel);
      const result = await client.call("views.open", {
        trigger_id: trigger,
        view,
      });
      if (!result.ok || typeof result.view?.id !== "string")
        throw new Error("Modal rejected");
      if (epoch === this.epoch && authorized()) {
        const current = this.deps.store.get("homeLaunch", draft.id);
        if (current?.state === "draft")
          this.deps.store.put("homeLaunch", draft.id, {
            ...current,
            viewId: result.view.id,
            selection: viewSelection(view),
          });
      }
    } catch {
      if (epoch === this.epoch) {
        this.notice =
          "The launch form could not open. Choose New agent to try again.";
        this.dirty = true;
      }
    }
  }
  private async openSetup(p: Record<string, any>, push = false) {
    const client = this.deps.client(),
      epoch = this.epoch;
    if (
      !client ||
      typeof p.trigger_id !== "string" ||
      p.trigger_id.length > 300
    )
      return;
    try {
      const result = await client.call(push ? "views.push" : "views.open", {
        trigger_id: p.trigger_id,
        view: connectView(this.deps.setupUrl),
      });
      if (!result.ok) throw new Error("Setup unavailable");
    } catch {
      if (epoch === this.epoch) {
        this.notice =
          "Open Zana → Zana for Slack → Connect another Project on your machine to connect a Project.";
        this.dirty = true;
      }
    }
  }
  async publish(force = false) {
    const client = this.deps.client(),
      c = this.deps.config(),
      epoch = this.epoch;
    if (
      !client ||
      !c.enabled ||
      !c.owner ||
      !c.identity ||
      this.publishing ||
      (!force && (!this.dirty || Date.now() < this.nextPublish))
    )
      return;
    this.publishing = true;
    this.dirty = false;
    this.nextPublish = Date.now() + 5000;
    try {
      [this.projects, this.providers] = await Promise.all([
        this.deps.projects(),
        this.deps.providers(),
      ]);
      if (
        epoch !== this.epoch ||
        !this.deps.config().enabled ||
        this.deps.config().owner !== c.owner
      )
        return;
      if (this.project && !c.routes.some((r) => r.projectId === this.project))
        this.project = "";
      const result = await client.call("views.publish", {
        user_id: c.owner,
        view: homeView({
          config: c,
          projects: this.projects,
          project: this.project,
          token: this.viewToken,
          notice: this.notice,
          bindings: this.deps.store.list("binding"),
          deliveries: this.deps.store.list("delivery"),
          launches: this.deps.store.list("homeLaunch", undefined, 100),
          requests: this.deps.store.list("receipt", undefined, 100),
          canvases: this.deps.store.canvasLinks(),
          questions: this.deps.store.list("question", ["waiting"], 100),
        }),
      });
      if (!result.ok || typeof result.view?.id !== "string")
        throw new Error("Home not available");
      if (epoch !== this.epoch) return;
      this.viewId = result.view.id;
      this.lastPublished = Date.now();
      this.error = "";
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.error =
        "Home could not update. Enable the Home tab and app_home_opened event in the Slack app settings, then refresh.";
      const retry = Number(object(error).retryAfter);
      this.nextPublish =
        Date.now() +
        Math.max(
          30000,
          Math.min(300000, Number.isFinite(retry) ? retry * 1000 : 0),
        );
      this.dirty = true;
    } finally {
      this.publishing = false;
    }
  }
  dismiss(id: string) {
    const launch = this.deps.store.get("homeLaunch", id);
    if (!launch || !["rejected", "needs-review"].includes(launch.state))
      throw new Error("No Home request to review.");
    const delivery = this.deps.store.get("delivery", `home-root:${id}`);
    this.deps.store.transaction(() => {
      if (delivery?.state === "uncertain")
        this.deps.store.put("delivery", delivery.id, {
          ...delivery,
          state: "reviewed",
          note: "Reviewed from Home request diagnostics. No retry was sent.",
        });
      this.deps.store.put("homeLaunch", id, {
        ...launch,
        state: "settled",
        note: "Reviewed locally. No agent was launched or message retried.",
      });
    });
    this.deps.changed();
    this.dirty = true;
  }
  async tick() {
    const c = this.deps.config();
    if (!c.enabled || !c.identity || !c.owner) return;
    for (const d of this.deps.store.list("homeLaunch", ["draft"], 50)) {
      if (d.offer !== "queued") continue;
      const source = c.routes.find((r) => r.model);
      if (
        !source ||
        d.user !== c.owner ||
        d.team !== c.identity.team ||
        d.app !== c.identity.app ||
        d.ownerEpoch !== c.ownerEpoch ||
        d.expires < Date.now() ||
        !featureEnabled(c, "launch") ||
        !d.callerChannel ||
        !(await this.deps.authorize(d.callerChannel, source.channel))
      ) {
        this.deps.store.put("homeLaunch", d.id, { ...d, offer: "failed" });
        continue;
      }
      if (
        this.deps.config().owner !== d.user ||
        this.deps.config().ownerEpoch !== d.ownerEpoch ||
        !this.deps.config().enabled ||
        !featureEnabled(this.deps.config(), "launch") ||
        !this.deps.config().routes.some((r) => sameRoute(r, source))
      )
        continue;
      this.deps.store.put("homeLaunch", d.id, { ...d, offer: "sending" });
      try {
        const result = await slackCall(
          this.deps.client()!,
          "chat.postMessage",
          {
            channel: d.callerChannel,
            thread_ts: d.replyRoot,
            text: "Choose a Project, harness and model to start this task here.",
            blocks: [
              {
                type: "section",
                text: pt(
                  "Choose a Project, harness and model to start this task here.",
                ),
              },
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: pt("Start with Zana"),
                    action_id: "launch_here",
                    value: d.id,
                  },
                ],
              },
            ],
            mrkdwn: false,
            parse: "none",
            unfurl_links: false,
            unfurl_media: false,
          },
        );
        const current = this.deps.store.get("homeLaunch", d.id)!;
        this.deps.store.put("homeLaunch", d.id, {
          ...current,
          offer:
            result.ok &&
            result.channel === d.callerChannel &&
            TIMESTAMP.test(result.ts)
              ? "sent"
              : result.ok
                ? "uncertain"
                : "failed",
          offerTs: result.ts,
        });
      } catch {
        this.deps.store.put("homeLaunch", d.id, {
          ...this.deps.store.get("homeLaunch", d.id)!,
          offer: "uncertain",
        });
      }
    }
    for (const l of this.deps.store.list("homeLaunch", ["queued"], 20)) {
      if (!featureEnabled(c, "launch")) {
        this.deps.store.put("homeLaunch", l.id, {
          ...l,
          state: "rejected",
          note: accessMessage,
        });
        this.dirty = true;
        continue;
      }
      const delivery = this.deps.store.get("delivery", `home-root:${l.id}`);
      if (
        l.team !== c.identity.team ||
        l.app !== c.identity.app ||
        l.user !== c.owner ||
        !l.route ||
        !l.source ||
        l.ownerEpoch !== c.ownerEpoch ||
        !c.routes.some((r) => sameRoute(r, l.source!)) ||
        Date.now() - l.created > 30 * 60000
      ) {
        this.deps.store.put("homeLaunch", l.id, {
          ...l,
          state: "rejected",
          note: "Destination changed or request expired. Create a fresh request from Home.",
        });
        this.dirty = true;
        continue;
      }
      if (!delivery) {
        try {
          this.deps.enqueue(l);
        } catch {
          this.deps.store.put("homeLaunch", l.id, {
            ...l,
            state: "rejected",
            note: "Delivery queue is full. Review it in Zana.",
          });
        }
        this.dirty = true;
      } else if (["uncertain", "reviewed", "failed"].includes(delivery.state)) {
        this.deps.store.put("homeLaunch", l.id, {
          ...l,
          state: "needs-review",
          note: "Conversation delivery was not confirmed. Inspect Slack and the delivery log in Zana before making a new request. No agent was launched.",
        });
        this.dirty = true;
      } else if (delivery.state === "sent" && delivery.ts) {
        const root = l.replyRoot || delivery.ts;
        this.deps.store.transaction(() => {
          const key = `${l.team}:${l.app}:${l.route!.channel}:${root}`;
          this.deps.store.put("launchConversation", key, {
            id: key,
            state: "ready",
            team: l.team,
            app: l.app,
            user: l.user,
            ownerEpoch: l.ownerEpoch,
            source: l.source!,
            route: l.route!,
          });
          this.deps.store.insert({
            id: `home:${l.id}`,
            team: l.team,
            app: l.app,
            user: l.user,
            channel: l.route!.channel,
            root,
            ts: root,
            text: `run ${l.task}`,
            requestedRoute: l.route,
            key: `${l.team}:${l.app}:${l.route!.channel}:${root}`,
            state: "received",
            created: Date.now(),
            note: "Submitted from the Slack launch form.",
          });
          this.deps.store.put("homeLaunch", l.id, {
            ...l,
            state: "settled",
            note: "Conversation created. Request saved for admission.",
          });
        });
        this.deps.changed();
        this.dirty = true;
      }
    }
    // Coalesces lifecycle bursts; at most one owner view every five seconds.
    await this.publish();
  }
}

const catalogKey = (project: string, provider: string) =>
  JSON.stringify([project, provider]);

async function boundedModels(
  work: () => Promise<{ id: string; name: string }[]>,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Model lookup timed out")),
          1100,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function viewSelection(view: ReturnType<typeof launchView>) {
  const initial = (action: string) =>
    view.blocks
      .map((b) => object(b).element)
      .find((e) => e?.action_id === action)?.initial_option?.value || "";
  return {
    project: initial("launch_project"),
    provider: initial("launch_harness"),
    channel: initial("channel"),
  };
}
