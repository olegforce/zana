# Daemon recovery and installation diagnostics

The desktop's product server and execution daemon run as separate Electron utility processes. An unexpected exit rejects outstanding work, makes subsequent IPC calls fail immediately, and offers **Restart Zana** or **Keep open**. Restarting is deliberate because it ends surviving agents. Failed project-list requests must not be presented as an empty project list.

Remote daemon upgrades download at most 16 MiB, expand at most 64 MiB, and enforce a 30-second network deadline. Only the four flat host-bundle files are accepted; links and unexpected entries are rejected. A staged executable must pass an exit-status protocol probe before the stable `runtime/join.mjs` symlink is changed atomically. Companion bundles stay in the same generation. The previous executable is retained until the replacement completes its server handshake; startup failure rolls back the pending generation. Failed attempts use bounded exponential backoff.

Service installations set `ZCC_HOST_SERVICE_MANAGED=1`; their manager restarts the stable entry. Background-only installations spawn a replacement and refresh `host-daemon.pid`. Repair stops launchd/systemd first. An unmanaged PID is signalled only if its command and start time still match the expected daemon. Desktop lock takeover also requires a recorded matching process identity. A live legacy PID-only lock requires stopping its owning app or service; it cannot safely be killed automatically.

Core warnings and errors are recorded under the data directory's `logs/` in `desktop.log`, `server.log`, and `host-daemon.log`. Each role keeps three files, approximately 2 MiB each, with private file permissions, credential redaction and a bounded write queue. The startup record includes the runtime executable and Node/Electron versions; a streamed SHA-256 fingerprint identifies the actual bundle even when release versions are equal. Logging errors never block startup. These diagnostics do not capture terminal transcripts or arbitrary object graphs. Sudden OS kills may lose the last queued log messages; the surviving desktop records utility failure.

## Dependency maintenance

DOMPurify is pinned to 3.4.16 and older transitive uuid versions are overridden with compatible CommonJS-capable 11.1.1. `decode-uri-component@0.2.2` has a committed pnpm patch backporting the upstream 0.5.0 bounded decoder while retaining CommonJS and plus-to-space handling.

Two version-based audit alerts can still be returned:

- [GHSA-vcc3-ghjq-m6fr](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr): the decoder patch is verified with a large malformed input and compatibility cases in `scripts/dependency-security.test.ts`.
- [GHSA-cp6q-959q-f8rh](https://github.com/ueberdosis/tiptap/security/advisories/GHSA-cp6q-959q-f8rh): the resolved Tiptap 2.27.3 package already defines `__proto__` as an own data property. `plugins/tasks/tiptap-security.test.ts` verifies its prototype and ProseMirror DOM serialization. Do not force a Tiptap major upgrade solely to hide this version-range alert.

The audit alerts are not globally suppressed. Recheck these exceptions when the upstream packages or patches change.

## Verification

- `apps/server/src/services/hosts/host-self-update.integration.test.ts` starts a real bundled daemon speaking the previous protocol, serves the current artifact, and proves replacement/handshake for both restart ownership modes.
- `e2e/runtime-recovery.spec.ts` kills only an isolated app's server/daemon, verifies the recovery dialog and persisted projects, and probes the served daemon artifact from Electron.
- `e2e/runtime-isolation.spec.ts` verifies SQLite while Node and Electron preparation run concurrently.
- Run `pnpm test:e2e -- e2e/runtime-recovery.spec.ts e2e/runtime-isolation.spec.ts` for a private production build.
- Run live launch and Memory suites from a host shell, with `ZCC_SERVER_URL` set explicitly when both production and development apps are running. A missing Memory plugin is a missing validation prerequisite, even if the suite reports passed tests after returning early.
