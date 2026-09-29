# BB source attribution

The desktop target identity in `apps/desktop/src/window/shared-target.ts` is
adapted from BB `apps/desktop/src/server-target.ts`. The local_path source
model in `packages/domain/src/project-sources.ts` follows BB's
`packages/db/src/data/project-sources.ts`, adapted to Zana's serialized project
store. The original MIT notice is preserved in [BB-LICENSE](BB-LICENSE).

Machine enrollment attribution is also recorded in
`services/machine-bootstrap/NOTICE.md` and `website/connect/NOTICE.md`.

The bounded socket send queue in `apps/server/src/http/bounded-socket-sender.ts`
is adapted from BB `apps/server/src/ws/hub.ts` (`sendOrQueueTerminalPayload`,
`flushTerminalSocketQueue`, and cleanup). Zana applies it to product events,
adds a shared memory budget, and retains BB's ordered drain / 1013 disconnect
behavior for stalled consumers.

The browser socket lifecycle in `apps/app/src/lib/product-ws.ts` adapts BB's
`apps/app/src/lib/ws.ts` reconnect notifications and idle-connection probing.
Zana reconciles product snapshots after reconnect and never resends mutations.

The confined HEAD blob lookup in `packages/host-workspace/src/git-file.ts`
adapts BB's `readGitBlob` / `readFileFromGitRef` helpers. Zana retains its bounded
Git process runner, registered-source authorization and revision check for discard.

The failed-start cleanup in `apps/server/src/http/terminal-start-recovery.ts`
adapts BB's terminal session lifecycle: reserve ownership before dispatch and
close after an ambiguous acknowledgement. Zana keeps the record when the host is
offline so the process remains addressable instead of retrying the launch.

Durable terminal records in `apps/server/src/http/persistent-terminal-sessions.ts`
adapt BB `packages/db/src/data/terminal-sessions.ts`'s persisted ownership and
`daemonSessionId` lifetime model to Zana's bounded registry and SQLite driver.
Zana retains the same record when its product server reconnects to a surviving
daemon and closes stale records when that execution daemon has restarted.

`plugins/monaco-editor/server.mjs` adapts BB
`plugins/monaco-editor/server.ts`'s SDK-based read/write handlers. Target resolution
in `apps/server/src/http/plugin-project-files.ts` follows BB's source/environment
resolution, with Zana's registered-project validation and host-side confinement.
The revision comparison and atomic save execute on the selected host.

Host event delivery follows BB `apps/host-daemon/src/event-sink.ts`'s rule that
delivery succeeds only after a server response. Zana adds correlated batches,
a durable last-batch receipt per host, and a bounded queue that stops execution
with an explicit error if disconnected history exceeds capacity.

### Plugin execution on enrolled machines

`apps/host-daemon/src/plugin-host-manager.ts`, `plugin-host-worker.ts`,
`serial-lane.ts`, `operation-environment.ts` and the worker/manager tests are
adapted directly from BB's files of the same names (MIT). Zana uses its existing
enrolled-host protocol and artifact cache, adds compatibility for installed
method-registration host entries, and packages the worker alongside the joined
daemon. `apps/server/src/plugins/plugin-host-rpc.ts` follows BB's call/cancel/
dispose routing. Host IDs and artifact generations are authorized by the server;
plugin-local process state remains on the selected machine.

The host-subpath resolver and schema-entry fallback in
`packages/plugin-build/src/build-plugin-host.ts` are adapted from BB's builder.
An installed public host SDK is bundled when available; isolated plugins can
use the schema-entry fallback. Zana's root SDK keeps its existing registration
contract so older plugins remain compatible. Distributed Electron and daemon
bundles carry BB's complete MIT notice.

The scoped desktop CDP regression suite in `apps/desktop/src/desktop-browser-cdp.test.ts` is ported from BB’s corresponding desktop test. It carries the full upstream MIT notice and complements the real packaged Browser Automation qualification.

The BrowserView navigation/title notifications used by the scoped CDP bridge are ported from BB’s `wireWebContents` in `apps/desktop/src/desktop-browser-view.ts`. They ensure new automation targets finish initialization after their first navigation.

`apps/host-daemon/src/packed-native-pty.ts` adapts the spawn-helper discovery from
BB's `apps/host-daemon/src/terminals/terminal-manager.ts` (MIT). Joined terminals
now use the same pinned native `node-pty` package as BB. Zana embeds upstream
portable prebuilds plus the package's MIT license in the existing join bundle,
materializes only the current platform into a private directory, and removes it
on normal process exit. This preserves the existing updater archive format and
does not copy or rebuild the desktop's installed addon. This establishes terminal
I/O support; full remote CLI Agent authorization and lifecycle remain separate.

`apps/host-daemon/src/cli-callback-proxy.ts` adapts BB's
`apps/host-daemon/src/machine-auth-proxy.ts` loopback authority checks, rejection
of browser-origin requests and ownership of listener sockets. Zana restricts the
proxy to one session capability and an exact MCP/hook route set, rejects socket
tunnels, and bounds bodies, replies, concurrency and request lifetime. Enrollment
credentials are added only by the daemon's fixed-route HTTP client. The product
owner independently checks the registered session, host and daemon lifetime.

The history protections in `packages/db/src/data/conversation-output.ts`,
`apps/server/src/services/threads/timeline-content-page.ts`, and the host event
ingestion gate follow BB's event pruning, retained-output storage and content
pagination at commit `fdd3de3b19b97e6cd1ef7300cbb54711431249d3`. Zana adapts
these to its event schema, keeps a hard 16 MiB database-read ceiling, and uses
its own product HTTP and React clients. The MIT notice is in [BB-LICENSE](BB-LICENSE).

`packages/db/src/data/conversation-pruning.ts` adapts the same BB revision's
`thread-pruning.ts`, `rate-limit-pruning.ts`, `resolved-item-pruning.ts` and usage
snapshot rules in `events.ts`. Zana uses its own schema, bounded two-pass usage
discovery and expression indexes for scoped completion lookups. It additionally
requires later completed output and conservatively preserves empty final text.
