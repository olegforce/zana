# Zana jobs in Slackbot

Zana for Slack **0.11** adds selective imports. Ask Slackbot to list your Projects and import the one you choose; it uses `zana_import_project` with an exact ID and your locally saved defaults. Enable **Allow imports from Slack** in the desktop settings first. New Projects are never automatically imported. Additional read-only plugin tools use `zana_list_capabilities` / `zana_run_capability` after local enablement. See [the capability contract](slack-capabilities.md).

Zana for Slack 0.8 supports jobs through Slackbot's Apps feature. The hosted service also provides domain-based account setup. Ask Slackbot to connect your Zana domain, list connected Projects, start work in one of them, or check an earlier job. A job here is an agent conversation using the Project/channel's configured machine, provider and model; this interface does not launch a saved Job Team.

Example: “Use Zana to review the failing tests in my website Project and put the job in #agent-work.” Slackbot lists the available destinations and starts the task using the selected IDs. Acceptance returns a job ID immediately. The existing Bridge queue creates a channel conversation, starts the agent and publishes its normal status updates. Ask “Check that Zana job” for progress and the latest confirmed shared answer. Existing mentions and Home controls remain available in the job's channel conversation.

| Tool | Behavior |
| --- | --- |
| `zana_connect` | Creates a private, ten-minute account-linking URL for the signed Slack caller. Accepts an optional claimed Zana domain or its label. Ownership and local approval are required before access becomes active. |
| `zana_list_projects` | Only locally mapped Projects and model-ready channels; no local paths or credentials. |
| `zana_launch_job` | Starts requested work and posts its task to the chosen channel. Requires exact `project_id`, `channel_id`, `task` and a stable `request_id`. |
| `zana_job_status` | Reads a `job_id` owned by the caller's current computer link. Returns state, attention, conversation URL and only a confirmed shared answer. |

## Connect your own domain

Ask Slackbot **“Connect Zana to my-domain.zana-ide.com”**, or run **`/zana connect my-domain.zana-ide.com`**. The slash-command response is visible only to its requester. Open the private connection link, sign in to the Zana account that owns that domain, and confirm the displayed Slack identity and domain. The page then copies the short-lived activation code and opens Zana for Slack at the selected owned domain; localhost is used only when that computer has no browser address. Paste the code into the already-focused activation field and approve access locally. The domain can also be entered as a label (`my-domain`) or an HTTPS origin. Omitting it opens the existing account-owned computer picker, which displays domain names.

Each Slack user has their own account/computer link. A domain is resolved against Zana Connect's registered addresses and checked against the signed-in account; it never becomes an arbitrary network target. A request for a specific domain cannot be approved against a different computer, even another computer owned by the same account. Unknown, revoked or unpaired domains cannot be activated. Creating a connection link does not grant access or replace an existing active link; replacement happens only after local approval. Existing job conversations keep their original link.

**Deployment status:** selective imports and the seven-tool capability catalog are live on `zana-ide.com` in Heroku release v71. The installed Zana for Slack is 0.11.0. The account-owned domain handoff and local approval are unchanged. Existing `groups:write` and `mcp:connect` scopes are sufficient; no additional scopes are requested. Local settings and the production-boundary integration test pass. Live Slackbot rediscovery and the new slash-command UI smoke were not completed because the native computer-use surface remained on its workspace menu.

The domain image was built from the production v52 source with seven scoped application files changed. Its production-container smoke check passed against disposable Postgres: the upgrade preserved existing linking codes, signed MCP exposed all four tools, domain setup required approval, and the built Connect page loaded its updated assets. Release v66 was rebuilt from that exact source context with only the Connect handoff updated; its manifest and source are in `.zcc/artifacts/slack-connect-handoff-2026-09-30/deployment/`.

## Authorization and delivery

The endpoint is `https://zana-ide.com/api/slack/mcp/`, using stateless Streamable HTTP and **Slack identity auth**. Every POST verifies Slack's raw-body signature and five-minute timestamp before accepting `_meta.slack.user_id` and `team_id`. An unresolved Enterprise workspace (`team_id: null`) fails closed. Discovery contains only static tool definitions. No bearer link credential, arbitrary thread ID, filesystem path or provider override is accepted as a tool-routing parameter.

Each call resolves the active Slack identity → Connect account → account-owned computer link. The signed envelope crosses the outbound tunnel to the local plugin, which independently checks the linked owner, app, workspace, connection and current mapping. Launches use existing Home/Bridge durable admission, channel checks and spawning. Local permission prompts stay in Zana.

`request_id` is an idempotency key, separate from the JSON-RPC ID. It must be unique for new work and unchanged on retries. Duplicate concurrent requests cannot admit twice; changed arguments return a conflict. Cloud records last 30 days (up to 2,000 per link); the local ledger independently retains the job. An interrupted cloud dispatch becomes **needs review**, never an automatic resend. Status can recover local acceptance after a lost response. A definitely offline request is **not started**. There is no offline wake-up queue or automatic machine fallback. Changing computer links does not migrate jobs.

## Live activation — BT Internal Sandbox

The integration is live in **BT Internal Sandbox** (`T04SR5XV56X`, enterprise `E04SQG1CF60`) through app **Zana** (`A0C5F0XK3TP`). Heroku release v68 is running with the sandbox app ID, team ID, bot token and signing secret. Event subscriptions for `app_mention` and `app_home_opened`, interactivity, Home, `/zana`, and the signed MCP endpoint are enabled; Socket Mode remains disabled. The MCP snapshot shows `zana_connect`, `zana_list_projects`, `zana_launch_job`, and `zana_job_status`.

Slack user `U08GAPUDHNF` linked `grebmann.zana-ide.com` to `grebmann-ltmmfjc.internal.salesforce.com` through the account-owned Connect flow and approved access locally. Zana for Slack reports `Connected`. Private channel `#zana-slackbot-test` (`C0C5MT2QJAJ`) contains only the operator and Zana app and maps to Project `slack-bridge-demo` on that computer with Codex / `gpt-6-astra` and concise Slack answers.

The live acceptance test completed on 30 September 2026. Slackbot first called `zana_list_projects`, confirmed the exact mapping, then called `zana_launch_job` once with a task that prohibited commands and file changes. Local admission created one thread, the request settled, and Slack confirmed the root, status, and answer deliveries. The private thread contains the exact final answer: **“Slackbot Zana integration verified.”**

A production compatibility issue found during activation is fixed in `website/slack/api.mjs`: this Slack workspace ignores or rejects JSON arguments for simple Web API read methods such as `users.conversations` and `conversations.info`, so those methods use form encoding while view and message writes retain structured JSON. Release v65 contains the fix and the focused service tests cover both membership reads.

Multi-user behavior is implemented through separate Slack identity → account/domain → computer links. Before announcing broad availability, repeat the live test with a second person, their own Zana account/domain, and a separate private test channel.

Selective Project import creates a private `zana-<project-name>` channel only for an explicitly chosen Project. Optional prefixes are supported; a stable suffix is added only when Slack reports a naming collision. The owner selects one default machine, provider, model and answer-sharing policy. Existing channels are retained. The hosted proxy rejects public channels, names without the Zana marker, foreign invitees, and mutations of channels created by another account link.

The first live sync completed for all 38 Projects exposed by the connected desktop. Slack visibly lists the generated `zana-…` channels together; opening `#zana-grebmann-spike-design-f6b4eb` confirmed it is private and contains only the linked owner plus Zana. Slack custom sidebar sections are personal and have no app API, so the common prefix provides consistent grouping and each user may move the channels into their own Zana section.

### Internal Slack support findings — 30 September 2026

Start with [#slack-app-approvals](https://salesforce.enterprise.slack.com/archives/C071ANXT0UV). The [official process canvas](https://salesforce.enterprise.slack.com/docs/T026QPGMQ/F072J11V60Z) asks people to follow the channel process, avoid tagging reviewers, and avoid DMs until required information is complete. It recommends Slack Sandbox via the Okta **Slack Sandbox (New)** tile for testing. The channel details identify Jake Emens as its manager.

[Evelin Castro Medina](https://salesforce.enterprise.slack.com/team/U0AA0TETYDB) handled a closely matching installation failure in [this August 11 thread](https://salesforce-internal.slack.com/archives/C071ANXT0UV/p1786455251121829?thread_ts=1785065112.965009). She explained that sandbox apps auto-approve and instructed the requester to select **Salesforce SandBox** when creating the app. The requester confirmed resolution. [September 7 guidance](https://salesforce-internal.slack.com/archives/C071ANXT0UV/p1788750435499299?thread_ts=1787960615.579779) repeats the sandbox auto-approval expectation. These sources do not prove why our account is blocked; verify the correct sandbox identity and account access before assuming a manual review is required.

Suggested support question (draft only; not sent):

> Zana app A0C5F0XK3TP was created under Internal-Sandbox T04SR5XV56X (BT Internal Sandbox), but Slack says my account cannot install apps and offers Request to Workspace Install. Your guidance says sandbox apps auto-approve. Could you confirm whether this is the correct sandbox workspace and whether my account needs different installation permissions? This is for testing Slackbot-triggered local agent jobs with synthetic data.

## Verification

Domain onboarding validation (30 September 2026): 80 focused Slack/Connect UI tests pass. Modified modules have 92.91% statement / 87.40% branch coverage; the new domain parser/onboarding module has 100% coverage. Website TypeScript and Next production build pass. The built-Electron Slackbot spec now requests a domain connection through signed MCP, approves it through account HTTP, activates the actual local plugin, and proves a single job launch across retries through the real TLS Connect tunnel (passed; 10.7-second test body). Slack API and model responses in that spec are fixtures. A separate real BT Internal Sandbox acceptance test now also passes through Slackbot, the hosted MCP service, Zana Connect, the installed local bridge, Codex, and confirmed Slack delivery.

Run website Slack/runtime tests and the plugin's tests/typecheck. The opt-in production-boundary spec loads the real separately installed plugin source:

```sh
ZCC_SLACK_BRIDGE_DIR=/absolute/path/to/slack-bridge-2ff2 pnpm test:e2e -- e2e/slackbot-mcp.spec.ts
```

It uses isolated HOME, TLS, the real Connect tunnel, signed requests, actual plugin admission and an ACP fixture, with no real Slack posts or model spend. It asserts discovery, one launch across retries, completion/status, the visible thread and revocation. Run live mode/reasoning and Memory suites against an attached app with a usable host and running Memory plugin.

Official references: [Slackbot MCP setup and signed identity](https://docs.slack.dev/ai/slackbot-mcp-client/), [Slack app approval](https://docs.slack.dev/ai/slackbot-mcp-client/admin-approval/), [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
