# Zana UI in Slack

All eight surfaces from the UI exploration now have an implementation path. Live channel trials have verified launch forms, ordinary questions, native rich reports, Work Objects and custom panels. Private native agent chat was activated on 4 October 2026; owner DM launch and same-thread follow-up passed live. Native Stop is under verification. Canvas permissions remain unactivated. The Project/harness/model launch picker was verified live on 2 October 2026.

| Surface | Behavior |
| --- | --- |
| Interactive messages | Durable task/status cards, stop and mute controls, concise answers and result actions |
| Native forms | Project/destination/harness/model/task launch forms and ordinary clarification forms with choices or written answers |
| App Home | Connected Projects, running/recent conversations, attention, result links and published Canvas links |
| Rich answers | Typed text, tables, charts, code/diff excerpts and read-only task snapshots |
| Work Objects | Owner-authorized task entities attached to cards, with native details and a custom preview |
| Custom web panels | Read-only task status, Summary/Report, sortable tables and charts, Canvas links and expiring access |
| Dedicated agent chat | Private Messages/agent view, explicit connected-Project selection, context suggestions, native loading/stop and follow-ups |
| Canvas | An explicitly confirmed, persistent snapshot of an answer already shared to Slack |

The plugin settings contain separate **Private agent chat**, **Read report inbox**, **Question forms in Slack**, **Publish shared answers to Canvas**, **Share rich results**, and **Enable custom web panels** switches. New capabilities default off. Existing functionality flags and each connection's answer-sharing consent still apply.

The chosen presentation for this connection is inline rich results with custom web panels off. The extra task attachment cards duplicate the report and hide their useful content behind another click. Old cards can be removed with the operator `removeTaskPreview` RPC once the hosted gateway supports empty metadata and attachment updates; their recorded message content is retained. Production cleanup passed on 1 October 2026.

Start a new Slack conversation after enabling question forms or rich results. Running agents retain their initial tool catalog and report instructions. Forms answered within a conversation continue that same agent.

## Private agent chat

Only the linked owner's one-to-one DM is admitted. The gateway verifies the Slack DM participant before registering it, and both gateway and plugin authorize subsequent actions. DMs remain outside the channel browser. A configured channel provides the Project/machine and sharing policy; the launch picker can override its harness/model for the task, with replies in the private DM. Follow-ups retain the chosen profile. Legacy native agent chat continues to use its configured profile.

Slack context can suggest an exact configured channel for a new chat. Otherwise the first task waits for a Project connection choice. Context changes cannot reroute an existing conversation. An owner, model or mapping change requires a fresh chat. Follow-ups reuse its Zana thread; native stop controls use the same durable receipt/stop flow.

Progress uses `agents.sessions.setStatus`, with `assistant.threads.setStatus` fallback only after a definitive old-method rejection. Processing is explicitly cleared on completion. Ordinary questions and desktop permission requests display suspended state. Muting progress clears an existing loading indicator. Suggested prompts are optional. Ambiguous welcome delivery never automatically repeats a post.

## Questions

The bound agent receives `slack_bridge_ask` when question forms, follow-ups and answer sharing are enabled. It accepts `{ questions: [{ text, options: ["Choice A", "Choice B"] }] }`, with one to three questions and two or three unique short choices each. The owner may write an answer instead of selecting a choice.

The agent ends its turn after asking. Form submission becomes one durable ordinary follow-up to that same Zana conversation, dispatched when the thread is ready. Duplicate Slack submissions cannot create a second receipt. Forms expire after a day, and expire on remapping, owner rotation, a newer turn, mute or consent removal. **Execution permission requests remain in Zana.** The form never resolves a host permission interaction.

## Canvas snapshots

A shared answer's **Publish to Canvas** button opens a native confirmation naming its audience. In a channel, Slack attaches the snapshot to that same channel with edit access. In private chat, Zana creates a private Canvas, sends its link to the linked owner, then grants that owner read access. No other user or channel can be added through this integration.

Content comes only from a confirmed answer and its normalized report. Tables remain tables, charts become labelled values, tasks become checklists, and code/diffs remain inert excerpts. Zana does not read files for export or overwrite an existing Canvas. The confirmed answer revision and policy are checked again before every step. One answer revision produces at most one export; ambiguous creation is retained for local inspection without automatic retry.

Canvas copies persist in Slack independently of Zana's settings. Disabling sharing prevents further export and ends custom-panel access; it does not delete previously posted messages or Canvas copies. Creation failures and unconfirmed attempts post a concise notice in the bound conversation, with no automatic creation retry. Canvas notices and question cards cannot replace the final answer in the task viewer. Local surface activity shows export state and errors.

## Later activation and trial

For native agent chat without Canvas, use the core repository's `docs/slack-configuration/app-manifest-agent-chat.json`. It preserves the current channel integration and diagram-upload scope, enables the editable Messages tab and `agent_view`, and adds only `im:read`, `im:history`, and `assistant:write` to the live bot permissions. Subscribe to `message.im`, `app_context_changed`, `agent_session_stopped`, and `agent_session_title_changed`. Compare against a fresh app export before applying, approve/reinstall the app, and enable **Private agent chat**. This agent-only activation was approved and installed in Internal-Sandbox on 4 October 2026, with Private agent chat enabled. Launch and same-thread follow-up passed; native Stop is under verification.

In native private chat, `@Zana` is optional. Its own mention is removed before parsing tasks and commands; mentions of other people remain in task text. A bare mention offers Project selection for a new task thread and shows status in an existing one, without creating or sending a task.

1. The updated Connect Slack gateway is deployed. Configure **Interactivity → Options Load URL** to match the Slack events endpoint for external model search; this was verified live.
2. Review the prepared `slack-app-full-ui-connect-manifest.json` (or Socket Mode `slack-app-full-ui-manifest.json`). It adds `im:read`, `im:history`, `assistant:write`, and `canvases:write`, DM events, native agent events, legacy compatibility events, entity details, and `features.agent_view`. Reinstall the app after approving the new scopes.
3. Check Slack plan availability for the agent view and Canvas behavior. Slack permits new apps to use `agent_view`; switching an existing `assistant_view` app to it is irreversible. The prepared manifests have **not** been applied to the live workspace.
4. Enable the wanted plugin switches, then use a synthetic task in private chat: select a Project, verify progress/stop/follow-up, answer an ordinary form, share a report and confirm a Canvas export. Check Home and the custom panel.
5. Repeat with a mapped channel and verify the Canvas audience. Check a second user's rejection, revoked sharing, missing scopes, and a disconnected computer.

Official contracts: [agent development](https://docs.slack.dev/ai/developing-agents/), [context](https://docs.slack.dev/ai/agent-context-management/), [session status](https://docs.slack.dev/reference/methods/agents.sessions.setStatus/), [Canvas create](https://docs.slack.dev/reference/methods/canvases.create/), [Canvas access](https://docs.slack.dev/reference/methods/canvases.access.set/), [Canvas Markdown](https://docs.slack.dev/surfaces/canvases/), [manifest](https://docs.slack.dev/reference/app-manifest/).

## Calling from another conversation

`/zana` works in an internal channel where the owner and Zana are members. The form defaults to replying **Here**, with the selected Project’s harness/model prefilled. An unconnected `@Zana <task>` starts directly using **Default Project for mentions** from plugin settings, or the connected built-in Default Project. The saved Project profile supplies the machine, harness, model and sharing consent. With no connected default, a durable **Start with Zana** picker is offered; ambiguous invitation delivery is not retried. Selecting another harness resets the model and searches that harness’s available models on the Project machine. Project defaults stay unchanged, and every follow-up uses the original task profile. Task status messages contain only text, without Stop/Mute/Open buttons or machine footers. Home and explicit mention commands retain task controls.

Basic DM launch needs only the minimal DM manifest from the main repo’s `docs/slack-configuration/app-manifest-dm-launch.json`, containing `im:read`, `im:history`, `message.im` and the Messages tab. It does not require native agent status or Canvas permissions. Apply/reinstall after approval, then test `/zana` and plain threaded follow-ups in the linked owner’s DM. DM access is active through the agent-only activation on 4 October 2026.

Mentions in ordinary existing Slack threads are admitted even before Zana has registered their root. The gateway binds that root to the linked owner; an existing foreign owner’s claim is never overwritten. A bare app mention offers a task form, or shows status within an existing Zana task. Invitation admission is bounded to fresh owner messages of up to 2,000 characters. The fix was deployed as v78 and verified at the built Electron/Connect boundary on 2 October 2026.


## Emoji status markers

Chat status messages use ⏳ queued, ⚙️ working, 🧠 thinking, ✅ completed, ⏹️ stopped, ⚠️ needs attention, and ❌ failed. Stop requests show ⏳ until the host confirms; explicit mute acknowledgements use 🔇. Each request still updates its existing status message, without a button row or a new message for each phase.

Thinking requires a real reasoning item/delta from the agent. Tool or answer activity restores Working. The existing ten-second reconciliation reads at most 500 events per active conversation; brief phases may be skipped, and harnesses without reasoning signals retain Working. Only the coarse phase and an opaque item id are retained, never private reasoning or tool contents. Completion/stop and owner/route changes take precedence over delayed activity reads.


## Clean replies

Temporary queued/working/thinking statuses are removed after a normally completed turn has a confirmed Slack answer (or question form). The answer remains; later revisions update it without recreating the status. Do not post “Turn ended”, “Answer delivered” or follow-up boilerplate beside a successful answer. Failed/uncertain answer delivery, errors, confirmed stops and missing answers retain concise actionable notices. Cleanup never targets user messages, answers, Canvas links or arbitrary Slack timestamps.

A late answer still cleans its own old status during a newer follow-up. Status removal uses the durable outbox, current owner/channel authorization and the gateway's link-owned message ledger. Ambiguous deletions remain in the local delivery log and are not replayed automatically; definitive rate limits receive the existing bounded retry. Removed status tombstones join the ordinary capped terminal-history retention. The operator `cleanupStatuses` RPC removes eligible previously recorded completion notices without accepting a channel or timestamp.

The 0.15.0 conversational upgrade removes the mandatory Project picker in native private chat. The assistant resolves an authorized connected Project or asks a focused clarification, then queues the original task with saved execution defaults. Owner DM report searches and summaries use a separate **Read report inbox** permission and include registered Projects without channel imports. Reading never marks a report read. The updated core provides bounded inbox reads and tool-free Claude inference; an available configured Claude login is required.
