# Project actions from Slack: `/zana`

Implemented in 0.6.0 on 27 September 2026. Plugin source: `~/zcc-workspace/extensions/slack-bridge-2ff2`.

## Interaction design

One command provides a discoverable entry point in Slack’s command autocomplete. `/zana` opens the existing launch form; `run <project> <task>` prefills it. The owner confirms **Start agent** after seeing the Project and destination channel. This matters when invoking a command in one channel while selecting a Project connected elsewhere. It also keeps the machine, provider, model and sharing policy in the locally saved connection.

`/zana run . <task>` selects the Project connected to the invoking channel. Explicit names are case-insensitive exact matches, with single or double quotes for spaces; exact IDs take precedence. Ambiguous names ask for an ID or the picker. No fuzzy matching or local path lookup can silently choose a different Project.

`projects` lists only connected names, IDs and channels. `status [project]` reports running, attention and recent counts from current bridge bindings. These replies are ephemeral, with a link to Home. `connect` opens the existing setup handoff. `help` explains the commands. `new` is a picker alias.

Custom slash commands do not work inside Slack message threads. Follow-ups, Stop and mute/unmute stay in the existing conversation via explicit `@Zana` mentions or task controls on Home. The implementation does not offer a Project-wide Stop operation or execute arbitrary shell commands.

## Request handling

The official Socket Mode client delivers `slash_commands` payloads through the existing `slack_event` listener. The WebSocket is authenticated by the app connection. The handler checks enabled configuration, installation team, linked owner and, when present, `api_app_id`. Slack’s Socket Mode example omits `api_app_id`, so absence is accepted on this authenticated transport; a mismatched value is rejected. This is not an HTTP webhook verifier.

Read replies use the Socket Mode ACK payload directly. Preparing a launch uses cached Project names and synchronous bounded SQLite operations before acknowledgement, with no network wait. The handler validates a bounded trigger and task, saves the draft, acknowledges, then opens the form using the trigger. It never calls or stores the supplied `response_url`. If a modal fails to open, the acknowledgement provides a recovery path and Home shows a notice.

A launch draft ID hashes the installation, owner and trigger. Replayed triggers find the existing draft and do not open another form, including after restart. Raw triggers and response URLs are not persisted. Draft retention, expiry and caps reuse Home’s existing store (50 open drafts, 1,000 total forms). An abandoned draft never launches; it expires after 15 minutes. This is bounded duplicate suppression, not a claim of unlimited exactly-once delivery.

Submission uses the same saved modal identity, owner, route snapshot, policy revalidation and durable queue as Home. The destination must still match its saved Project, channel, host, provider, model and sharing policy. Only after Slack confirms the channel’s root message does the existing admission path launch an agent. Ambiguous posts and dispatches require inspection instead of automatic repetition. Existing concurrency limits, internal-channel membership checks and execution authorization remain authoritative.

## Slack configuration

`slack-app-manifest.json` adds one `features.slash_commands` entry and bot scope `commands`. The command is `/zana`, escaping is enabled, and the Request URL is omitted because Socket Mode is enabled. No new public endpoint, history scope or user token is needed.

For an existing installation, create the command in the app settings, then reinstall in the intended Slack workspace. Command names are not namespaced by app; another installed `/zana` can conflict.

## Verification

- Plugin 0.6.0 rebuilt, path-installed and running; connection and Home publication healthy.
- TypeScript passes; 123 tests pass across 12 files.
- Coverage: 93.31% statements, 90.86% branches, 89.56% functions, 94.46% lines. New parser/reply module has 100% statement, function and branch coverage; modified Home controller exceeds 93% branch coverage.
- Tests cover name/ID resolution, quotes, current-channel selection, malformed/oversized input, wrong owner/team/app, disabled configuration, private responses, filtering of Projects and status, absence of response-URL access, form caps, durable trigger replay, ACK ordering, identity changes during ACK, modal failure and a confirmed launch through the existing queue.
- The transport test uses a real local WebSocket with the official Slack SDK and checks the actual `slash_commands` ephemeral ACK envelope. The Web API and execution host are mocked in automated tests; this does not substitute for a real Slack trial.
- `/zana` is registered in the demo app. The final Slack reinstall/authorization and live slash-command trial remain pending.
- Installed Electron Slack Bridge panel showed **Connected**; **Refresh Slack Home** returned “Home refresh requested,” and the CLI confirmed successful publication with no Home error. No Project connection changed.
- Required `live:mode-reasoning` run: **53 passed / 1 failed / 1 gated skip**, 164.78 seconds. The failure was again `cli-agent codex executionState interactive`: “CLI agent exited before becoming alive.” One unchanged focused rerun **passed** in 1.92 seconds. The broader suite is not fully green; the intermittent CLI issue predates this change and remains unresolved. Slash launches use the existing Modern-thread path, but a real slash launch is still pending activation.
- Required `live:memory` was invoked; the runner reported 2 passed / 1 skipped, but integration bodies finished in 49ms because the Memory prerequisite was unavailable. This is **not** successful live Memory verification.
- Slack’s final **Allow** screen is open in Chrome. It adds only `commands` to existing scopes and includes acceptance of the app’s terms; confirmation was requested before clicking it. No live slash-command result is claimed.

## Trial runbook

1. Finish reinstalling the demo app with the added `commands` scope.
2. In `slack-bridge-demo`’s main composer, send `/zana help`, `/zana projects`, and `/zana status .`; verify private replies and the connected Project name.
3. Send `/zana run . Reply with exactly: Slash commands are ready. Do not modify files or run commands.`
4. Confirm the Project, channel and task prefill. Cancel once if testing cancellation; no channel task or agent should exist before submission.
5. Submit **Start agent**, observe **Request queued**, then the channel task and delivered answer.
6. Confirm the new request and answer delivery are settled/sent in the plugin diagnostics; use its canonical Slack link to inspect the thread.
7. Try an unknown Project and `/zana connect`; verify actionable errors/setup without changing connections.

## References

- [Slack slash commands](https://docs.slack.dev/interactivity/implementing-slash-commands/): payloads, three-second acknowledgement, modal triggers, thread limitation and command name collisions.
- [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/): authenticated WebSocket and slash-command response envelopes.
- [App manifests](https://docs.slack.dev/reference/app-manifest/): slash command declaration and optional URL.
- [Modal updates](https://docs.slack.dev/reference/methods/views.update/): stable input IDs preserve entered values when changing Projects.
