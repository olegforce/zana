import { parentPort } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { applyPluginSqliteMigrations } from './plugin-database-migrations.js';
import { createPluginWorkerBridge } from './plugin-worker-bridge.js';
import type { ZccPluginApi, PluginDatabase } from '@zana-ai/zcc-plugin-sdk';

export async function runPluginWorker(port = parentPort) {
  if (!port) throw new Error('Plugin worker requires a parent port');
  const workerData = await new Promise<any>(resolve => port.once('message', message => resolve(message.data)));
  const bridge = createPluginWorkerBridge(port, 'plugin');
  const api = bridge.decode(workerData.api) as ZccPluginApi;
  const callService = bridge.decode(workerData.callService) as (id: string, method: string, args: unknown[]) => { asynchronous: boolean; value: any };
  const serviceMember = bridge.decode(workerData.serviceMember) as (id: string, method: string) => { method: boolean; present: boolean; value: unknown };
  const require = createRequire(import.meta.url);
  let database: any;
  let databaseApi: PluginDatabase | undefined;

  api.storage.database = (): PluginDatabase => {
    if (databaseApi) return databaseApi;
    if (!database) {
      const Sqlite = require(workerData.sqlite.modulePath);
      database = new Sqlite(workerData.databasePath, { nativeBinding: workerData.sqlite.nativeBinding, timeout: 25 });
      database.pragma('journal_mode = WAL');
    }
    const db = database;
    databaseApi = {
      prepare: sql => db.prepare(sql),
      runScript: sql => { db.exec(sql); },
      transaction: fn => db.transaction(fn)(),
      migrate: statements => applyPluginSqliteMigrations(sql => db.exec(sql), sql => db.prepare(sql), fn => db.transaction(fn)(), statements)
    };
    return databaseApi;
  };
  api.services.use = <T extends object>(id: string): T => new Proxy({} as T, {
    get(_target, method) {
      if (method === 'then' || typeof method === 'symbol') return undefined;
      const member = serviceMember(id, method);
      if (!member.method) return member.value;
      return (...args: unknown[]) => {
        const result = callService(id, method, args);
        return result.asynchronous ? result.value() : result.value;
      };
    },
    has(_target, method) { return typeof method === 'string' && serviceMember(id, method).present; }
  });
  // Contracts are advisory in core; validation wrappers and closures stay in the worker.
  api.rpc.register = (_contract, handlers) => { for (const [name, handler] of Object.entries(handlers)) api.rpc.method(name, handler as (args: unknown) => unknown); };

  const heartbeat = setInterval(() => port.postMessage({ kind: 'heartbeat' }), 100);
  port.on('close', () => { clearInterval(heartbeat); bridge.dispose(); database?.close(); });
  try {
    const entry = workerData.entry as string;
    let mod: { default?: unknown };
    if (/\.tsx?$/.test(entry)) {
      const imported = await import('jiti');
      const createJiti = imported.createJiti ?? (imported.default as any)?.createJiti ?? imported.default;
      if (typeof createJiti !== 'function') throw new Error('jiti createJiti is unavailable');
      mod = await createJiti(import.meta.url, { moduleCache: false, fsCache: false }).import(entry);
    } else { mod = await import(`${pathToFileURL(entry).href}?v=${workerData.generation}`); }
    if (typeof mod.default === 'function') {
      await mod.default(api);
      port.postMessage({ kind: 'ready' });
    } else if (mod.default && typeof mod.default === 'object' && typeof (mod.default as any).setup === 'function') {
      // Legacy MainModule setup still belongs to its existing desktop process host.
      port.postMessage({ kind: 'ready', legacy: true });
    } else { throw new Error(`plugin server entry must default-export a factory: ${entry}`); }
  } catch (error) {
    port.postMessage({ kind: 'failure', message: error instanceof Error ? error.message : String(error) });
  }
}
void runPluginWorker().catch(error => parentPort?.postMessage({ kind: 'failure', message: error instanceof Error ? error.message : String(error) }));
