import { describe, expect, it } from "vitest";
import { constants } from "node:fs";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_PLAN_CHECKLIST_TOOLS,
  CLAUDE_TODO_TOOLS_ENV_VAR,
  mergeClaudePlanChecklistAllowedTools,
  withClaudeTodoToolsEnv,
  resolveClaudeCodeExecutable,
} from "../session-options.js";

it("reads legacy Claude executable settings and prioritizes canonical overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "zcc-claude-override-"));
  try {
    const executable = join(root, "claude");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, constants.S_IRUSR | constants.S_IWUSR | constants.S_IXUSR);
    expect(resolveClaudeCodeExecutable({ env: { BB_CLAUDE_CODE_EXECUTABLE: executable } })).toBe(executable);
    expect(() => resolveClaudeCodeExecutable({ env: { BB_CLAUDE_CODE_EXECUTABLE: executable, ZCC_CLAUDE_CODE_EXECUTABLE: join(root, "missing") } })).toThrow("ZCC_CLAUDE_CODE_EXECUTABLE");
  } finally { rmSync(root, { force: true, recursive: true }); }
});

describe("withClaudeTodoToolsEnv", () => {
  it("enables checklist tools by default so newer Claude models emit planSteps", () => {
    expect(withClaudeTodoToolsEnv({ HOME: "/tmp" })).toMatchObject({
      HOME: "/tmp",
      [CLAUDE_TODO_TOOLS_ENV_VAR]: "1",
    });
  });

  it("honors an explicit session override", () => {
    expect(
      withClaudeTodoToolsEnv({ [CLAUDE_TODO_TOOLS_ENV_VAR]: "1" }, "0")[
        CLAUDE_TODO_TOOLS_ENV_VAR
      ],
    ).toBe("0");
  });
});

describe("mergeClaudePlanChecklistAllowedTools", () => {
  it("adds TaskCreate and TodoWrite without dropping existing MCP tools", () => {
    expect(
      mergeClaudePlanChecklistAllowedTools(["mcp__bridge__ping"]),
    ).toEqual(["mcp__bridge__ping", ...CLAUDE_PLAN_CHECKLIST_TOOLS]);
  });

  it("is idempotent when the checklist tools are already present", () => {
    const once = mergeClaudePlanChecklistAllowedTools(undefined);
    expect(mergeClaudePlanChecklistAllowedTools(once)).toEqual(once);
  });
});
