import { featureEnabled } from "./access.js";
import { localThreadLink } from "./host.js";
import type { CanvasExport, SlackQuestion } from "./slack-forms.js";
import {
  slackLink,
  plainSlack,
  type Binding,
  type Config,
  type Delivery,
  type HomeLaunch,
  type Receipt,
  type Route,
  type LaunchConversation,
} from "./model.js";

export const HOME_CALLBACK = "zana_home_v1";
export const LAUNCH_CALLBACK = "zana_launch_v1";
export const pt = (text: string) => ({ type: "plain_text", text });
export const section = (text: string) => ({ type: "section", text: pt(text) });
const context = (text: string) => ({ type: "context", elements: [pt(text)] });
const button = (text: string, action_id: string, value?: string) => ({
  type: "button",
  text: pt(text),
  action_id,
  ...(value ? { value } : {}),
});
export const matchesRoute = (
  b: Pick<Binding, "channel" | "projectId" | "hostId" | "providerId">,
  r: Route,
) =>
  b.channel === r.channel &&
  b.projectId === r.projectId &&
  b.hostId === r.hostId &&
  b.providerId === r.providerId;
/** Old records remain local history; restoring a route never restores revoked access. */
export const ownsBinding = (c: Config, b: Binding) =>
  c.ownerEpoch === b.ownerEpoch &&
  c.identity?.team === b.team &&
  c.identity?.app === b.app;
export const validLaunch = (c: Config, l: LaunchConversation) =>
  c.enabled &&
  c.owner === l.user &&
  c.ownerEpoch === l.ownerEpoch &&
  c.identity?.team === l.team &&
  c.identity?.app === l.app &&
  c.routes.some((r) => sameRoute(r, l.source)) &&
  l.route.projectId === l.source.projectId &&
  l.route.hostId === l.source.hostId;
export const bindingRoute = (c: Config, b: Binding) => {
  if (!ownsBinding(c, b)) return undefined;
  if (b.launch)
    return validLaunch(c, b.launch) && matchesRoute(b, b.launch.route)
      ? b.launch.route
      : undefined;
  return !b.sourceChannel || c.agentChatEnabled === true
    ? c.routes.find((r) =>
        matchesRoute({ ...b, channel: b.sourceChannel || b.channel }, r),
      )
    : undefined;
};
export const sameRoute = (a: Route, b: Route) =>
  matchesRoute(a, b) &&
  a.sourceChannel === b.sourceChannel &&
  a.model === b.model &&
  a.summaries === b.summaries;
export const homeLink = (config: Config) =>
  config.identity
    ? `slack://app?team=${encodeURIComponent(config.identity.team)}&id=${encodeURIComponent(config.identity.app)}&tab=home`
    : undefined;

export function homeView(input: {
  config: Config;
  bindings: Binding[];
  deliveries: Delivery[];
  launches: HomeLaunch[];
  requests?: Receipt[];
  canvases?: Pick<
    CanvasExport,
    "id" | "key" | "state" | "ownerEpoch" | "route" | "url"
  >[];
  questions?: SlackQuestion[];
  projects: { id: string; name: string }[];
  project: string;
  token: string;
  notice?: string;
}) {
  const { config, projects, project, token } = input;
  const showProjects = featureEnabled(config, "projects"),
    showStatus = featureEnabled(config, "status"),
    canLaunch = featureEnabled(config, "launch");
  const name = (id: string) =>
    projects.find((p) => p.id === id)?.name || "Configured Project";
  const routes = config.routes.filter(
    (r) => !project || r.projectId === project,
  );
  const all = input.bindings.filter(
    (b) =>
      ownsBinding(config, b) &&
      !["archived", "deleted"].includes(b.state) &&
      !!bindingRoute(config, b) &&
      routes.some((r) =>
        b.launch
          ? sameRoute(b.launch.source, r)
          : matchesRoute({ ...b, channel: b.sourceChannel || b.channel }, r),
      ),
  );
  const hasQuestion = (b: Binding) =>
    config.questionsEnabled === true &&
    (input.questions || []).some(
      (q) =>
        q.key === b.key &&
        q.state === "waiting" &&
        q.requestId === b.lastRequest &&
        q.ownerEpoch === config.ownerEpoch &&
        q.expires > Date.now(),
    );
  const attention = all.filter(
    (b) =>
      b.needsAttention ||
      hasQuestion(b) ||
      ["failed", "needs-review", "unknown"].includes(b.state),
  );
  const running = all.filter(
    (b) =>
      !attention.includes(b) &&
      (b.active || ["running", "stopping"].includes(b.state)),
  );
  const recent = all.filter(
    (b) => !attention.includes(b) && !running.includes(b),
  );
  const blocks: Record<string, any>[] = [
    { type: "header", text: pt("Zana · Your agents") },
    context(
      `${config.workspaceName || "Your Slack workspace"} · Private dashboard for ${config.ownerName || "the linked owner"}`,
    ),
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: !showStatus
          ? "Job progress is disabled in Zana for Slack. Conversation controls remain available."
          : `🟢 *${running.length} running*    ·    🟠 *${attention.length} need attention*    ·    ✓ *${recent.length} recent*`,
      },
    },
    {
      type: "actions",
      elements: [
        ...(canLaunch && config.routes.some((r) => r.model)
          ? [{ ...button("＋ New agent", "home_new"), style: "primary" }]
          : []),
        button("Refresh", "home_refresh"),
      ],
    },
  ];
  const options = [
    { text: pt("All Projects"), value: "all" },
    ...[...new Set(config.routes.map((r) => r.projectId))].map((id) => ({
      text: pt(name(id).slice(0, 75)),
      value: id,
    })),
  ];
  if (showProjects && options.length > 2)
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "static_select",
          action_id: "home_project",
          placeholder: pt("Choose a Project"),
          options,
          initial_option:
            options.find((o) => o.value === project) || options[0],
        },
      ],
    });
  if (input.notice) blocks.push(section(input.notice));
  if (showProjects)
    blocks.push({ type: "divider" }, { type: "header", text: pt("Projects") });
  const projectIds = showProjects
    ? [...new Set(routes.map((r) => r.projectId))]
    : [];
  for (const id of projectIds.slice(0, 8)) {
    const connected = routes.filter((r) => r.projectId === id);
    blocks.push({
      ...section(
        `${name(id).slice(0, 150)}\n${connected
          .map((r) => `#${r.name}`)
          .join(" · ")
          .slice(
            0,
            2000,
          )}${connected.some((r) => r.model) ? "" : "\nChoose a model in Zana to start agents."}`,
      ),
      ...(canLaunch && connected.some((r) => r.model)
        ? { accessory: button("New agent", "home_project_new", id) }
        : {}),
    });
  }
  if (projectIds.length > 8)
    blocks.push(
      context(
        `Showing 8 of ${projectIds.length} Projects. Use the Project filter above to see another Project.`,
      ),
    );
  if (!routes.length)
    blocks.push(
      section(
        "No Projects connected yet. Connect a Project to a Slack channel to start agents here.",
      ),
    );
  blocks.push(
    {
      type: "actions",
      elements: [button("Connect another Project", "home_connect")],
    },
    context(
      showProjects
        ? "Only connected Projects appear here. Your other Projects stay in Zana until you connect them."
        : "Project browsing is disabled in Zana for Slack.",
    ),
  );
  const pending = input.launches
    .filter(
      (l) =>
        l.user === config.owner &&
        l.team === config.identity?.team &&
        l.app === config.identity?.app &&
        l.route &&
        routes.some((r) => sameRoute(r, l.route!)) &&
        l.state !== "draft" &&
        l.state !== "settled",
    )
    .slice(0, 4);
  for (const l of showStatus ? pending : [])
    blocks.push(
      section(
        `${l.state === "queued" ? "⏳ Request queued" : "⚠ Request needs attention"} · ${l.task.slice(0, 100)}\n${l.note || "Preparing a conversation in the selected channel."}`,
      ),
    );
  const requests = (input.requests || [])
    .filter(
      (r) =>
        r.team === config.identity?.team &&
        r.app === config.identity?.app &&
        r.user === config.owner &&
        routes.some((route) => route.channel === r.channel) &&
        !all.some((b) => b.key === r.key) &&
        [
          "received",
          "queued",
          "dispatching",
          "needs-review",
          "rejected",
        ].includes(r.state),
    )
    .slice(0, 4);
  for (const r of showStatus ? requests : [])
    blocks.push(
      section(
        `${r.state === "needs-review" || r.state === "rejected" ? "⚠" : "⏳"} ${r.command?.slice(0, 100) || "Request from Slack"}\n${r.note || "Request received."}`,
      ),
      {
        type: "actions",
        elements: [
          {
            ...button("Open request", "home_conversation"),
            url: slackLink(r.team, r.channel, r.root),
          },
        ],
      },
    );
  for (const [title, items] of [
    ["Conversation controls", showStatus ? [] : all],
    ["Needs your attention", showStatus ? attention : []],
    ["Running", showStatus ? running : []],
    ["Recent conversations", showStatus ? recent : []],
  ] as const) {
    if (!items.length) continue;
    blocks.push({ type: "divider" }, { type: "header", text: pt(title) });
    for (const b of items.slice(0, 6)) {
      const answer = input.deliveries.find(
        (d) => d.id === `answer:${b.lastRequest}`,
      );
      const status = hasQuestion(b)
        ? "Question waiting in this Slack conversation"
        : b.needsAttention
          ? "Question or permission waiting in Zana"
          : b.state === "idle"
            ? answer?.state === "sent"
              ? "Turn ended · Answer delivered"
              : "Turn ended · Open conversation for results"
            : b.state.replaceAll("-", " ");
      blocks.push(
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${plainSlack((b.title || "Agent conversation").length > 95 ? b.title!.slice(0, 92).trimEnd() + "…" : b.title || "Agent conversation")}*`,
          },
        },
        context(
          `${showProjects ? name(b.projectId) + " · " : ""}${b.sourceChannel ? "Private agent chat" : "#" + (routes.find((r) => r.channel === b.channel)?.name || "channel")}${showStatus ? " · " + status : ""}${b.paused ? " · updates muted" : ""}`,
        ),
      );
      const elements: Record<string, any>[] = [
        {
          ...button("Open conversation", "home_conversation"),
          url: b.slackUrl || slackLink(b.team, b.channel, b.root),
        },
      ];
      if (
        answer?.state === "sent" &&
        featureEnabled(config, "answers") &&
        (answer.origin !== "agent" || bindingRoute(config, b)?.summaries)
      ) {
        elements.push({
          ...button("Open result", "home_result"),
          url:
            slackLink(b.team, b.channel, b.root) +
            `&message_ts=${encodeURIComponent(answer.ts || b.root)}`,
        });
      }
      const canvas =
        config.canvasEnabled === true &&
        featureEnabled(config, "answers") &&
        bindingRoute(config, b)?.summaries &&
        (input.canvases || []).find(
          (x) =>
            x.key === b.key &&
            x.state === "published" &&
            x.ownerEpoch === config.ownerEpoch &&
            x.url &&
            sameRoute(
              {
                ...x.route,
                sourceChannel: undefined,
                channel: x.route.sourceChannel || x.route.channel,
              },
              bindingRoute(config, b)!,
            ),
        );
      if (canvas)
        elements.push({
          ...button("Open Canvas", "home_canvas"),
          url: canvas.url,
        });
      if (!showStatus || (b.active && b.state !== "stopping"))
        elements.push({
          ...button("Stop", "home_stop", b.key),
          style: "danger",
          confirm: {
            title: pt("Stop this agent?"),
            text: pt(
              "This interrupts the active turn and cancels queued follow-ups. You can continue later in its Slack conversation.",
            ),
            confirm: pt("Stop agent"),
            deny: pt("Keep running"),
          },
        });
      elements.push(
        button(
          b.paused ? "Unmute" : "Mute updates",
          b.paused ? "home_unmute" : "home_mute",
          b.key,
        ),
      );
      const local = localThreadLink(b.threadId);
      if (local)
        elements.push({
          ...button("Open Zana · this computer", "home_local"),
          url: local,
        });
      blocks.push({ type: "actions", elements });
    }
    if (items.length > 6)
      blocks.push(
        context(
          `Showing 6 of ${items.length}. More history is available in Zana → Plugins → Zana for Slack.`,
        ),
      );
  }
  if (!all.length && !pending.length && !requests.length && routes.length)
    blocks.push(
      { type: "divider" },
      section(
        "Your next task starts here.\nChoose New agent, select a Project and channel, then describe what you want done. Follow-ups stay in that Slack conversation.",
      ),
    );
  blocks.push(
    { type: "divider" },
    context(
      `Updated ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC. This is a saved snapshot; it may be stale if your machine is asleep. Keep Zana running. Execution permissions are reviewed in Zana.`,
    ),
  );
  return {
    type: "home",
    callback_id: HOME_CALLBACK,
    private_metadata: token,
    blocks,
  };
}

export function launchView(
  draft: HomeLaunch,
  projects: { id: string; name: string }[],
  project = "",
  channel = "",
  provider = "",
) {
  const ready = draft.routes.filter((r) => r.model);
  const options = [...new Set(ready.map((r) => r.projectId))].map((id) => ({
    text: pt(
      (projects.find((p) => p.id === id)?.name || "Configured Project").slice(
        0,
        75,
      ),
    ),
    value: id,
  }));
  const selected =
    options.find((o) => o.value === project) ||
    (options.length === 1 ? options[0] : undefined);
  const source =
    ready.find(
      (r) => r.projectId === selected?.value && r.channel === channel,
    ) || ready.find((r) => r.projectId === selected?.value);
  const providers = draft.providers?.length
    ? draft.providers
    : source
      ? [{ id: source.providerId, name: source.providerId }]
      : [];
  const selectedProvider =
    providers.find((p) => p.id === provider) ||
    providers.find((p) => p.id === source?.providerId) ||
    providers[0];
  const initialModel =
    selectedProvider?.id === source?.providerId ? source?.model : undefined;
  const channels = ready
    .filter((r) => r.projectId === selected?.value)
    .map((r) => ({
      text: pt(`#${r.name}`.slice(0, 75)),
      value: r.channel,
    }));
  if (
    draft.callerChannel &&
    !channels.some((c) => c.value === draft.callerChannel)
  )
    channels.unshift({
      text: pt("Here — the conversation you called Zana from"),
      value: draft.callerChannel,
    });
  const selectedChannel =
    channels.find((c) => c.value === (channel || draft.callerChannel)) ||
    (channels.length === 1 ? channels[0] : undefined);
  return {
    type: "modal",
    callback_id: LAUNCH_CALLBACK,
    private_metadata: draft.id,
    title: pt("Start a Zana agent"),
    submit: pt("Start agent"),
    close: pt("Cancel"),
    blocks: [
      section(
        "Choose a Project, harness and model. Replies appear in the selected conversation. Your Project’s settings are the defaults.",
      ),
      {
        type: "input",
        block_id: "project",
        label: pt("Project"),
        dispatch_action: true,
        element: {
          type: "static_select",
          action_id: "launch_project",
          placeholder: pt("Choose a connected Project"),
          options,
          ...(selected ? { initial_option: selected } : {}),
        },
      },
      ...(selected
        ? [
            {
              type: "input",
              // A new id resets Slack's retained channel when the Project changes.
              block_id: destinationBlock(selected.value),
              label: pt("Slack channel"),
              hint: pt(
                "Members of this channel can see your task and shared updates.",
              ),
              element: {
                type: "static_select",
                action_id: "channel",
                placeholder: pt("Choose a channel"),
                options: channels,
                ...(selectedChannel ? { initial_option: selectedChannel } : {}),
              },
            },
          ]
        : [context("Select a Project to see its connected Slack channels.")]),
      ...(selected && selectedProvider
        ? [
            {
              type: "input",
              block_id: harnessBlock(selected.value),
              label: pt("Harness"),
              dispatch_action: true,
              element: {
                type: "static_select",
                action_id: "launch_harness",
                options: providers.map((p) => ({
                  text: pt(p.name.slice(0, 75)),
                  value: p.id,
                })),
                initial_option: {
                  text: pt(selectedProvider.name.slice(0, 75)),
                  value: selectedProvider.id,
                },
              },
            },
            {
              type: "input",
              block_id: modelBlock(selected.value, selectedProvider.id),
              label: pt("Model"),
              element: {
                type: "external_select",
                action_id: "launch_model",
                min_query_length: 0,
                placeholder: pt("Search available models"),
                ...(initialModel
                  ? {
                      initial_option: {
                        text: pt(initialModel.slice(0, 75)),
                        value: initialModel,
                      },
                    }
                  : {}),
              },
            },
          ]
        : []),
      {
        type: "input",
        block_id: "task",
        label: pt("What should the agent do?"),
        element: {
          type: "plain_text_input",
          action_id: "prompt",
          multiline: true,
          max_length: 2000,
          ...(draft.task ? { initial_value: draft.task } : {}),
          placeholder: pt(
            "Review the onboarding page and suggest three improvements…",
          ),
        },
      },
      context(
        "Agents run on your configured Zana machine. Keep it awake. Execution permissions are reviewed in Zana.",
      ),
      {
        type: "actions",
        elements: [button("Connect another Project", "launch_connect")],
      },
    ],
  };
}
export const harnessBlock = (project: string) => `harness_${project}`;
export const modelBlock = (project: string, provider: string) =>
  `model_${project}_${provider}`;
export const destinationBlock = (project: string) => `destination_${project}`;
export function connectView(setupUrl?: string) {
  return {
    type: "modal",
    callback_id: "zana_connect_project",
    title: pt("Connect a Project"),
    close: pt("Done"),
    blocks: [
      section(
        "Connect a Project in Zana → Plugins → Zana for Slack on your computer. It will then appear on this dashboard and in the New agent picker.",
      ),
      section(
        "1. Invite Zana to the Slack channel you want to use.\n2. In Zana → Plugins → Zana for Slack → Configuration, choose Connect another Project.\n3. Select the Project, channel, machine, model, and what Slack should receive. Save the connection.",
      ),
      ...(setupUrl
        ? [
            {
              type: "actions",
              elements: [
                {
                  ...button("Open setup · this computer", "setup_open"),
                  url: setupUrl,
                },
              ],
            },
          ]
        : []),
      context(
        "The setup link works on your Zana computer. On a phone or another computer, open Plugins → Zana for Slack on that machine. After saving, return to Home and choose Refresh.",
      ),
    ],
  };
}
export const queuedView = (note?: string) => ({
  type: "modal",
  title: pt(note ? "Request status" : "Request queued"),
  close: pt("Done"),
  blocks: [
    section(
      note ||
        "Your request is saved. Zana will create its conversation in the selected channel, then start the agent when an execution slot is available. Return to Home to follow progress.",
    ),
  ],
});
