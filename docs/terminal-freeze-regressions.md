# Terminal freeze regressions

The October 2026 terminal freeze investigation found blocking project scans,
unbounded regular-expression execution, synchronous tmux probes, orphaned panel
shells, concurrent-open races, output persistence amplification, and hidden
terminal rendering work. The fixes and their regression boundaries are below.

## Hidden xterm fallback rendering

`patches/@xterm__xterm@6.0.0.patch` skips `DomRenderer.renderRows` when the xterm
element has no `offsetParent`. The patch is registered in `pnpm-workspace.yaml`
and `pnpm-lock.yaml`; it changes both distributed JavaScript entry points and
the corresponding TypeScript source.

Releasing a hidden WebGL addon restores xterm's DOM fallback. In xterm 6.0.0,
that fallback immediately renders during resize/selection updates even when
its host is hidden. `WidthCache._measure` returns zero for every character in
that state, and zero results never enter the cache. A four-terminal Electron
profile recorded about 3.3 seconds in repeated character layout measurements,
including a 2.45-second long task. Skipping that invisible paint preserves the
buffer; the normal visible refresh paints it after the terminal returns.

When upgrading xterm, check whether upstream now guards this path before
removing the patch. Run the sustained-output regression with GPU release and
reveal, not just terminal construction or a mocked WebGL addon.

## Resource and scheduling contracts

- Explicit panel Close requests shell termination and waits, for at most four
  seconds, for the roster to confirm exit before releasing the view. Interactive
  shells may ignore TERM until the existing process-tree hard kill runs. Failed
  closes retain the tab and display the failure. Hide/navigation preserve shells;
  a `shared-terminal` view reference does not own the shell.
- Agent opens serialize per owner. Main validates that owner against the project
  and reserves one of three slots before asynchronous validation/spawn. Failed
  launches release reservations; exited shells free capacity. Pending requests
  and inactive-thread intent buffers are bounded.
- Hidden terminals retain bounded pending text without parsing it. Visible xterm
  writes use slices of 16,384 UTF-16 code units and at most two outstanding parser
  writes. Pending text is limited to 262,144 code units per session and 8,388,608
  code units in total. An omission is announced when a trimmed terminal becomes visible.
- Snapshot recovery shares four concurrent slots, cancels queued/hosted reads,
  and retains the existing ten-second replay deadline. Concurrent per-project
  hosted roster reads share the same in-flight request. WebSocket dispatch routes
  typed events only to subscribers of that type.
- Enrolled-host output persists one final bounded tail per affected session per
  acknowledged batch. Receipt deduplication, cursor order, commit atomicity and
  rollback remain intact. Producer pause/resume starts before queue overflow;
  terminal overflow stops the offending shell with an explicit reason while
  retaining unrelated work and queued authoritative events.
- Project walks use asynchronous I/O and file, entry, depth and canonical-directory
  bounds. Regex matching/compilation runs in at most two workers, with a 500 ms
  per-file deadline and a ten-second overall search deadline. Partial/time-limited
  results are marked truncated. Tmux availability probes are asynchronous and
  share pending work; synchronous spawn assembly only reads the warmed cache.

## Verification

Run the production-boundary regressions with isolated homes and native packages:

```sh
pnpm test:e2e -- e2e/terminal-resource-lifecycle.spec.ts e2e/thread-terminal-panel.spec.ts e2e/terminal-view-navigation.spec.ts e2e/tmux-instance-isolation.spec.ts
```

The sustained-output test runs four actual shells, checks retained output and
UI switching, measures renderer timer delay, and attaches a CPU profile. Its
maximum-delay assertion is the performance regression guard, separate from
Playwright's click deadline. All shells and profiling resources are cleaned up.

Owner-launch changes additionally require the Job Team owner launch specs and
the live mode/reasoning and Memory suites documented in `AGENTS.md`. Live attach
checks exercise the app currently running, so restart onto the new build before
using their results to qualify the changes.
