# Slack capability catalog

`catalog.json` is the authored inventory of Slackbot tools, Slack channel shortcuts and configurable functionality groups (`features`). Edit descriptions, arguments and annotations here. `sync.mjs` generates self-contained copies for the hosted service and the path-installed Slack Bridge. Do not edit generated copies.

```sh
node packages/slack-capabilities/sync.mjs --plugin /path/to/slack-bridge-2ff2
node packages/slack-capabilities/sync.mjs --check --plugin /path/to/slack-bridge-2ff2
```

The hosted service imports `website/slack/capabilities.json`. The plugin reads `src/capability-catalog.json` once per generation through `src/catalog.ts` (avoiding stale JSON import caches on reload) for its capabilities settings and command help. Implementation still belongs at its authorization boundary: hosted `website/slack/mcp.mjs` for connection/transport and plugin `src/slackbot.ts` for owner-scoped Project/job actions. Adding a definition alone does not create a handler.

Plugin tools do **not** require new static MCP definitions or a hosted deployment. Slackbot discovers locally enabled tools through `zana_list_capabilities` and invokes them with `zana_run_capability`. See [the extension contract](../../docs/slack-capabilities.md).
