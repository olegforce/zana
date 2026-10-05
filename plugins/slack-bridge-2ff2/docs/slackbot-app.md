# Use Zana from Slackbot

Version 0.8.0 adds `zana_list_projects`, `zana_launch_job` and `zana_job_status` for Slackbot's Apps feature. The public MCP endpoint lives on Zana Connect at `https://zana-ide.com/api/slack/mcp/`, with **Slack identity auth**. It requires a linked computer using Connect and locally approved Project/channel mappings.

“Use Zana to review the failing tests in my website Project and put the job in #agent-work” starts an agent conversation with the mapping's configured machine, provider and model. Its task is posted to that channel. The tool returns a durable job ID; use status for progress and confirmed shared answers. This release starts agent jobs, not saved Job Teams. Permissions and questions remain in Zana.

Launch requires a stable `request_id` and exact IDs from Project discovery. Retries reuse the same key and arguments. Inspect uncertain results; never retry them with a new key. Admission uses the existing Home ledger and Bridge authorization.

Apply `slack-app-connect-manifest.json` after deploying the hosted service and setting up Connect event delivery. It adds `mcp:connect` and `mcp_servers.zana_jobs`. Reinstall/approve where required, fetch the tools in **MCP Servers → Tools → Fetch Tools**, and connect Zana under **Slackbot → Apps**. Launch is a write action and follows Slackbot's tool-approval preferences. Socket Mode alone cannot expose the public endpoint.

Deployment, Slack approval and a real Slackbot conversation require separate verification. The full guide and deterministic built-desktop test live in the Zana repository at `docs/slackbot-app.md` and `e2e/slackbot-mcp.spec.ts`.

Sources: [Slackbot MCP client](https://docs.slack.dev/ai/slackbot-mcp-client/), [administrator approval](https://docs.slack.dev/ai/slackbot-mcp-client/admin-approval/).
