# Plugin validation and release

Read repository instructions, `package.json`, Git remotes, changes, and release
state. Confirm `engines.zcc`, `engines.zccPluginSdk`, and `zcc.name`,
`zcc.description`, `zcc.branding`, and runtime entries. Verify the installed ID
against the product’s `derivePluginId` (`@zana-ai/zcc-plugin-sdk`): it strips the
npm scope and lowercase `zcc-plugin-` or `zana-plugin-` prefix, normalizes to
lowercase letters/digits/hyphens, and rejects empty/reserved IDs. Do not infer
an ID from the display name. Check the subdirectory for a multi-plugin repository.

Run focused tests and type checks with the project’s package manager, then
`zcc plugin types --check` and `zcc plugin build` from the source.
Do not release failed checks or uncommitted release changes. Ensure built
runtime entries and imported files will be available after installation.

## Select one source

Prefer a Git semantic-version range for a repository that already uses immutable
release tags. Use npm for a plugin already distributed as a complete package.
Use an exact immutable Git tag or commit when a fixed release is intended.

Examples (validate against the target schema):

```json
{ "git": { "url": "https://github.com/OWNER/REPO.git", "range": "^1.2.3" } }
```

```json
{ "git": { "url": "https://github.com/OWNER/REPO.git", "ref": "v1.2.3", "subdir": "plugins/notes" } }
```

For independent monorepo tags such as `notes/v1.2.3`, use `tagPrefix: "notes/"`
with the range. Verify the ref and subdirectory actually exist and are accessible
to the target audience. Never publish a `path:` source.

## Release review

Complete checks and release preparation first. Show the authenticated account,
repository URL and visibility, commit, package/version, proposed tag/npm source,
and exact remote-changing commands. Obtain approval when those release changes
have not already been authorized. Never overwrite a tag or republish an npm version.

For npm, inspect `npm pack --dry-run --ignore-scripts` and verify the manifest,
built app/server/host entries, assets, skills, and required runtime dependencies
are included. Use `npm whoami` to verify the account. After release approval,
use `npm publish --ignore-scripts` (`--access public` only for an intended public
scoped package). Verify with `npm view PACKAGE@VERSION name version`.

For Git, create the immutable tag on the reviewed commit, push only the intended
branch/tag after authorization, and verify with `git ls-remote --tags REMOTE`.
Never interpolate display names into shell code.
