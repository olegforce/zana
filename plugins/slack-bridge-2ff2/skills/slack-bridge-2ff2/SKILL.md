---
name: slack-bridge-2ff2
description: Inspect Zana for Slack connection, request status, and confirmed or uncertain deliveries; explain owner-only Slack agent control.
---

Use `zcc slack-bridge-2ff2 status` (or `zcc plugin run slack-bridge-2ff2 status`) for read-only connection, channel, request, and delivery state.

Setup happens in Plugins → Zana for Slack → Configuration. Use the shared Zana app with the existing account/computer connection from Settings → Remote access and a one-time activation code from Slack Home. No Zana API token, Slack app ID, app-level token or bot token is needed for this flow. Connected settings hide those inputs and manual member pairing. The service address is an advanced option. Only choose **Advanced: use your own Slack app** for a separately managed Socket Mode app; existing direct installations remain supported. Never request tokens in chat or read secret settings files. Private chat infers a connected Project or asks one focused clarification. Tasks use saved provider/model defaults; users can still override them in the explicit launch form.


Start a channel conversation with a bot mention:

- In a connected channel, `@Zana <task>` (`run <task>` also works) starts a visible Zana thread using its defaults. An unmapped internal channel uses the saved mention default or connected built-in Default Project. With no connected default it offers **Start with Zana** to choose a Project, harness and model.
- In the same Slack thread, the original launcher can reply without another mention when `message.channels` / `message.groups` subscriptions and their required history scopes are activated. Other people's messages, unrelated threads, edits and bot messages are ignored. `@Zana <follow-up>` remains supported when those subscriptions are unavailable.
- `status`, `help`, `stop`, `mute`, and `unmute` control that conversation. Mute only silences updates; the agent continues working. `pause`/`resume` remain compatibility aliases.

Only the verified owner can control agents. Other channel messages are ignored. Permission prompts remain in Zana. The selected machine must be available and the Zana plugin process must stay running.

An agent may call `slack_bridge_publish` only when this thread's configured channel permits agent summaries. Use it for one concise final answer per turn; repeated calls update that turn’s answer. Working/thinking updates revise one temporary status message; it is removed after the turn ends and an answer is confirmed delivered. An ended turn without a shared answer has an attention notice, not a success checkmark. That tool sends to the host-bound conversation; it cannot select another destination. Never include credentials or raw tool output. Its `queued` response does not mean sent: consult delivery status. Do not autonomously retry an uncertain message or dispatch; ask the operator to inspect Slack/Zana first.

Use standard Markdown in the shared text: headings, emphasis, lists, inline references and fenced code are converted to native Slack rich text. Code languages are not displayed as stray first lines. Links and mentions remain literal references. Mermaid fences and rich-result code sections with language `mermaid` can render locally as images in the same reply when Slack uploads are activated. Include a concise readable overview with text arrows or a component list; render or upload failures retain labelled source. Keep diagrams self-contained, without links, external resources or renderer configuration. Up to two unique diagrams are rendered per answer; revisions reuse confirmed uploads. Optional, owner-confirmed Canvas exports reuse the diagram image. Full Markdown files are not uploaded automatically.

## Slack Home dashboard (0.3.0)

The paired owner can use Zana → Home → New agent to select an existing Project, destination, available harness/model and submit a task. Home shows running, attention, and recent bridge tasks, with Open conversation, Stop (confirmation), and Mute/Unmute. The existing mention flow remains supported. Home requires the Home tab and app_home_opened event; no additional scopes. Saved Home views can be stale while the receiver is offline. CLI status includes Home publication status and canonical Slack task URLs.

## Custom task panel (0.14.0)

For connected accounts, enable **Custom task panel in Slack → Enable custom web panels**. It uses the existing Connect transport; users do not configure a separate hostname or port. Click the Agent task attachment in Slack to open the read-only panel. It shows task state and the latest confirmed shared answer, including inert fenced code, and refreshes every ten seconds. With **Share rich results** enabled, its Report view adds formatted text, sortable tables, accessible bar charts, inert code and diffs, and a read-only task board. The owner-only preview grant lasts five minutes. Offline snapshots are labelled; expired content is cleared, including when a suspended page returns. Reopen the card to get new access.

Never copy preview capability URLs into chat or logs. CLI status omits them. Disabling/muting/revoking access invalidates the panel. Full transcripts, files, and tool output are not exposed. Direct Socket Mode users retain the dedicated HTTPS listener setup in docs/task-website-setup.md.

For a Slack-controlled conversation, the user cannot see Zana's desktop panels. Do not open file previews, browsers, visualizations, terminals or plugin panels to show them a result. Background work and hidden browser automation are still useful. Return a permitted answer through the bound Slack delivery tool, or explain the current sharing limitation. Localhost URLs and local paths are not remote previews. Ordinary structured questions can use Slack forms when enabled; execution permissions require Zana. Follow-ups use Slack mentions or private agent chat. This context applies even when answer sharing is disabled, and viewing the thread in Zana does not transfer control. Updated Zana builds enforce desktop presentation restrictions in addition to this guidance.

## Slash commands (0.6.0)

With `/zana` configured and the `commands` scope granted, the owner can use `/zana` to open the launch picker; `/zana run <project> <task>` to prefill it; `/zana run . <task>` for the current channel’s Project; `/zana projects`, `/zana status [project]`, `/zana connect`, and `/zana help`. Quote Project names containing spaces, or use exact IDs from `/zana projects`. Only connected Projects are exposed. Slash commands run in the main composer, not Slack message threads. The form prefills the Project profile and allows a per-task harness/model override. It defaults to the calling internal channel when available, even without a saved mapping; Home defaults to a connected channel. Confirm Start agent before a task post or launch. Replies are ephemeral; confirmed tasks go to the selected conversation. The selected machine and sharing policy come from the source Project connection; removing/changing that connection or rotating the owner revokes the override. Follow-ups stay pinned to that task’s profile. Same-conversation follow-ups and Stop remain mentions or Home controls. Socket Mode needs no Request URL. Read docs/slash-commands.md for installation and troubleshooting.

## Slackbot app (0.8.0)

With hosted Connect activated and the app approved for `mcp:connect`, Slackbot can call `zana_list_projects`, `zana_launch_job` and `zana_job_status`. See docs/slackbot-app.md. Launch starts an agent conversation and posts its task to the chosen mapped channel. Use exact Project/channel IDs and a stable `request_id`; retries must reuse the same key and arguments. An accepted/queued response is not completion. Status exposes only a confirmed shared answer; inspect uncertain launches locally before requesting new work. Permissions remain in Zana. The public endpoint and Slack app approval are separate from plugin installation; Socket Mode alone is insufficient.

## Selective Project imports — 0.11.0

Projects are imported only when the user chooses them. Connecting Zana or registering a new Project does not create a channel. Existing imported channels and manual mappings stay connected.

Open **Plugins → Zana for Slack → Configuration**, save **Import defaults**, then select Projects and choose **Import selected**. The defaults include searchable machine/provider/model selectors, an optional prefix preview, answer-sharing controls and **Allow imports from Slack**. Search/filter the Project list; expand **Manage connected channels** for route edits. Removing a mapping prevents automatic recreation; reimporting reuses a retained managed channel.

With Slack imports enabled, use `/zana import "Project name"` or ask Slackbot to import the Project. `/zana import` lists names and IDs. `zana_list_projects` includes import state and `zana_import_project` imports one exact ID. Imports do not launch jobs.

**Slack capabilities** displays the shared built-in inventory and locally enabled plugin tools. The first plugin extension contract is read-only, scoped to imported Projects, and requires local enablement. Source: `src/capabilities.ts`; type contract: `sdk.ts`; authoring guide: `docs/slack-capabilities.md`. The canonical static inventory lives in the main repo’s `packages/slack-capabilities/catalog.json`, with generated copies in the website and this plugin. Regenerate with its `sync.mjs --plugin <this directory>` command.

## Rich shared results

**Share rich results** is a separate opt-in in the plugin Configuration page. It never overrides **Share answers**, each channel's agent-summary consent, owner checks or mute. Existing Slack posts remain when sharing is disabled; old task-panel grants end immediately.

When enabled, `slack_bridge_publish` accepts its required concise `text` plus optional `result: { title, sections }`. Use typed `text`, `code`, `diff`, `table`, `chart` or `tasks` sections; see [the contract and example](../../docs/rich-results.md). Do not submit HTML, arbitrary Block Kit, actions, filesystem paths, URLs or raw tool transcripts as report fields. Code and diff excerpts must be requested and deliberately shareable. Charts and task states are agent-reported, not independently verified by Zana. A task board is a snapshot; sorting changes only the local view.

A turn still owns one durable answer: repeated tool calls revise the same message. Only confirmed `sent` reports enter the private task-panel projection. Native Slack rendering uses literal Block Kit text, tables, charts and preformatted code. A definitive `invalid_blocks`/`feature_not_enabled` rejection downgrades to the concise answer; the authorized report remains in the custom panel. An ambiguous error never triggers a fallback retry. Custom panels must already be enabled to open the report there. Dedicated agent chat and Canvas publishing are available through the separate opt-ins below.

## Full Slack UI surfaces

Start a new Slack conversation after enabling question forms or rich results. Existing agents retain their initial tool catalog and instructions; a form answer continues the conversation that asked it.

Private agent chat, ordinary question forms and Canvas exports are separate opt-ins in plugin Configuration. See `docs/full-slack-ui.md` for the complete eight-surface implementation and the prepared full-UI manifests. New scopes, gateway deployment and live Slack activation are still separate steps; do not describe them as already verified.

In a bound Slack conversation, `slack_bridge_ask` asks one to three ordinary preference/clarification questions with two or three short choices each. This requires answer sharing and follow-ups to be enabled. The owner can select or type answers in Slack. End the turn after asking; answers arrive as an ordinary follow-up to the same thread. Never use this tool to grant execution permissions. Native permission requests remain in Zana.

Basic owner DM launch works through `/zana` or an offered launch picker after `im:read`/`im:history` and `message.im` are activated; native agent view is a separate opt-in. Private chat is limited to the linked owner's verified DM. The launch picker chooses a connected Project and available harness/model, retaining its machine and sharing consent. Legacy native agent chat uses its configured profile. Slack context can suggest a connected channel for a new chat but cannot grant access or reroute an existing thread. Send results through the existing bound publish tool.

Canvas publishing is owner-initiated from an already confirmed shared answer, with a native audience confirmation. A Canvas is a persistent snapshot; later exports do not replace user-edited documents. Private snapshots are linked to the owner first, then shared read-only. An unconfirmed create must be inspected before any new export; never automatically repeat it.

Model search requires Interactivity’s **Options Load URL** to match the Slack events request URL. Model options are loaded from the selected machine/harness and checked again before launch. Do not guess model IDs or claim DM scopes are active before the app is reinstalled. Shared/external channels, group DMs and other people’s DMs are excluded. Slackbot can discover harness/model IDs through `zana_launch_options` and pass optional `harness`/`model` to `zana_launch_job`. It retains the approved Project/channel and machine. Never guess IDs; changing the profile on an idempotent retry is a conflict.

A fresh task mention starts directly in an ordinary existing Slack thread or unmapped internal channel using the saved **Default Project for mentions**, or the connected built-in Default Project. Without a connected default it offers a picker. Status messages are plain text; task controls remain in Home or explicit mention commands. A bare `@Zana` offers the task form; inside an existing Zana task it shows status. Slack requires the app to be invited before it delivers channel mentions, and installation in each workspace where it is used. In the verified owner DM, app mentions are stripped before task/control parsing; DM events still require activation.

## Conversational private chat and report inbox — 0.15.0

In the owner’s private native agent conversation, describe a task or name a Project. No mandatory agent/Project picker is shown. Ambiguous targets produce a clarification, and the original task is retained. Follow-ups preserve the worker’s Project binding. Native Stop cancels conversation inference and stops the bound worker.

With **Read report inbox** enabled separately, ask for recent/unread reports, search by topic, or read/summarize a returned report. These reads span registered Projects without requiring Slack-channel imports, preserve unread state, and never post report content in shared channels. Report attachments are current saved text, confined to their Project; large excerpts are bounded. The conversational helper requires the updated Zana core’s `sdk.assistant` and `sdk.inbox.search/read` and an available configured Claude login. Worker models remain their saved defaults. Do not claim this upgrade is deployed when the installed core is older.
