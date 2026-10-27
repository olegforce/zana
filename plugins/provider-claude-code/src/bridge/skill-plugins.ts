import { createHash } from "node:crypto";
import {
  type Stats,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface ClaudeSkillPluginRoot {
  id: string;
  path: string;
}

interface ClaudePluginManifest {
  $schema: string;
  name: string;
  version: string;
  description: string;
  author: { name: string };
  skills: string;
}

const MANIFEST_SCHEMA = "https://anthropic.com/claude-code/plugin.schema.json";

function pluginDirectoryName(root: ClaudeSkillPluginRoot): string {
  return createHash("sha256")
    .update(`${root.id}\0${root.path}`)
    .digest("hex")
    .slice(0, 16);
}

export const CLAUDE_SKILL_PLUGIN_NAME = "zcc-global-skills";

function pluginNameFor(
  root: ClaudeSkillPluginRoot,
  takenBy: ReadonlyMap<string, string>,
): string {
  const directory = pluginDirectoryName(root);
  const owner = takenBy.get(CLAUDE_SKILL_PLUGIN_NAME);
  if (owner === undefined || owner === directory) {
    return CLAUDE_SKILL_PLUGIN_NAME;
  }
  return `${CLAUDE_SKILL_PLUGIN_NAME}-${directory.slice(0, 8)}`;
}

export function ensureClaudeSkillPlugin(args: {
  pluginsRoot: string;
  root: ClaudeSkillPluginRoot;
  takenNames?: Map<string, string>;
}): string {
  const directory = pluginDirectoryName(args.root);
  const pluginPath = join(args.pluginsRoot, directory);
  const takenNames = args.takenNames ?? new Map<string, string>();
  const name = pluginNameFor(args.root, takenNames);
  takenNames.set(name, directory);
  mkdirSync(join(pluginPath, ".claude-plugin"), { recursive: true });
  const manifest: ClaudePluginManifest = {
    $schema: MANIFEST_SCHEMA,
    name,
    version: "0.1.0",
    description: `Skills injected by ZCC (${args.root.id}).`,
    author: { name: "zcc" },
    skills: "./skills",
  };
  writeFileSync(
    join(pluginPath, ".claude-plugin", "plugin.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  const skillsLink = join(pluginPath, "skills");
  let current: string | null = null;
  try {
    current = lstatSync(skillsLink).isSymbolicLink()
      ? readlinkSync(skillsLink)
      : "";
  } catch {
    current = null;
  }
  if (current !== args.root.path) {
    removeSkillsLink(skillsLink);
    // A junction needs no Developer Mode or admin rights on Windows, where a
    // "dir" symlink fails with EPERM; other platforms ignore the type.
    symlinkSync(args.root.path, skillsLink, "junction");
  }
  return pluginPath;
}

/**
 * Remove the `skills` link before re-pointing it, as a link only. Never a
 * recursive delete: on Windows the link is a junction into a real user folder
 * (`~/.claude/skills`), and Electron's `rmSync` walks a junction as a plain
 * directory and empties it. A real directory here is not ours, so refuse it.
 */
function removeSkillsLink(skillsLink: string): void {
  let stat: Stats;
  try {
    stat = lstatSync(skillsLink);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const isLink =
    stat.isSymbolicLink() ||
    !samePath(
      realpathSync.native(skillsLink),
      join(realpathSync.native(dirname(skillsLink)), "skills"),
    );
  if (!isLink) {
    throw new Error(`refusing to replace a real directory at ${skillsLink}`);
  }
  try {
    unlinkSync(skillsLink);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EISDIR") throw error;
    // `rmdir` on a Windows junction removes the junction, never its target.
    rmdirSync(skillsLink);
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export function createClaudeSkillPluginsRoot(baseDir = tmpdir()): string {
  mkdirSync(baseDir, { recursive: true });
  return mkdtempSync(join(baseDir, "zcc-claude-skill-plugins-"));
}
