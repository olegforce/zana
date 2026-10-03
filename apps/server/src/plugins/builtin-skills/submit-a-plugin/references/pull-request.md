# Marketplace validation and pull request

Read the target instructions and identify its default branch and authenticated
host/account. For GitHub use `gh auth status` and `gh api user --jq .login`,
with the configured host for internal repositories. Do not expose tokens.
Verify this is the selected Zana marketplace rather than copying BB’s hardcoded
community repository.

Prepare a clean branch from the target default branch. Reuse a clean checkout
or clone into a new directory in the existing project; do not overwrite unrelated
changes or create a worktree unless explicitly requested. Use a fork when the
author lacks branch access. Prepare local changes before release approval.

If auth or access is missing, finish local preparation and validation where
possible. Return the files, branch, intended repository, and remaining steps.

## Validate

Install only marketplace dependencies, disabling lifecycle scripts when supported
(for example `npm ci --ignore-scripts`). Do not execute submitted plugin code
during catalog validation. Run the target’s documented build, schema checks, and
tests, then `git diff --check`.

Review entry, asset, overview, and required generated catalog diffs. Some
Git-backed Zana catalogs require a root `marketplace.json`; omitting its
regenerated output leaves a merged entry invisible to clients. Verify
ID/filename/manifest agreement, valid fields, source ref/subdirectory
accessibility, author identity, and clean assets.

## Open and monitor

Commit only submission files and required generated outputs. With the necessary
remote-change authorization, push the intended branch and create the PR against
the verified host/repository/default branch. Write its body to a file and use
`gh pr create --body-file`, preserving real newlines.

The PR should state the user-facing behavior, source and range/ref, plugin and
marketplace checks, service/account requirements, runtime trust model (full-trust
plugin code executes in-process after install), and what screenshots/overview
show when present.

Watch checks to completion. Fetch failed logs with
`gh run view RUN_ID --job JOB_ID --log-failed`. For external checks inspect
check-run annotations for file, line, rule, and remediation. Fix actionable
failures, run focused checks, push, and repeat. Do not wait for merge unless
requested. Return the PR URL and distinguish submission from a published listing.
