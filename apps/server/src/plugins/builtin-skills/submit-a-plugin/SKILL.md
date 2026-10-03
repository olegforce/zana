---
name: submit-a-plugin
description: "Prepare and submit a Zana plugin to a public or internal marketplace when publication or a marketplace PR is requested."
---

# Submit a plugin

Submit a plugin through a marketplace pull request. The marketplace stores
metadata and a Git or npm source reference; the code stays in its own repository.

## Choose the task and target

For an instructions-only question, explain the process without remote changes.
For a submission request, prepare and validate everything possible. Ask only
for information the plugin, installed registry, Git, npm, or marketplace
cannot supply.

**Plugins → Installed → plugin details → More plugin actions → Submit to
marketplace** opens a draft identifying the installed plugin. Resolve its
source using that ID in the installed registry (`zcc plugin list --json`),
then verify `package.json` and Git state. The current project may differ from
the source. An install path is never a release source.

Read `zcc marketplace ls --json` to discover configured catalogs. Identify the
target repository from its configuration and documentation. Confirm the target
and public or internal visibility when ambiguous. Internal plugins may use
private repositories accessible to the target audience. Public listings must
use public sources. Never assume BB’s marketplace accepts a Zana plugin or
that an internal plugin should become public.

A submission request does not approve a release. Complete local preparation
first. Before an unapproved Git push, tag, npm publication, or other release
mutation, show the exact account, repository, commit, package, version, source,
and commands, and get approval for that release. Honor exact authorization
already given in the conversation rather than asking for it again.

Do not expose credentials, private account data, or secrets. Do not change the
installed plugin’s settings or account data as part of publication.

## Read current contracts

Read the target marketplace default branch before writing its entry:

- `README.md` and repository instructions.
- The current entry schema and marketplace identity/category definitions.
- Icon, screenshot, and overview conventions, when supported.
- At least two current entries.

Zana’s pointer catalog uses `schemaVersion: 1`. Its consumer contract is
`packages/domain/src/plugin-marketplace.ts`. Do not copy BB-only v2 fields
such as `category` or `screenshots` into a strict Zana v1 entry. Follow the
target repository’s actual build format; an overview may be inline text rather
than a file reference. Read current contracts, not a remembered schema.

## Workflow

1. Verify the manifest, installed ID, source tree, Git state, and release state.
2. Run tests, type checks, `zcc plugin types --check`, and `zcc plugin build`.
3. Select and verify one distributable Git or npm source.
4. Prepare the listing, icon, overview, and screenshots supported by the target.
5. Validate the marketplace using its documented checks.
6. Obtain approval for release mutations not already authorized.
7. Commit only submission files and required generated catalog outputs.
8. Open a marketplace PR using the submitter’s authenticated account.
9. Monitor checks; diagnose and repair actionable failures.

Read these references as the task reaches each stage:

- `references/plugin-release.md` before validating or releasing the plugin.
- `references/marketplace-entry.md` before preparing listing assets.
- `references/pull-request.md` before preparing the marketplace branch and PR.

If authentication or repository access is missing, finish local preparation
and return the files, checks, and precise remaining steps. Do not claim a listing
is published merely because a local entry or PR exists.

## Completion

Return the PR URL, selected release source, validation results, and remaining
approval or external blockers. A listing appears after the marketplace accepts
and builds the entry and clients refresh. Do not wait for merge unless requested.

A compatible release inside an existing tracking range usually needs no new
marketplace PR. Submit another PR when source, branding, description, overview,
ownership, supported screenshots, tags, or the tracking range changes.
