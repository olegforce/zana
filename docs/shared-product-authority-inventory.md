# Shared instance authority inventory

This records the current implementation boundary, not a parity or rollout claim.
The instance owner remains the original product server/desktop. A secondary desktop
opens its authenticated browser surface without the local product preload.

Release scope update (29 September 2026): the user deferred full secondary-machine
CLI Agent execution. Keep the existing primary-machine CLI path and explicit
unsupported-host rejection; the internal enrolled CLI engine is preparatory work,
not a required first-release capability. The user also deferred multi-machine
Squad/Team execution because its workers use that CLI launch path.
Existing primary-machine teams, shared definitions and execution records remain.
The shipped enrolled daemon omits the CLI execution handler. Team launch,
authorization, route discovery and UI source preparation reject secondary-owned
projects before creating workers or interpreting their paths on the primary.

| Product data / capability | Authority and transport | Qualification / remaining work |
| --- | --- | --- |
| Instance and address | Durable server UUID; Connect account-bound instance and execution-host grants | Local authenticated tunnel and PostgreSQL tests pass; public two-physical-machine trial remains |
| Projects and machine checkouts | Server `projects.json`, serialized CAS updates; additive `sources`; existing IDs unchanged | Two-daemon source registration, path confinement and execution markers exercised |
| Threads, environments, history, interactions | Server SQLite and product HTTP/WS; daemon owns runtime, provider login and checkout | Modern owner/tool bridge exercised; complete public reconnect/approval/artifact matrix remains |
| Project settings | Server `project-settings.json`, keyed by project ID; desktop reads the same runtime store | Source independent already; no per-checkout settings duplication needed |
| App settings, personas, teams, quick prompts | Instance owner’s service through the closed shared-product registry; project personas/teams/templates retain their original metadata host | Two clients share settings. Host catalogs use bounded acknowledged snapshots and preserve project override order across local and remote owners. Catalog/process isolation, precedence and invalidation pass the final 16-test built run |
| Inbox, saved items, suggestions | Product-server stores and explicit HTTP APIs | Reconnect reads bounded snapshots; no second scheduler or launch on reconnect |
| Job Team board and commands | Instance owner authorizes stored project, execution and version; explicit shared-product caller | All three launch surfaces pass the combined built run; the CLI fixture now explicitly selects its provider |
| Shell terminals | Selected host runs process; server stores session ownership and bounded output; client selects transport by session ID | Real two-daemon TTY detection, resize, input, Ctrl-C, machine-local HOME/cwd, 25 KiB output, fast exits and close-after-exit pass. The join artifact embeds portable node-pty prebuilds using BB helper discovery and shell fallback, preserving the updater format. Full remote CLI Agent launch remains a separate gate. SQLite retains ownership, output cursors and daemon lifetime across server restart; cursor-based replay deduplicates snapshot/live overlap and recovers gaps. Event batches commit durable receipts and publish only after successful commit; failed commits restore the in-memory records too |
| CLI Agent profiles | Owner-side planner/PTY coordinator; enrolled host performs registered-root discovery | Version, role and model discovery uses the selected host's HOME, canonical harness config and checkout. Main retains consent and launch authorization. Protocol 38 retains preparatory command types, preferences and session callbacks, but the shipped daemon does not install the CLI launch handler. Authenticated direct CLI commands are rejected on both packed machines while real remote shell terminals continue working. Secondary-machine UI/API selection rejects before side effects; full CLI lifecycle/adoption is deferred |
| Files and Git | Selected registered source or pinned environment; host repeats realpath confinement; saves/discard use revisions | Browser Monaco editing saves on B without changing A; large HEAD reads and images pass through both real daemons. Symlink escape, stale-write and in-use source removal are denied |
| Legacy native worktrees | Primary desktop's existing main-authorized Git and filesystem handlers | Existing built worktree switching passes; exception is not exposed in the shared browser desktop |
| Library | Fixed original metadata owner from `projectMetadataLocation`; execution source never selects storage | Browser/native/plugin document edits and CLI/Modern tools share the runtime, bounded queue and recovery journal. Narrower Library confinement rejects links to private siblings. Search, folder creation, binary registration and Activity Feed reads use that owner. Same-root file/folder moves and deletes preserve IDs/binary bytes and recover after lost acknowledgements; cross-root transfers reserve both owners together and use a bounded durable journal, create-only copies, destination verification and revision-checked source cleanup. Both roots remain protected during interrupted work; refresh resumes it. External edits stop recovery without sweeping files away. Native and browser notifications fetch authoritative snapshots, including external filesystem changes. Bounded partial snapshots report each offline/unavailable owner and refresh on disconnect/reconnect; available roots remain readable, writable and searchable. Built two-daemon restart qualification passes. Bounded stale display records preserve unsaved drafts with explicit notices; built offline-save/reconnect/stale-save checks pass. Image and PDF previews use original-owner bytes in both clients. Scoped metadata updates remain usable when another owner is offline; legacy complete-list callers receive an error rather than a false empty result. Binary upload/create-only import (including 2 MiB browser uploads and collision rejection) passes the combined eight-test build. Cross-root transfer now preserves document IDs and binary bytes across projects/global roots, bounded to 1,000 entries and 64 MiB. Focused loss-of-ack tests cover markers, copying, both manifests, source removal and cleanup; built qualification is recorded below. Review/latest-version comparison, explicit merged save against the reviewed revision, copy draft and discard recovery are implemented; 41 focused checks pass with 100% lines/functions and 90.51% branches on the two UI components. Built native/browser conflict recovery, repeated concurrent edits, explicit discard and mobile layout pass in the ten-test protocol-36 build |
| Schedules | One instance-owned manager; global data plus `<original project.path>/.zcc/schedules` | Original-owner ProjectRecordStore with bounded async serialization, CAS and commit-before-publish. Disabled durable reservations with stable session IDs prevent repeated launches after lost acknowledgement; recovery reattaches known workers. Built foreign-owner CRUD/conflicts and reservation/exit checks pass. Check worker now resolves exact principal/project/session matches from durable denied, observed-exit or startup no-spawn evidence. No evidence or an ambiguous spawn remains blocked; recovery never enables a schedule. Secondary CLI execution remains deferred |
| Goals | One instance-owned manager; global data plus `<original project.path>/.zcc/goals` on its original host | Private metadata bridge, atomic revision checks and serialized commit-before-publish mutations. Built browser/desktop two-daemon CRUD and conflict tests pass. Launch reservations prevent replay after lost acknowledgements; unresolved reservations pause on restart. Native/browser Check worker verifies and reattaches known workers without launching again, qualified in the combined eight-test build. Missing inventory entries can now be resolved from matching durable exit/no-spawn evidence, without a replacement launch. Pruned, mismatched or ambiguous evidence remains blocked. Secondary CLI execution remains deferred |
| Follow-ups | One instance-owned manager; global data plus `<original project.path>/.zcc/followups` on its original host | Foreign records use the private runtime bridge and host atomic revision checks. The manager serializes mutations and publishes after commit, retains the last snapshot on failed refresh, and polls foreign records every 15 seconds. Desktop/browser two-daemon CRUD and external edit conflict pass; original owner never follows execution-source selection |
| Activity Feed | Git history and `.zcc/activity.jsonl` resolve the original metadata owner through private runtime operations | Async serialized read/append, atomic revision checks, exact lost-ack read-back, preserved legacy IDs and bounded acknowledged display caches. Focused tests/typecheck and the final 16-test built disconnect/reconnect/large Git output qualification pass. A subsequent in-place registry mutation fence is covered by eight focused tests and passes in the ten-test protocol-36 build |
| Plugin installation, server runtime, KV | Product server's `PluginService`, installation registry and `dataDir/plugins` | BB host manager/worker code now routes explicit machine operations with verified artifacts, generation fences, cancellation and cleanup; built two-daemon installation/worker, generation cleanup and schema-entry qualification passes. Monaco uses source-aware SDK file reads and revision-checked saves. Keep awake has an explicit machine selector. Legacy native-only consumers are explicitly gated in shared clients; public physical-machine qualification remains open |
| Legacy disk extensions | Native desktop compatibility tier; shared clients read the actual owner inventory through the closed registry and receive change/reconnect refreshes | Shared adapters suppress code loading and consent prompts; rows identify Owner desktop, with native lifecycle/settings controls unavailable. New installation stays on the owner desktop. This is an explicit first-release boundary, not full native-extension parity |
| Native windows, local credential stores, app update | Client desktop authority | Shared product surface excludes arbitrary IPC and local product preload. Narrow native conveniences need separate brokered capabilities |
| Provider credentials and source instructions | Executing host | Never copied into shared app settings; unavailable host/provider must remain visible |

Source anchors: `packages/contracts/src/shared-product.ts`,
`apps/desktop/src/ipc/shared-product-registry.ts`,
`apps/app/src/lib/product-client.ts`, `apps/server/src/project-settings-store.ts`,
`apps/server/src/services/projects/project-metadata.ts`,
`apps/server/src/http/library-via-host.ts`,
`apps/server/src/services/library/remote-library-tools.ts`,
`apps/server/src/services/{scheduler,goals,followups}/*-store.ts`, and
`apps/server/src/plugins/plugin-service.ts`.

The remote metadata gaps must be addressed with the fixed owner locator and
explicit host availability, or a separately verified metadata migration. Do not
silently redirect a foreign metadata path to a same-named folder on this machine.
Keep source-controlled instructions on the executing checkout, and shared product
settings in the instance store. Existing independent installations remain separate
unless the user deliberately imports or relocates their data.

## Plugin consumer audit (29 September 2026)

- Monaco: one shared installation; reads and atomic saves resolve the selected project source or pinned thread environment. Built A/B isolation and revision conflict tests pass.
- Keep awake: one shared settings panel; registered machine selection routes status/enable/disable to that host. A worker retention lease holds the process while awake and disposal stops it. Current focused UI and lifecycle tests pass; full packaged verification is still in progress.
- Browser Automation: uses the SDK host client. Packaged desktop and headless flows pass HTTP navigation, iframe snapshot, screenshot, JPEG preview, close and session cleanup. Desktop target notifications follow BB; owned disposable headless Chrome uses a mock keychain so private HOME does not stall network initialization. Public second-machine qualification remains.
- Tasks: filesystem access uses SDK host selection from the thread environment or explicit machine argument. A missing environment or environment host is rejected explicitly; 24 Tasks CLI tests pass with its workspace config.
- Workflows: source resolution validates the thread environment's project/root and uses the selected host.
- Memory, custom instructions and PostHog: product-instance KV/DB ownership.
- GitHub integration: commands run at the instance owner with that integration's credentials. This is a named integration authority, not the execution-host picker.
- Connect's bundled plugin host remains a placeholder; the working Connect transport is owned by the core service. No parity claim for that plugin or legacy native extensions.


## Machine identity and load bounds (29 September 2026)

- The CLI Agent SDK preserves an explicit machine selection through product HTTP and main authorization. Unsupported machines reject before spawn. Desktop uses the acknowledged **enrolled product host ID**, not the separate private terminal-transport ID, for authorization and local metadata classification. Eight built tests pass, including primary/unknown-host selection, all Job Team owners, live providers/Memory/browser and two daemons/two clients (`cli-machine-qualified-boundary.log`). Full secondary-machine CLI Agent execution remains disabled.
- Library and Activity Feed now cap aggregate owner work at four concurrent operations, with per-owner serialization, a 100-operation pending cap and a 64 MiB retained-request-string budget per queue. A busy owner cannot reserve the next slot ahead of unrelated ready owners. 82 focused tests and typecheck pass; all five built qualification tests pass (`shared-owner-bounds-boundary.log`), including agent Library tools, conflict recovery, mobile and two-daemon/two-client operations.

## Necessary review gaps — qualified locally (29 September 2026)

The [gap-fix report](shared-zana-gap-fixes-2026-09-29.md) records durable Goal/Scheduler recovery, cross-root Library transfers and the explicit legacy-plugin shared-client boundary. Focused coverage and TypeScript pass. Built native/browser recovery and denied native-plugin operations pass; all three Job Team owner surfaces pass. The final two-daemon/native-browser scenario passes twice with cross-machine binary/identity preservation, disconnect/reconnect and draft/conflict checks (`gaps-built-two-machine-retry.log`). Earlier fixture setup failures and their corrections are recorded in the report.

This closes those code gaps within the current release scope. It does not complete the public two-physical-machine trial or qualify every unrelated change in the checkout. Secondary-machine CLI/Teams and packages 09–11 remain deferred.
