# App responsiveness regressions

The October 2026 freeze audit found unbounded renderer work, synchronous plugin
callbacks and filesystem operations, growing JSON stores, SQLite lock waits,
archive scans, Tasks reconciliation, event accumulation and overlapping polling.
The terminal-specific contracts are in [terminal-freeze-regressions.md](terminal-freeze-regressions.md).

## Runtime contracts

- Search highlighting uses returned match offsets; it never executes a search
  regex in the renderer. New queries, clear and unmount invalidate old responses.
- Highlighting is limited to 16,000 characters. Unknown languages render escaped
  text. Large documents show at most 64,000 characters or 1,000 lines before
  Markdown parsing, with access to the full source through Copy full text.
- Diffs admit at most 32,000 characters and 500 lines per side, including when
  the dependency falls back after worker failure. Admitted diffs use virtual
  rendering with 80-row pages; larger diffs show bounded original/modified text.
- Plugin server imports, factories and callbacks execute in dedicated workers.
  Startup has a ten-second deadline; stalled callbacks lose their worker after
  the heartbeat deadline. SDK authority remains in the product server. Private
  database transactions execute inside the plugin worker. Preserve synchronous
  service methods, Promise returns, live registry dispatch and unsubscribe handles.
- JSON persistence is atomic and serialized per trusted namespace across reload
  generations. Four workers service bounded namespace queues. New stores have an
  8 MiB quota, 1 MiB values and 10,000 keys. Existing larger stores may be reduced;
  legacy reads stop at 64 MiB. Corrupt files are preserved until explicitly cleared.
  Legacy storage writes acknowledge completed persistence through the broker.
- Read markers use indexed SQLite with 100,000-row retention; startup migration
  runs in a worker and retains the JSON backup. Thread queues admit 100 messages
  per thread and share the storage byte limits.
- Live SQLite lock waits are 25 ms. Marker updates retry atomic transactions
  asynchronously for up to two seconds. Product HTTP contention returns 503 and
  Retry-After. Bootstrap migrations retain their separate initialization budget.
- History text searches use two read-only workers, sixteen queue slots and
  five-second queue/query deadlines. A native query retains its slot until its
  worker actually exits, even after the caller times out.
- Tasks reconciliation pages relevant indexed attachments in batches of 100,
  yields between batches, cancels on shutdown and runs once at startup.
- Job details retain the latest 500 events with linear deduplication and truthful
  truncation. Scope guards reject late job and artifact responses.
- History, insights and execution polls schedule after completion. Unmounting
  prevents subsequent polls and stale responses from updating another scope.
- Filesystem confinement remains authoritative; async I/O additionally bounds
  listings, reads and canonical recursive traversal. Failed plugin scans preserve
  the previous running generation.

## Verification

```sh
node scripts/verify-responsiveness-coverage.mjs
pnpm test:e2e -- e2e/app-responsiveness.spec.ts e2e/docs-plugin-availability.spec.ts e2e/shared-legacy-plugins.spec.ts e2e/terminal-resource-lifecycle.spec.ts e2e/thread-terminal-panel.spec.ts e2e/terminal-view-navigation.spec.ts
pnpm test:e2e:jobteam
```

The coverage script enforces 80% statements, branches, functions and lines for
each listed helper. Worker entry execution needs the real Electron checks;
ordinary coverage instrumentation does not measure code inside those threads.

The responsiveness spec measures the real search renderer, large document copy,
6,000-file asynchronous deletion, native worker SQLite, plugin service transport,
a callback that loops after await, archive misses, competing SQLite writes,
legacy storage persistence, and a 4,000-line Git diff with forced worker failure.
Fixtures use private homes and temporary repositories, not personal files.

Recorded local results: 220 focused tests passed with 93.1% statement and 87.4%
branch coverage; all 29 isolated Electron cases across the listed suites passed.
The regex workload's maximum renderer timer gap fell from 4,057.8 ms to 12.6 ms.
Four-shell streaming measured 14.9 ms maximum delay with no observed long tasks.
These are workload measurements, not production latency percentiles.

Launch and plugin-instruction changes also require the live mode/reasoning and
Memory suites in AGENTS.md. Attach suites exercise the currently running app;
restart onto the new build before using their results to qualify new runtime
code. The repair's live run passed Memory but found two existing OpenCode low/high
catalogue targets absent from the installed CLI inventory; that catalogue drift
is separate from these responsiveness regressions.
