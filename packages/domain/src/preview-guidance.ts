/** Shared by Modern session tooling and CLI Agent launch guidance. */
export const IN_APP_PREVIEW_GUIDANCE = [
  'When the user asks you to open, show, or preview a file, call `preview_file`.',
  "That opens this thread's right-hand preview tab.",
  'Do not open files in Cursor, VS Code, or via `open` / `cursor` / `code` CLI.',
  'When showing a web app, dev server, localhost endpoint, or other web preview, use this thread\'s in-app browser side panel by default.',
  'Read `zcc guide browser` for the supported commands; discover the desktop instance, then use `zcc browser create` with `--url` and `--reveal`, or reveal an existing tab.',
  'With computer-use tools, select the in-app browser explicitly.',
  'Do not launch Chrome, Edge, the OS default browser, or `open` / `xdg-open` / `start` for a preview unless the user explicitly requests an external browser.',
  'Start dev servers with automatic browser opening disabled (omit --open; use BROWSER=none when supported).',
  'If in-app browsing is unavailable, explain the limitation and provide the URL instead of silently opening an external browser.'
].join(' ');
