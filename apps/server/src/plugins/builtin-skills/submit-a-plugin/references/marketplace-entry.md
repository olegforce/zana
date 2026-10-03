# Listing, icon, overview, and screenshots

Read the target repository’s current entry schema, asset conventions, and two
examples. Its file layout and supported fields are authoritative. Zana v1
entries accept `id`, `displayName`, `description`, `overview`, `icon`, `tags`,
`author`, and `source`; unknown fields are rejected. Do not add BB v2 fields.
An entry’s ID, filename (when entries are split), and installed ID must agree.

Use the product name as `displayName`. Lead the description with the concrete
outcome a user gets; it should stand alone when a browse card truncates it.
Follow with distinct observed capabilities and requirements: external services,
paid accounts, separate tools, and operating-system restrictions. Do not invent
features, performance claims, install counts, or reviews. Use specific search
tags within the target’s limits.

Identify the author from the authenticated submitter and repository ownership.
Do not publish personal email addresses or credentials. For GitHub, verify with
`gh api user --jq .login`, using the correct host for an internal repository.
Do not replace internal identity/URLs with public GitHub guesses.

Use `source.git` or `source.npm` according to the verified release. Example:

```json
{
  "id": "notes",
  "displayName": "Notes",
  "description": "Keep project notes beside your agents.",
  "icon": { "lucide": "NotebookPen" },
  "tags": ["notes"],
  "author": { "name": "Ada", "github": "ada" },
  "source": { "git": { "url": "https://github.com/ada/zcc-plugin-notes.git", "ref": "v1.0.0" } }
}
```

## Assets and overview

Use actual plugin branding. Vendor an icon when required; follow the target’s
format, size, naming, and reference rules. Zana also accepts a canonical Lucide
icon name. Do not assume BB’s vendored-icon policy applies to every catalog.

Reuse `PLUGIN_OVERVIEW.md` when present. Otherwise draft a factual overview from
the source and verified UI, covering how to start and required configuration.
For Zana v1, `overview` is bounded inline Markdown; do not put a file path into
that field unless the target build explicitly resolves it. A target supporting
external overview files may require copying one into its tree.

When the target supports screenshots, install the reviewed plugin in an isolated
test environment and capture its actual UI with computer-use or the supported
in-app browser. Use representative synthetic data and clear labels. Never expose
tokens, private customer records, project paths, or account identifiers. Match
the repository’s dimensions, formats, size caps, and reference rules. If the
plugin has no visible UI, explain why the PR has no screenshot. If capture is
unavailable, finish other preparation and state exactly which image remains needed.

## Quality check

Verify the description states observed value and material requirements; identity
matches the manifest and submitter; source is accessible to the target audience;
every referenced asset exists; no private data or unknown schema fields are
present; and the overview describes the shipped plugin. Include only referenced assets.
