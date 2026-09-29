import { spawn } from "node:child_process";
let child = null, lease = null, starting = null;
function clearLease() { const retained = lease; lease = null; void retained?.dispose(); }
export default function host(api) {
  api.lifecycle?.onDispose(() => { child?.kill(); child = null; clearLease(); });
  api.methods.register("enable", async (_args, context) => {
    if (starting) return starting;
    if (child) return { ok: true, awake: true };
    const spawned = spawn("caffeinate", ["-dims"], { stdio: "ignore" });
    child = spawned;
    spawned.once("exit", () => { if (child === spawned) { child = null; clearLease(); } });
    starting = new Promise((resolve, reject) => {
      spawned.once("spawn", () => {
        if (child === spawned) lease = context?.experimental_retainWorker();
        resolve({ ok: true, awake: child === spawned });
      });
      spawned.once("error", error => { if (child === spawned) child = null; reject(error); });
    });
    try { return await starting; } finally { starting = null; }
  });
  api.methods.register("disable", async () => {
    child?.kill(); child = null; clearLease();
    return { ok: true, awake: false };
  });
  api.methods.register("status", async () => ({ awake: Boolean(child) }));
}
