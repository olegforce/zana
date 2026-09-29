import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { execute, supervise } from "./process.js";

describe("process ownership", () => {
  it.each([false, true])(
    "runs the supervisor in Node mode without leaking it to external children (Electron: %s)",
    async (electron) => {
      const root = await mkdtemp(join(tmpdir(), "db-supervisor-environment-"));
      const launcher = join(root, "runtime");
      const supervisorEnvironment = join(root, "supervisor.json");
      const childEnvironment = join(root, "child.json");
      await writeFile(
        launcher,
        `#!${process.execPath}
const { writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
if (process.env.ELECTRON_RUN_AS_NODE !== ${electron ? '"1"' : "undefined"}) process.exit(42);
writeFileSync(${JSON.stringify(supervisorEnvironment)}, JSON.stringify(process.env));
const result = spawnSync(${JSON.stringify(process.execPath)}, process.argv.slice(2), { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
`,
        { mode: 0o700 },
      );
      const childCode = `require("node:fs").writeFileSync(${JSON.stringify(childEnvironment)}, JSON.stringify(process.env)); setInterval(() => {}, 1000);`;
      const code = `
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { supervise, execute } from ${JSON.stringify(new URL("./process.ts", import.meta.url).href)};
import { runtimeEnvironment } from ${JSON.stringify(new URL("./runtime.ts", import.meta.url).href)};
Object.defineProperty(process, "execPath", { value: ${JSON.stringify(launcher)} });
${electron ? 'Object.defineProperty(process.versions, "electron", { value: "41.0.0" });' : ""}
const env = runtimeEnvironment(${JSON.stringify(root)});
assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
const original = { ...env };
const child = supervise(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(childCode)}], env);
try {
  const deadline = AbortSignal.timeout(5000);
  while (true) {
    deadline.throwIfAborted();
    assert.ok(child.alive(), "Supervisor exited before external child started");
    try { await readFile(${JSON.stringify(childEnvironment)}, "utf8"); break; } catch {}
    await delay(25);
  }
  assert.deepEqual(env, original);
  const output = await execute(${JSON.stringify(process.execPath)}, ["-e", "process.stdout.write(JSON.stringify(process.env))"], env, deadline);
  const parsed = JSON.parse(output);
  for (const [key, value] of Object.entries(original)) assert.equal(parsed[key], value);
  assert.equal(parsed.ELECTRON_RUN_AS_NODE, undefined);
} finally {
  await child.close();
}
`;
      try {
        await promisify(execFile)(
          process.execPath,
          [
            "--conditions=source",
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            code,
          ],
          {
            env: {
              ...process.env,
              ELECTRON_RUN_AS_NODE: "1",
              TSX_TSCONFIG_PATH: fileURLToPath(
                new URL("./tsconfig.smoke.json", import.meta.url),
              ),
            },
            timeout: 10_000,
          },
        );
        const supervisorEnv = JSON.parse(
          await readFile(supervisorEnvironment, "utf8"),
        );
        const childEnv = JSON.parse(await readFile(childEnvironment, "utf8"));
        expect(supervisorEnv.ELECTRON_RUN_AS_NODE).toBe(
          electron ? "1" : undefined,
        );
        expect(childEnv.ELECTRON_RUN_AS_NODE).toBeUndefined();
        expect(childEnv.DEV_BROWSER_HOME).toBe(root);
        expect(childEnv.DEV_BROWSER_SOCKET).toBe(join(root, "s"));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    12_000,
  );
  it("worker death closes the supervisor pipe and kills its child", async () => {
    const root = await mkdtemp(join(tmpdir(), "db-worker-death-"));
    const file = join(root, "pid");
    const childCode =
      'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
    const code = `import { execute, supervise } from ${JSON.stringify(new URL("./process.ts", import.meta.url).href)}; supervise(process.execPath, ["-e", ${JSON.stringify(childCode)}, ${JSON.stringify(file)}], process.env); setInterval(() => {}, 1000);`;
    const worker = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      { stdio: "ignore" },
    );
    try {
      let pid = 0;
      await vi.waitFor(
        async () => {
          pid = Number(await readFile(file, "utf8"));
        },
        { timeout: 5000 },
      );
      worker.kill("SIGKILL");
      await vi.waitFor(
        () => {
          expect(() => process.kill(pid, 0)).toThrow();
        },
        { timeout: 5000 },
      );
    } finally {
      worker.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  }, 12_000);
  it("kills a TERM-resistant child group without touching another session", async () => {
    const root = await mkdtemp(join(tmpdir(), "db-supervisor-"));
    const code =
      'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
    const a = supervise(
      process.execPath,
      ["-e", code, join(root, "a")],
      process.env,
    );
    const b = supervise(
      process.execPath,
      ["-e", code, join(root, "b")],
      process.env,
    );
    try {
      let pidA = 0,
        pidB = 0;
      await vi.waitFor(
        async () => {
          pidA = Number(await readFile(join(root, "a"), "utf8"));
          pidB = Number(await readFile(join(root, "b"), "utf8"));
        },
        { timeout: 5000 },
      );
      await a.close();
      expect(() => process.kill(pidA, 0)).toThrow();
      expect(() => process.kill(pidB, 0)).not.toThrow();
      await b.close();
      expect(() => process.kill(pidB, 0)).toThrow();
    } finally {
      await Promise.all([a.close(), b.close()]);
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});


describe('bounded browser command execution', () => {
  it('captures realistic output completely and rejects spawn failure', async () => {
    const text = 'browser-protocol-output'.repeat(4000);
    expect(await execute(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(text)})`], process.env, AbortSignal.timeout(5000))).toBe(text);
    await expect(execute('/nonexistent/zcc-browser-command', [], {}, AbortSignal.timeout(5000))).rejects.toThrow();
  });
  it.each(['stdout', 'stderr'])('kills a command that exceeds the combined output budget through %s', async stream => {
    await expect(execute(process.execPath, ['-e', `process.${stream}.write('x'.repeat(600000)); setInterval(()=>{},1000)`], process.env, AbortSignal.timeout(5000))).rejects.toThrow('exceeded 512 KB');
  });
  it('rejects cancellation before spawn and terminates a running command', async () => {
    const before = new AbortController(); before.abort();
    expect(() => execute(process.execPath, [], process.env, before.signal)).toThrow();
    const during = new AbortController();
    const pending = execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], process.env, during.signal);
    const checked = expect(pending).rejects.toThrow('cancelled or timed out'); during.abort(); await checked;
  });
  it('reports an exited supervisor and closes it without leaving a process', async () => {
    const child = supervise(process.execPath, ['-e', 'process.exit(0)'], process.env);
    await vi.waitFor(() => expect(child.alive()).toBe(false)); await child.close();
  });
});
