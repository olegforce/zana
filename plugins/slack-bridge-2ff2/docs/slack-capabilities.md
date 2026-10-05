# Slack functionalities, Project imports and plugin tools

Zana for Slack 0.11 makes Project imports explicit. Connecting a computer or registering a new Project no longer creates Slack channels. Existing imported channels, manual mappings, IDs and history remain intact. The upgrade records existing managed mappings as the selected set and leaves any unfinished automatic imports unselected.

In **Plugins → Zana for Slack → Configuration**, expand **Import defaults**, choose a machine/provider/model and answer-sharing policy, and optionally set the channel prefix. Saving defaults creates no new channels. Then search or filter Projects, check the ones to import, and choose **Import selected**. Creation continues in batches of five. Removing a mapping stops it being recreated; reimporting reuses its retained managed channel. No channel is archived or deleted.

Enable **Allow imports from Slack** to let the verified owner use `/zana import "Project name"` (exact IDs also work) or ask Slackbot to import it. `/zana import` lists up to 40 available names and IDs; Slackbot’s `zana_list_projects` lists up to 250 with import state. Ambiguous names require an ID. Imports use locally saved defaults and never start an agent. Repeating an import reuses the channel. If a response is interrupted, inspect the destination using `zana_list_projects` before retrying. The existing job tools and owner checks remain unchanged.

The default channel is `zana-<project>` or `<prefix>-zana-<project>`. A stable suffix is used only after Slack reports a collision. Defaults for execution and sharing apply to future imports; changing the prefix renames the selected managed channels while keeping IDs/history. Managed private channels initially add only the linked owner and the bot.

## What Slack can do (0.12)

The plugin settings now include searchable controls with **All / Enabled / Disabled** filters. These are enforced on the computer receiving the request, across Slackbot, slash commands, Home forms, mentions and queued work.

| Control | Functionality |
| --- | --- |
| Browse Projects | List registered names and approved destinations. Required for new jobs and imports; existing conversations remain controllable. |
| Import Projects | Import only the requested Project with saved defaults. Uses the same setting as **Allow imports from Slack**. |
| Start new jobs | Start an agent in an imported Project. Disabling also rejects queued jobs and stale forms before execution. |
| Continue conversations | Send further tasks to an existing thread. Disabling rejects queued follow-ups without stopping running work. |
| View job progress | Return status, publish activity updates and show task previews. Home retains basic conversation controls. |
| Share answers | Publish new answers and expose confirmed shared answers in status/preview responses. Channel sharing rules still apply to agent summaries. Existing messages already posted in Slack remain visible. |
| Use plugin tools | Discover/run individually approved read-only tools. Turning off the master switch preserves individual grants, blocks calls and suppresses in-flight results. |

Connection setup, help, stop, mute and unmute remain available while the bridge is connected. Missing flags preserve previous functionality; existing import opt-in and plugin grants are preserved. A switch cannot retract a network request already sent or stop an agent already running. Local settings cannot be changed through Slack.

The shared catalog's `features` section declares the inventory and tool mapping. The bridge's `src/access.ts` contains policy, with checks at admission and immediately before dispatch/delivery or returning asynchronous results. The plugin reads the packaged JSON per generation in `src/catalog.ts`: ordinary JSON imports remain cached across path-plugin reloads and otherwise leave new settings paired with stale definitions. The hosted app retains its seven stable MCP schemas; disabling a built-in rejects invocation rather than removing that schema from the workspace-wide discovery cache. No Heroku release is needed for these per-computer controls.

## One capability inventory

Edit [`packages/slack-capabilities/catalog.json`](../../../packages/slack-capabilities/catalog.json), then run its `sync.mjs` command with the Zana for Slack source directory. Generated copies are packaged in the website and plugin. This inventory drives hosted MCP discovery, the settings’ built-in tool list, and slash-command help. Authorization and handlers remain in their respective services.

The catalog includes connection, Project discovery/import, job launch/status, plugin capability discovery/invocation, and channel shortcuts. Tools are always routed using Slack’s signed identity and the server’s active account/computer link. Neither caller-provided account IDs nor arbitrary plugin RPCs are accepted.

## Contributing a plugin tool

The bridge publishes `SlackCapabilityService` using `zcc.services.provide`. A consumer declares `zcc.requires: ["slack-bridge-2ff2"]` in its package manifest and registers a tool after the bridge starts. Type definitions are exported by the bridge’s `sdk.ts`.

```ts
export default function plugin(zcc) {
  const slack = zcc.services.use('slack-bridge-2ff2');
  const unregister = slack.register(zcc.pluginId, {
    id: 'project_summary',
    title: 'Project summary',
    description: 'Read this Project’s concise saved summary.',
    version: 1,
    readOnly: true,
    fields: {
      section: {
        type: 'string',
        description: 'Which part to read',
        enum: ['overview', 'tests'],
        maxLength: 40,
      },
    },
    required: ['section'],
    async execute(args, { projectId, slackUserId, teamId, signal }) {
      // Read only within projectId; return a deliberately shareable projection.
      // Respect signal. Never return credentials or raw private files.
      return { summary: await readSavedSummary(projectId, args.section, signal) };
    },
  });
  zcc.onDispose(unregister);
}
```

The effective ID is `<pluginId>.<id>`. Slackbot sees it only after the local user enables it under **What Slack can do → Individual plugin tools**. Every call includes `project_id`, injected by the registry schema and checked against current imported and registered Projects. The handler receives that ID through trusted context; it does not receive the raw transport or general host API. Contributor plugins themselves are full-trust installed code, so `readOnly: true` is a contract they must honor, not an OS sandbox.

This first extension contract supports **read-only** tools. Fields are bounded strings, finite numbers, or booleans, with optional scalar enums. There are at most 12 fields per capability, 50 live capabilities, four concurrent handlers, 8-second response deadlines, and 32 KB results. A handler ignoring cancellation keeps its concurrency slot until it settles. Exceptions are replaced by a generic error. Connection/consent/Project checks run again before returning a result. Existing built-in job/import mutations use their separate audited paths.

Bump `version` whenever tool semantics or data scope changes. A changed version or schema invalidates the old enablement. Unloading a contributor must call its returned disposer. Bridge reload clears registrations: reload dependent contributor plugins afterward, or restart Zana to load the bridge before consumers. Registrations are intentionally not persisted as executable callbacks. Older hosts without plugin services show an explicit compatibility message.

## Verification

The production-boundary regression is `e2e/slackbot-mcp.spec.ts`. With `ZCC_SLACK_BRIDGE_DIR` set, it runs through signed hosted MCP → real Connect tunnel → installed plugin → real desktop SDK, tests selective import, an untouched Project, repeat import, wrong-owner/unregistered rejection, plugin consent and dispatch, revoked consent, and exactly-once job launch. It uses fake Slack APIs and a deterministic ACP fixture; it does not claim a live Slackbot AI conversation.


Previous 0.11 verification (30 September 2026): Zana for Slack 0.11.0 is installed and connected; Heroku v71 is healthy. 173 plugin tests and 342 website tests pass, plus the built-Electron integration above (38.4s total). The installed UI was exercised with computer use, including model search, Project search, and saving Slack-import enablement. The 38 previously managed channels and manual route remain. A new live Slack import conversation was not completed because the native Slack automation surface stayed on its workspace menu; use the production-boundary regression as evidence, not a claim of that live Slack smoke check. Slack’s [MCP client documentation](https://docs.slack.dev/ai/slackbot-mcp-client/) describes automatic tool discovery, but live rediscovery of this updated catalog was not observed here.


0.12 verification (30 September 2026): installed and connected locally. 199 plugin tests pass (93.97% statements, 90.72% branches; the central access policy has 100% coverage), TypeScript passes, and the two catalog consistency tests pass. The built-Electron Connect/MCP regression passed in 45.5s, including real UI switches, search/filter, disabled launches/browsing, plugin master access, and status revocation. Live mode/reasoning: 54 passed, one gated skip. `live:memory` was attempted with an explicit server URL but the Memory plugin is absent; its early-return test result is not evidence of live Memory retrieval. No Memory changes were needed here. Evidence: `.zcc/artifacts/slack-functionality-controls-2026-09-30/`. Computer use confirmed the installed panel displays all seven switches after hot reload; enforcement and toggle interactions were exercised in the isolated built app. No live Slack message was sent for this change.

## Code previews: supported by Slack, not yet added to this bridge

The current bridge publishes bounded plain-text answers. Slack's [message formatting](https://docs.slack.dev/messaging/formatting-message-text/) supports code blocks. Its [AI Markdown block](https://docs.slack.dev/reference/block-kit/blocks/markdown-block/) supports language highlighting, tables and checklists (12,000 characters across Markdown blocks per payload); verify availability in BT Internal Sandbox before relying on that richer block. [Snippet uploads](https://docs.slack.dev/reference/methods/files.getUploadURLExternal/) support a `snippet_type` and require `files:write`, which the current app does not request. A suitable next change is bounded inline code/diff previews with a filename and Open in Zana link, controlled by a separate opt-in setting and the existing answer-sharing gate. Full-file upload is a separate capability.
