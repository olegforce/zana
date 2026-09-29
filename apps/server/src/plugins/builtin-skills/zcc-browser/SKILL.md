---
name: zcc-browser
description: Open web apps, localhost endpoints, and web previews in this thread's in-app browser side panel. Use when the user should see a page or watch interactive QA. Keep previews inside Zana unless the user explicitly requests an external browser.
---

# Visible web previews

Use the in-app browser side panel for web previews, including development servers.
Do not launch Chrome, Edge, the OS default browser, or `open` / `xdg-open` / `start`
unless the user explicitly requests an external browser. With computer-use tools,
select the in-app browser explicitly. Start dev servers with browser auto-open
disabled: omit `--open` and use `BROWSER=none` where supported.

The supported core interface is `zcc browser`. Read `zcc guide browser` for its
current contract. Legacy `browser_open`, `browser_snapshot`, `browser_click`,
`browser_type`, and `browser_eval` MCP tools have been retired; do not call them.

1. Use `zcc status --json` for `currentThreadId` and `zcc machine list --json`
   to identify the connected desktop host. Use the current thread/session scope.
2. List its desktop instances with `zcc browser instances --host <host-id> --json`.
   Use a returned instance ID and generation. If several windows could be the
   user's intended target, resolve that choice rather than guessing.
3. List existing tabs first and reuse an appropriate preview. Otherwise create
   a visible tab, using the actual IDs returned above:

```sh
zcc browser tabs --host <host-id> --instance <instance-id> --generation <generation> --thread <thread-id> --json
zcc browser create --host <host-id> --instance <instance-id> --generation <generation> --thread <thread-id> --url 'http://localhost:5173' --reveal --json
zcc browser reveal <tab-id> --host <host-id> --instance <instance-id> --generation <generation> --thread <thread-id> --json
```

Creating/revealing a tab only reveals it when its owning thread is focused; it
does not switch threads or bring the desktop window forward. Keep using that
tab while the dev server updates it. A localhost URL refers to the browser's
host, so a server on another host needs an explicitly reachable URL or tunnel.

For clicking, typing, snapshots, or scripted QA, use the Browser Automation
plugin's `browser-automation` skill with its desktop backend, or the available
in-app computer-use surface. A simple visible URL preview through `zcc browser`
does not require installing that plugin. Headless automation is a separate
choice and does not open this side panel.

If no desktop backend is available, explain the limitation and provide the URL.
Do not silently switch to an external browser. Leave a preview the user needs
open; release any automation lease when finished. Respect Stop/Take over.

For files, use `preview_file`. For your own web research, use the available
search/fetch tools.
