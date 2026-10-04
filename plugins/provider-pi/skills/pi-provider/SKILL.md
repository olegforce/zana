---
name: pi-provider
description: "Inspect ZCC Pi provider support for message editing and context compaction."
---

# Pi provider

Pi supports editing and rerunning eligible user messages and compacting idle or
errored threads through the thread’s supported controls. Inspect the thread with
`zcc thread show <id> --json` first and read `zcc guide threads` for CLI operations.
Provider confirmation determines whether the operation completed.

Use the target host's provider catalog for available models and execution options.
