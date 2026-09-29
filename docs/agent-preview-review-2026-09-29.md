# Agent preview fixes and review — 29 September 2026

Fixed the four confirmed file-preview defects in the working checkout, and corrected the agent guidance for web/localhost previews. The installed `~/.agents/skills/zcc-browser/SKILL.md` was also updated: it still instructed agents to call retired browser MCP tools.

The implementation changes have been tested in privately built Electron apps. The running installed app has not been replaced or restarted; its UI fixes and new injected guidance take effect when the updated build is launched. The installed skill correction is already on disk.

## File-preview repairs

| Defect | Repair | Evidence |
| --- | --- | --- |
| Requests disappeared while Inbox or another non-agent view was open | One app-lifetime collector buffers requests independently of views | Electron: request two files from Inbox, return to the thread, see the latest and switch to the other |
| Multiple mounted views duplicated requests; only one queued item drained | Dispatch once per consumer, retain one queue, drain all pending requests | Electron: two thread panes, first then second preview selects the second; React tests cover same-thread consumers and deferred readiness |
| A missing file left valid previews stuck on its error | Clear obsolete error/content when starting a new read; ignore cancelled reads | Electron: missing file followed by a valid report recovers |
| Previewing an edited, already-open file showed old content | Explicit preview requests increment a local refresh revision; tab identity is preserved | Electron: edit a report and request it again, updated content appears |

The queue is bounded to 64 threads and 16 distinct files per thread. Repeated requests for the same source/path coalesce, retaining the latest line and request order. The refresh revision survives server tab echoes but is not sent in the tab contract. Ordinary conversation updates keep the document DOM and scroll position; explicit refreshes also reset video and plugin opener state.

Main implementation:

- `apps/app/src/components/thread/secondary-panel/useThreadOpenFileSignal.ts`
- `apps/app/src/App.tsx`
- `apps/app/src/components/thread/secondary-panel/threadSecondaryPanelState.ts`
- `apps/app/src/components/thread/secondary-panel/threadTabsContract.ts`
- `apps/app/src/components/thread/secondary-panel/ThreadFilePreviewTab.tsx`
- `apps/app/src/views/threads/ThreadDetailView.tsx`
- `apps/app/src/components/AgentSessionView.tsx`

## Browser-preview review

Confirmed instruction gaps:

1. CLI launch guidance did not include the file-preview instructions already present for Modern threads, and neither included an explicit default for web previews.
2. The installed legacy `zcc-browser` skill referenced retired `browser_open`, `browser_snapshot`, `browser_click`, and related tools.
3. The shipped `zcc-preview` skill told agents to install Browser Automation to display a webpage, even though core `zcc browser` supports displaying a URL without that plugin.

Modern and CLI agents now share `IN_APP_PREVIEW_GUIDANCE` from `packages/domain/src/preview-guidance.ts`. It directs agents to use `preview_file` for files, the in-app browser for web/localhost previews, and explicit in-app selection when using computer-use tools. It also tells them to disable dev-server auto-open behavior (`--open`, or `BROWSER=none` where supported). External Chrome/Edge/OS browser launches require an explicit user request; unavailable in-app browsing should produce an explanation and URL.

A current `zcc-browser` skill is now shipped in the built-in catalogue. It documents host/instance/generation/thread discovery, `zcc browser create --url ... --reveal`, reusing/revealing tabs, and the focused-thread reveal behavior. The CLI browser guide and `zcc-preview` skill agree with it. The installed legacy copy was replaced atomically; its previous contents were backed up to `/var/folders/w2/zmzw89qx02z6lv7xl3nzb2cm0000gn/T/zcc-browser-legacy-go2gww0c.md`.

The core browser create/reveal path keeps the page inside Electron. A separate intentional UI behavior remains: plain HTTP link clicks open the OS browser; Cmd/Ctrl-click requests the side panel. That is in `apps/app/src/lib/in-app-browser-link-preference.ts` and was not changed. No affected agent thread or endpoint was supplied, so this review does not prove which command caused the reported Chrome opening. These guidance changes address concrete gaps, not a runtime prohibition on every external-browser command an agent might execute.

## Validation

- `pnpm typecheck`: passed.
- Focused unit/DOM/guidance suites: **120 passed across 12 files**. Preview implementation coverage: **89.05% statements, 82.35% branches, 94.09% lines**.
- Launch-argument golden suite: **291 passed**, 54 snapshots updated. Programmatic comparison confirmed every changed snapshot differs only by the new shared preview guidance.
- Final component DOM rerun after strengthening cancellation/video-refresh assertions: **11 passed**.
- Built Electron: **12 passed** covering initial recovery scenarios, CLI MCP preview/confinement, Markdown/images, document scrolling, desktop browser broker, and the three Job Team launch surfaces (UI, CLI, Modern).
- Final expanded recovery spec: **4 passed** covering multiple queued background previews, split panes, read-error recovery, and edited-file refresh.
- Live attached app: **54 mode/reasoning launch checks passed**; **desktop browser test passed** (create/acquire/CDP/capture/release/close and scoped cookie-import behavior). These exercise the existing attached production runtime, while the deterministic Electron tests exercise the newly built code.
- `pnpm live:memory` was attempted after the launch suite. Its test runner reports success by returning early, but the Memory plugin is absent from the attached app. **Live Memory retrieval is unverified**, not a passing functional check.
- One broader, unrelated test still fails: `host-session-tools.test.ts:77`, library document write success. Preview tool/guidance tests pass; the library implementation/test was not changed here.

Final Electron artifacts: `e2e/.artifacts/runs/1790697629892-6904-8fe41609`.
Combined 12-test artifacts: `e2e/.artifacts/runs/1790697283887-59268-19f5fb4a`.
The first split-pane fixture attempt failed because navigation overwrote its seeded layout before reload; seeding after navigation fixed the fixture. The final split-pane check passes.

Original failing review probes remain under `e2e/.artifacts/runs/1790696692370-1209-75046864/review-probes` (source copies with `.txt` suffix), with failure traces/screenshots in that run. The original collector/read-state defects predate this repair; relevant logic traces to August 2026.

## Limits

File-open buffering survives navigation within a renderer lifetime. It is not durable across renderer disconnection/restart. The server's `delivered` field still counts connected WebSockets, not UI acknowledgments; the tool response is not proof a person has viewed the file. Browser reveal intentionally does not change the focused thread or bring the app window forward. No live-model comparison of preview-tool selection was performed.

Existing unrelated working-tree changes were preserved. No commit, push, or installed-app replacement was performed.


## Follow-up: three additional small fixes

The follow-up review found and fixed three more reproducible defects:

1. **Whole-file previews retained old line highlights.** A request with no line number omitted the field, so `addClosableTab` preserved the previous line focus. Markdown could stay in numbered source view instead of returning to its rendered document. `tabFromOpenFile` now explicitly clears line focus with `null` for both workspace and thread-storage requests. The existing tab identity is retained.
2. **Open with leaked across file types.** `ThreadFilePreviewTab` kept its local opener override as React state while the component was reused across tabs. Selecting Host preview for `.md` therefore also overrode the default Docs opener for `.mdx`, and changes to an explicit `openerKey` were ignored. Local selection is now scoped to file/thread/project/storage identity and the explicit opener. Each extension's saved preference still applies when visiting another file.
3. **Browser popups opened in unrelated split panes.** The native scoped event includes its source `tabId`, but `useInAppBrowserPanel` ignored it. Every mounted thread pane added a copy. The hook now checks current browser-tab membership before accepting a native popup. Callback and tab-membership references stay current through rerenders, and subscriptions are removed on unmount.

Each defect failed its new regression test before the implementation repair. Final focused tests: **56 passed across 6 files**; changed preview-module coverage **95.04% statements, 87.37% branches, 97.61% lines**. `pnpm typecheck` and the attached-app `pnpm live:browser` check passed.

Built Electron confirms all three new behaviors: line-focused request followed by normal preview restores rendered Markdown; a native `window.open` from a loaded page opens a tab in only its owning split pane; switching `.md` → `.mdx` → `.md` respects separate opener preferences. Existing background delivery, missing-file recovery, edited-file refresh, CLI MCP preview, browser broker, thread inspector, and document scrolling checks also passed.

The broader Electron run had **8 passes and 3 failures** initially. Two were errors in the new test fixtures: a blank New Tab page has no native WebContents until navigated, and the isolated catalogue excluded the Docs plugin needed for Open with. Both fixtures were corrected and their targeted reruns passed. The third remains an unrelated prerequisite failure in `browser-inspector.spec.ts:49`: its CLI scenario cannot find the named agent card's Follow button, before any browser is opened. No production launcher or agent-board code was changed in this follow-up.

Artifacts:

- Combined run: `e2e/.artifacts/runs/1790699421598-12141-db1f5d46`.
- Passing native popup/split-pane rerun: `e2e/.artifacts/runs/1790699551801-26253-2c0c22c1`.
- Passing opener-preference rerun: `e2e/.artifacts/runs/1790699606073-33646-6797a9d2`.

These additional code changes are in the checkout and privately built test apps; the running installed app has not been replaced.
