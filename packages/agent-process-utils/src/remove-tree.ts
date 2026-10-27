import {
  type Stats,
  lstatSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Delete a directory tree this process created, removing every link inside it
 * as a link, never the folder it points at.
 *
 * `rmSync(dir, { recursive: true })` is not safe for a tree that can hold
 * links. Electron builds Node's `rmSync` on libc++, whose Windows
 * `remove_all` reports a directory junction as a plain directory and deletes
 * the junction target's contents. Provider bridges link real user folders
 * (`~/.claude/skills`, `~/.claude/commands`, plugin skill caches) into their
 * temp dir, so that walk emptied those folders on exit.
 *
 * A directory is entered only after its real path is confirmed to be the path
 * walked to; anything else is a link the runtime did not report as one, and is
 * unlinked. Stops at the first failure and throws, leaving the rest on disk:
 * a leftover temp dir is cheap, deleting through a link is not.
 */
export function removeTreeWithoutFollowingLinks(root: string): void {
  const stat = lstatOrNull(root);
  if (stat === null) return;
  if (stat.isSymbolicLink()) {
    removeLink(root);
    return;
  }
  removeEntry(root, realpathSync.native(root));
}

function removeEntry(path: string, expectedRealPath: string): void {
  const stat = lstatOrNull(path);
  if (stat === null) return;
  if (stat.isSymbolicLink()) {
    removeLink(path);
    return;
  }
  if (!stat.isDirectory()) {
    unlinkSync(path);
    return;
  }
  const realPath = realpathSync.native(path);
  if (!samePath(realPath, expectedRealPath)) {
    removeLink(path);
    return;
  }
  for (const name of readdirSync(path)) {
    removeEntry(join(path, name), join(realPath, name));
  }
  rmdirSync(path);
}

/** Removes the link itself. `rmdir` on a Windows junction never touches its target. */
function removeLink(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EISDIR") throw error;
    rmdirSync(path);
  }
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
