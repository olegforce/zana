# Desktop release pipeline

`.github/workflows/release.yml` builds macOS Apple Silicon, macOS Intel, and
Windows x64 on native GitHub-hosted runners. Pushing a `v<version>` tag runs
typechecking, unit tests, and the Linux Electron boot/IPC gate before packaging.
All three packages must succeed before the workflow creates a draft release on
`salesforce/zana`. A human publishes the draft.

The Windows job builds an NSIS installer named
`Zana-Command-Center-<version>-win-x64-Setup.exe`. It launches
`dist/win-unpacked/Zana.exe` with an isolated home, exercises renderer/server IPC,
and checks the packaged OpenCode executable and node-pty/ConPTY. It uses the
package's native modules instead of the checkout's modules. A smoke failure
blocks uploading the installer and creating the draft release.

Startup migration and product stores flush file contents before an atomic rename.
They also flush the parent directory on POSIX; Windows skips that unsupported
directory operation while retaining file flushes and conflict checks. The native
smoke probe loads Node built-ins through `process.getBuiltinModule` so it works
in Electron's ESM main process.

Every packaging path prepares compiled plugin runtimes in `out/packaged-plugins`.
The package includes bundled server, app and PTY entries, prebuilt provider host
artifacts, skills and declared runtime assets. Shipped providers validate these
artifacts without recompiling retained source or requiring build dependencies.
Provider startup, reload, corruption and recovery checks run against each
packaged executable.

Mac packages run the same boot/IPC smoke alongside packaged plugin authoring.
Failed Mac checks retain a Playwright report per
architecture, as the Windows job does.

The release includes Windows `.exe`, `.blockmap`, and `latest.yml` assets alongside
the Mac `.dmg`, `.zip`, `.blockmap`, and merged `latest-mac.yml` assets. Both update
feeds use the existing public GitHub repository. Manual `workflow_dispatch` runs
build and test the same packages, retaining them as workflow artifacts without
creating a GitHub release.

Windows signing uses the optional repository secrets `WIN_CSC_LINK` (certificate
file encoded as base64, or an HTTPS certificate URL) and `WIN_CSC_KEY_PASSWORD`.
These are separate from the Mac `CSC_LINK`/Apple notarization secrets. Without
Windows signing credentials, the pipeline produces an unsigned installer. Add
the credentials to produce signed installers; unsigned downloads can prompt
Windows SmartScreen. See the
[electron-builder Windows signing guide](https://www.electron.build/docs/features/code-signing/code-signing-win/).

For local packaging on Windows, run `pnpm dist:win`. Local packaging passes
`--publish never`; release publication belongs to the workflow. OpenCode staging
selects the build host's platform and uses `opencode.exe` on Windows. The POSIX
scheduled supervisor is bundled only on macOS/Linux.
