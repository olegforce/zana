# Zana for Slack

This is a bundled first-party plugin. Follow the repository AGENTS.md and use the same plugin SDK and installer as other plugins. Keep its stable `slack-bridge-2ff2` ID so existing account links and settings survive updates. Do not add plugin-specific behavior to core services.

Use the build, typecheck, coverage, and built-Electron commands in README.md. At least 80% meaningful coverage is required. `e2e/slack-builtin.spec.ts` checks compiled installation and Configuration; `e2e/slackbot-mcp.spec.ts` checks the real Connect-to-Electron boundary with synthetic Slack and model fixtures.

Never read real credentials or post to real Slack channels as part of automated testing. Use isolated homes and the existing fixtures. Preserve opt-in access controls for connected Projects, report-inbox reads, and outgoing answers. Keep permission decisions in Zana.

Assets are declared in `package.json` → `zcc.extra.runtimeAssets`. `runtime-assets.ts` lives at the plugin root so its URLs work both in the source checkout and beside the packaged `server.mjs`. Run the build before preparing a release runtime.
