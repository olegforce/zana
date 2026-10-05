import {
  accessMessage,
  featureEnabled,
  toolEnabled,
  accessView,
  slackFeatures,
} from "./access.js";
import { object, CHANNEL, slackLink, type HomeLaunch } from "./model.js";
import { ownsBinding, sameRoute, validLaunch } from "./home-view.js";
import type { SlackCapabilities } from "./capabilities.js";
import type { Bridge } from "./bridge.js";

const fail = (error: string, message: string) => ({
  isError: true,
  error,
  message,
});
const id = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown, max: number) =>
  typeof v === "string" && !!v.trim() && v.length <= max;

/** Only the signed Connect transport calls this adapter. Admission and spawning stay in Bridge. */
export class SlackbotJobs {
  constructor(
    private bridge: Bridge,
    private capabilities?: SlackCapabilities,
  ) {}
  private allowed(p: Record<string, any>) {
    const c = this.bridge.config;
    return (
      c.enabled &&
      this.bridge.connection === "Connected" &&
      !!c.owner &&
      !!c.identity &&
      p.team === c.identity.team &&
      p.app === c.identity.app &&
      p.user === c.owner
    );
  }
  async handle(input: unknown): Promise<Record<string, unknown>> {
    const p = object(input),
      a = object(p.arguments),
      b = this.bridge;
    const ownerEpoch = b.config.ownerEpoch;
    const authorized = () =>
      this.allowed(p) && b.config.ownerEpoch === ownerEpoch;
    if (!authorized())
      return fail(
        "not_authorized",
        "Reconnect Zana for Slack with its verified owner in Zana.",
      );
    if (!slackFeatures.some((f) => f.tools.includes(p.name)))
      return fail("unknown_tool", "Unknown Slackbot tool.");
    if (!toolEnabled(b.config, p.name))
      return fail("functionality_disabled", accessMessage);
    if (p.name === "zana_list_capabilities") {
      if (Object.keys(a).length)
        return fail("invalid_arguments", "This tool takes no arguments.");
      return {
        capabilities: this.capabilities?.list() || [],
        functionalities: accessView(b.config).filter((f) => f.enabled),
      };
    }
    if (p.name === "zana_run_capability") {
      if (
        Object.keys(a).some(
          (k) => !["capability_id", "arguments_json"].includes(k),
        )
      )
        return fail(
          "invalid_arguments",
          "Use only the capability ID and JSON arguments.",
        );
      return this.capabilities
        ? this.capabilities.run(
            a.capability_id,
            a.arguments_json,
            () => authorized() && toolEnabled(b.config, p.name),
          )
        : fail("capability_unavailable", "No plugin capability is available.");
    }
    if (p.name === "zana_import_project") {
      if (
        !text(a.project_id, 100) ||
        Object.keys(a).some((k) => k !== "project_id")
      )
        return fail(
          "invalid_arguments",
          "Choose one exact registered Project ID.",
        );
      try {
        await b.importProjects({ projectIds: [a.project_id] }, true);
        if (!authorized() || !toolEnabled(b.config, p.name))
          return fail(
            "not_authorized",
            "The connection or functionality changed. Check Zana.",
          );
        const destination = b.config.routes.find(
          (r) =>
            r.projectId === a.project_id &&
            b.config.projectSync?.channels?.some(
              (c) => c.channel === r.channel,
            ),
        );
        return {
          project_id: a.project_id,
          state: destination ? "imported" : "pending",
          ...(destination
            ? {
                channel_id: destination.channel,
                channel_name: destination.name,
              }
            : {}),
          message:
            "No job was launched. Check zana_list_projects for approved destinations.",
        };
      } catch (error) {
        return fail(
          "import_unavailable",
          error instanceof Error
            ? error.message
            : "Check import settings in Zana.",
        );
      }
    }
    if (p.name === "zana_list_projects") {
      if (Object.keys(a).length)
        return fail("invalid_arguments", "This tool takes no arguments.");
      const projects = await b.zcc.sdk.projects.list();
      if (!authorized() || !toolEnabled(b.config, p.name))
        return fail(
          "not_authorized",
          "The connection or functionality changed. Check Zana.",
        );
      return {
        imports_enabled:
          !!b.config.projectSync?.enabled &&
          !!b.config.projectSync?.allowSlackImport,
        truncated: projects.length > 250,
        projects: projects.slice(0, 250).map((project) => ({
          project_id: project.id,
          name: project.name,
          imported: b.config.routes.some(
            (r) => r.projectId === project.id && r.model,
          ),
          destinations: b.config.routes
            .filter((r) => r.projectId === project.id && r.model)
            .slice(0, 250)
            .map((r) => ({
              channel_id: r.channel,
              channel_name: r.name,
              provider: r.providerId,
              model: r.model,
              shares_answers: r.summaries,
            })),
        })),
      };
    }
    if (p.name === "zana_launch_options") {
      if (
        !text(a.project_id, 100) ||
        (a.channel_id !== undefined && !CHANNEL.test(a.channel_id)) ||
        (a.harness !== undefined && !text(a.harness, 100)) ||
        Object.keys(a).some(
          (k) => !["project_id", "channel_id", "harness"].includes(k),
        )
      )
        return fail(
          "invalid_arguments",
          "Choose an exact connected Project and optional destination/harness.",
        );
      const sources = b.config.routes.filter(
        (r) =>
          r.projectId === a.project_id &&
          r.model &&
          (!a.channel_id || r.channel === a.channel_id),
      );
      if (!sources.length)
        return fail(
          "destination_unavailable",
          "Connect this Project in Zana first.",
        );
      if (sources.length > 1 && !a.channel_id)
        return fail(
          "destination_required",
          "Choose an exact connected channel from zana_list_projects.",
        );
      const source = { ...sources[0] };
      try {
        const harnesses = (await b.zcc.sdk.providers.list())
          .filter((h) => h.available)
          .slice(0, 100)
          .map((h) => ({ id: h.id, name: h.displayName || h.id }));
        if (a.harness && !harnesses.some((h) => h.id === a.harness))
          return fail("profile_unavailable", "Choose an available harness ID.");
        const models = a.harness
          ? (await b.models({ hostId: source.hostId, providerId: a.harness }))
              .filter((m) => m.id.length <= 150)
              .slice(0, 2000)
          : undefined;
        if (
          !authorized() ||
          !toolEnabled(b.config, p.name) ||
          !b.config.routes.some((r) => sameRoute(r, source))
        )
          return fail(
            "not_authorized",
            "The Project connection changed. Check Zana.",
          );
        return {
          project_id: source.projectId,
          channel_id: source.channel,
          default_harness: source.providerId,
          default_model: source.model,
          harnesses,
          ...(models ? { harness: a.harness, models } : {}),
        };
      } catch {
        return fail(
          "profile_unavailable",
          "Could not load available models from the Project machine. Check Zana.",
        );
      }
    }
    if (p.name === "zana_job_status") {
      if (!id(a.job_id) || Object.keys(a).some((k) => k !== "job_id"))
        return fail(
          "invalid_arguments",
          "Use the job_id returned when the job was launched.",
        );
      return this.status(a.job_id);
    }
    if (p.name !== "zana_launch_job")
      return fail("unknown_tool", "Unknown Slackbot tool.");
    if (
      !id(p.requestId) ||
      !text(a.project_id, 100) ||
      !CHANNEL.test(a.channel_id ?? "") ||
      !text(a.task, 2000) ||
      (a.harness !== undefined && !text(a.harness, 100)) ||
      (a.model !== undefined && !text(a.model, 150)) ||
      typeof a.request_id !== "string" ||
      !/^[A-Za-z0-9_-]{8,80}$/.test(a.request_id) ||
      Object.keys(a).some(
        (k) =>
          ![
            "project_id",
            "channel_id",
            "task",
            "request_id",
            "harness",
            "model",
          ].includes(k),
      )
    )
      return fail(
        "invalid_arguments",
        "Choose a connected Project/channel, a task of 1–2000 characters and a stable request_id.",
      );
    const configuredRoute = b.config.routes.find(
      (r) =>
        r.projectId === a.project_id && r.channel === a.channel_id && r.model,
    );
    if (!configuredRoute)
      return fail(
        "destination_unavailable",
        "This Project/channel has no approved model. Configure it in Zana for Slack.",
      );
    const source = { ...configuredRoute };
    if (a.harness && a.harness !== source.providerId && !a.model)
      return fail(
        "invalid_arguments",
        "Choose a model for the requested harness using zana_launch_options.",
      );
    const route = {
      ...source,
      providerId: a.harness || source.providerId,
      model: a.model || source.model,
    };
    const launchId = `mcp:${p.requestId}`;
    const old = b.store.get("homeLaunch", launchId);
    if (old) {
      if (
        old.task !== a.task.trim() ||
        !old.route ||
        !sameRoute(old.route, route) ||
        (old.source && !sameRoute(old.source, source)) ||
        old.user !== p.user ||
        old.team !== p.team ||
        old.app !== p.app
      )
        return fail(
          "request_conflict",
          "This request_id already belongs to another task or destination.",
        );
      return this.status(p.requestId);
    }
    if (a.harness || a.model) {
      try {
        const models = await b.models({
          hostId: source.hostId,
          providerId: route.providerId,
        });
        if (!models.some((m) => m.id === route.model))
          return fail(
            "profile_unavailable",
            "Choose an available model using zana_launch_options.",
          );
      } catch {
        return fail(
          "profile_unavailable",
          "The requested harness/model is unavailable on the Project machine.",
        );
      }
      if (
        !authorized() ||
        !toolEnabled(b.config, p.name) ||
        !b.config.routes.some((r) => sameRoute(r, source))
      )
        return fail(
          "not_authorized",
          "The Project connection changed. Check Zana.",
        );
      // A concurrent retry can finish while the model lookup is in flight.
      if (b.store.get("homeLaunch", launchId)) return this.handle(input);
    }
    if (
      b.store.list("homeLaunch", ["queued", "needs-review"], 101).length >=
        100 ||
      b.store.list("homeLaunch", undefined, 1001).length >= 1000
    )
      return fail(
        "queue_full",
        "Review the saved requests in Zana for Slack before launching more work.",
      );
    // Synchronous dedupe + durable admission: no await can admit the same job twice.
    const launch: HomeLaunch = {
      id: launchId,
      ownerEpoch: b.config.ownerEpoch,
      source: { ...source },
      team: p.team,
      app: p.app,
      user: p.user,
      state: "queued",
      created: Date.now(),
      expires: Date.now() + 30 * 60000,
      routes: [{ ...source }],
      route: { ...route },
      task: a.task.trim(),
      note: "Requested through Slackbot. Waiting to create a Slack conversation.",
    };
    b.store.put("homeLaunch", launchId, launch);
    b.changed();
    return this.status(p.requestId);
  }
  private status(jobId: string): Record<string, unknown> {
    const b = this.bridge,
      launch = b.store.get("homeLaunch", `mcp:${jobId}`),
      c = b.config;
    if (
      !launch ||
      launch.user !== c.owner ||
      launch.team !== c.identity?.team ||
      launch.app !== c.identity?.app
    )
      return fail(
        "job_not_found",
        "No retained Slackbot job with this ID belongs to the current owner.",
      );
    if (
      !launch.route ||
      !validLaunch(c, {
        ...launch,
        state: "ready",
        source: launch.source || launch.route,
        route: launch.route,
      })
    )
      return fail(
        "destination_unavailable",
        "This job's Project/channel mapping changed. Inspect it in Zana.",
      );
    const receipt = b.store.get("receipt", `home:${launch.id}`);
    const binding = receipt ? b.store.get("binding", receipt.key) : undefined;
    if (binding && !ownsBinding(c, binding))
      return fail(
        "destination_unavailable",
        "This job belongs to an unlinked connection. Open its history in Zana.",
      );
    const answer =
      binding && featureEnabled(c, "answers")
        ? b.store.sharedAnswer(binding.key, launch.route.summaries)
        : undefined;
    const delivery = b.store.get("delivery", `home-root:${launch.id}`);
    const state =
      binding?.state ??
      receipt?.state ??
      (launch.state === "settled" ? "needs-review" : launch.state);
    return {
      job_id: jobId,
      state,
      project_id: launch.route.projectId,
      harness: launch.route.providerId,
      model: launch.route.model,
      channel_id: launch.route.channel,
      note: receipt?.note || launch.note,
      needs_attention: !!binding?.needsAttention,
      ...(delivery?.state === "sent" && delivery.ts
        ? {
            conversation_url: slackLink(
              launch.team,
              launch.route.channel,
              delivery.ts,
            ),
          }
        : {}),
      ...(answer ? { shared_answer: answer.text } : {}),
      ...(binding?.needsAttention
        ? {
            action_required:
              "Open Zana to handle the pending permission or question.",
          }
        : {}),
    };
  }
}
