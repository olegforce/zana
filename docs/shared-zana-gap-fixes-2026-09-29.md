# Shared Zana: necessary gap fixes — 29 September 2026

This follow-up implements the three code gaps from the BB comparison review. It preserves the approved deferral of secondary-machine CLI Agents and Squad/Team execution. Public two-physical-machine qualification remains open.

## Changes

**Goal and Scheduler recovery now uses durable launch evidence.** Check worker still reattaches an existing reserved session. When that session is absent, main can resolve the reservation from an exact project/principal/session match in the launch ledger: a denied launch, an observed exit, or startup evidence that the launch never reached the spawn phase. Recovery persists the outcome before publishing it, never creates a replacement worker, and keeps work paused or disabled. Missing, pruned, mismatched or ambiguous evidence stays blocked; absence from the process inventory alone is insufficient.

Implementation: `apps/server/src/services/launch/worker-recovery.ts`, the launch ledger, Goal/Scheduler managers, and their main-owned dependency wiring.

**Library moves now work between projects and the Global Library, including different machines.** A bounded durable transfer reserves both roots together, copies without overwriting, verifies destination hashes and metadata, then removes source entries with revision checks. Stable document IDs, binary contents and empty folders are preserved. Lost acknowledgements resume through the journal. Owner changes, collisions and external edits stop recovery while preserving evidence and files. Transfers are limited to 1,000 entries and 64 MiB; unrelated roots remain usable while an owner is unavailable.

Implementation: `apps/server/src/services/library/library-transfer.ts`, the existing root transactions and shared bounded queue. This closes a Zana plan gap; the BB review did not claim BB has an identical Library feature.

**Legacy plugins have an explicit shared-client boundary.** Browser and attached-desktop clients read the real owner's inventory, including change/reconnect refreshes. Legacy entries say **Owner desktop** and explain where to use/manage them. Shared clients do not load their native renderer code or offer consent, lifecycle or native settings controls. New installation stays on the owner desktop. Existing supported modern plugins retain their shared product services. This closes the misleading empty-inventory/unsupported-control gap; it is not full legacy plugin parity.

Implementation: the closed shared-product registry, `shared-extensions.ts`, `DesktopOnlyPlugin.tsx`, and the Plugins hub/marketplace surfaces.

## Verification

Logs are under `.zcc/artifacts/shared-machines-implementation/`:

- `gaps-unit-coverage.log`: 201 tests in 11 files pass. The new recovery helper, shared plugin adapter, desktop-only notice and multi-owner queue each report 100% statements, branches, functions and lines.
- `gaps-transfer-final-unit.log`: 60 tests in two files pass after the final transfer guards. Transfer coverage: 90.12% statements, 84.34% branches, 90.32% functions and 100% lines. Tests include lost acknowledgements at both markers, copying, both manifests, source removal and cleanup, plus collisions, owner changes and external edits.
- `gaps-regression-unit.log`: 107 tests in eight files pass across shared services, runtime events, launch coordination and agent Library consumers.
- `gaps-client-regression.log`: 130 tests in 23 files pass across the shared client and Plugins surfaces. These test groups overlap; their totals are not a unique-test count.
- `gaps-typecheck-final.log`: TypeScript passes. Scoped whitespace checks pass.
- `gaps-built-boundary.log`: seven of eight built-Electron scenarios pass, including native/browser worker recovery with no additional launch, legacy plugin inventory and denied native operations, launch reservations, shared services, and live mode/reasoning followed by Memory and Browser with no prerequisite skips. The cross-machine transfer assertions passed; the two-machine scenario later failed while setting up editor text, before disconnecting either daemon. It is not counted as a passing scenario in this run.
- `gaps-built-final.log`: all five Job Team scenarios pass, covering the UI, CLI Agent owner and Modern owner. The two-machine scenario reached reconnect/save, then failed only because the fixture's explicit clearing had reset its heading to a paragraph. The saved text was correct; the expected Markdown heading marker was absent.
- `gaps-built-two-machine-retry.log`: the complete two-daemon/native-browser scenario passes twice, in 48.5s and 48.8s, after explicitly restoring and verifying the fixture's heading. Run `1790671263489-51781-dc5f6bb3`, fresh private build `zcc-electron-test-vOFlHq`. Both repetitions include cross-machine binary/ID-preserving moves, owner isolation, offline operation, reconnect, unsaved drafts and stale-save rejection. The earlier failed runs are preserved and are not described as green.

The editor fixture now activates its window, explicitly selects and clears the existing body, verifies it is empty, and then verifies the replacement draft and its heading. This addresses the reproduced append-during-setup symptom. Offline persistence and conflict assertions remain intact; the focus-race explanation remains an inference.

## Release boundary

The public address `https://grebmann.zana-ide.com/` returned HTTP 200 with successful TLS verification during this follow-up. That is only a reachability/certificate check. No production deployment or Cloudflare change was made here.

An authenticated trial on two physical machines is still required for account isolation, revocation, reconnect, primary restart and rollback. A second accessible machine has been requested. Local two-daemon tests cannot substitute for that trial. Complete release qualification of the wider, heavily modified checkout is also outside this focused gap-fix sign-off.

Secondary-machine CLI Agents and Squad/Team execution remain deferred, as do development-server sharing, instance import and server relocation. The shared URL does not imply automatic copying of checkouts or primary-server failover.
