---
name: acp-provider
description: "Configure or troubleshoot ACP agent discovery, custom models, skills, and compaction in ZCC."
---

# ACP providers

Known agents can be discovered automatically when their CLI is installed on the
host: `opencode`, `omp`, `grok`, and `hermes` appear as `acp-opencode`, `acp-omp`,
`acp-grok`, and `acp-hermes-agent`. Inspect the target host's catalog with
the thread composer’s machine and model selectors. Check CLI installation with
`zcc machine provider-cli status <host-id> --json`.

Cursor project skills come from `.cursor/skills`, which can link to
`.agents/skills`. ZCC lists these linked skills as read-only under `cursor-project`.

ACP agents may reject unlisted model IDs. OpenCode requires models in its own
configuration; ZCC discovers them there. OpenCode agents are session modes, not
models selectable through ZCC's model field.

OpenCode ACP supports the thread’s compaction control; Cursor ACP does not
expose compatible compaction. Check the actual agent's capabilities before
attempting provider-specific recovery.
