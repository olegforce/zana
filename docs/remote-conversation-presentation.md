# Presentation for remote conversations

A conversation controlled from a remote chat cannot use Zana's desktop panels to deliver results. A connected desktop, visible thread or foreground window does not establish that the user can see it. Background work remains available.

## Current contract

The launching plugin persists `pluginMetadata.interactionSurface = { kind: 'remote', label: 'Slack' }` through the authenticated thread SDK before the first turn. `label` is display text; core never compares plugin IDs or labels. Only the thread's origin plugin namespace is authoritative. The constraint survives plugin unload and database reopen, and descendants inherit through their parent chain. Legacy bridge bindings are upgraded on plugin initialization, configuration and follow-up.

The server computes `desktopPresentation: false` for plugin configuration and invocation from that persisted context. Tool arguments cannot override it. Malformed declarations fail closed. Traversal is bounded; missing ancestors and cycles fail closed. An unknown initial thread remains compatible with the separate legacy PTY path.

Remote guidance takes precedence over desktop preview instructions, including when answer sharing is disabled. File preview and presentation-terminal tools are omitted from the host catalog and guarded at execution. Revealed browser creation and reveal calls return `presentation_unavailable` (HTTP 409); hidden creation, leases, CDP, capture and cleanup remain available. Remote browser snapshots do not create renderer tabs. Hidden CDP page creation/activation and popups do not reveal desktop content.

Plugin tools declare presentation requirements when registering:

```ts
// A tool whose only purpose is showing desktop UI:
{ name: 'show_panel', desktopOnly: true, /* schema, execute, ... */ }

// A tool combining data operations and desktop UI operations:
{ name: 'workbench', desktopOnly: ['ui.views', 'ui.command', 'ui.result'], /* ... */ }
```

The first form is omitted from remote catalogs and denied on stale invocation. The second keeps data operations available and gates the parsed top-level `action`, including schema defaults. Invocation context is host-stamped. Salesforce's UI operations use this declaration; its authoring, query and inspection operations remain available.

This is a product presentation contract, not an OS sandbox for shell commands or full-trust plugins. Plugins must annotate their presentation tools; agent guidance also covers CLI and visualization paths.

## User experience and current limits

The Slack bridge tells the agent where the user is interacting independently of whether answers may be shared. Normal answers use the existing sharing policy and fixed Slack destination. A queued post is not delivery confirmation. File contents, transcripts and raw tool output remain outside the current task-panel projection. The agent should explain that limitation and supply a useful permitted summary or accurate source link, without saying a local preview was shown in Slack.

Requested web previews can use the existing authenticated `share_preview` link. Localhost URLs and local file paths are not remote delivery. Library and Inbox persistence remain useful but cannot be the sole user-facing result.

Opening a Slack-originated thread manually in Zana does not change its controlling surface. This iteration does not add a control-transfer button or permit the agent to remove the remote constraint. A deliberate desktop handoff with turn-boundary routing is follow-on work, alongside a bounded code/document viewer and structured Slack questions. Ordinary mention follow-ups already work; native question and permission widgets still require Zana.

## Regression coverage

- `interaction-surface.test.ts`: persisted origin, inheritance, plugin absence, legacy upgrade, malformed context, no emitted desktop events.
- `host-internal.tool-call.test.ts`: invocation context cannot be forged in tool arguments.
- `plugin-agent-tools.test.ts`: catalog omission, stale calls, mixed tools, parsed action defaults.
- `desktop-browsers.test.ts`: remote reveal denied, hidden automation preserved, no persisted renderer tabs.
- Built Electron `slackbot-mcp.spec.ts`: signed Connect through the real bridge, remote file/browser guards with the desktop open.
- Built Electron `desktop-browser-broker.spec.ts`: hidden CDP create/activate followed by explicit desktop reveal; visible popup behavior.
- Existing file-preview recovery and all three Job Team launch surfaces remain regression checks.

The bridge change and the core change ship together. Reloading only the bridge updates agent guidance and persisted context; enforcement requires a desktop/server build containing these guards.
