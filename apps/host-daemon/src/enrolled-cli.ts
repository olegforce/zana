import { lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isWithin } from '@zana-ai/zcc-path-confine';
import { CliTerminalStartCommandSchema, type CliTerminalStartCommand } from '@zana-ai/zcc-contracts/cli-terminal';
import type { HostEventEnvelope } from '@zana-ai/zcc-contracts/host-rpc';
import type { AppConfig } from '@zana-ai/zcc-domain/product';
import { PtyManager, type PtyManagerHostServices } from './pty.js';
import { resolveMaxLiveSessions } from './capacity.js';
import { executionCliConfig } from './cli-launch-config.js';
import { createCliCallbackForwarder } from './cli-callback-client.js';
import { startCliCallbackProxy } from './cli-callback-proxy.js';

type Engine = Pick<PtyManager, 'create' | 'setProjectRoots' | 'setRulesResolver' | 'setMcpBaseUrl' | 'on' | 'off' | 'write' | 'resize' | 'close' | 'killAll'>;
type Proxy = Awaited<ReturnType<typeof startCliCallbackProxy>>;
type Entry = { stopped: boolean; engine?: Engine; proxy?: Proxy; closing?: Promise<void>; cleanup?: () => void };
const MAX_LAUNCH_IDENTITIES = 4096;

/** One callback capability per CLI. Engines deliberately do not share a mutable
 * MCP base URL or credential resolver. Their subscriptions live exactly as long
 * as that session, including failed and cancelled asynchronous startup. */
export function createEnrolledCli(options: {
  serverUrl: string; hostId: string; hostKey: string;
  fetchFn?: typeof fetch;
  loadConfig(): AppConfig;
  emit(event: HostEventEnvelope): void;
  createEngine?: (services: PtyManagerHostServices) => Engine;
  startProxy?: typeof startCliCallbackProxy;
}) {
  const sessions = new Map<string, Entry>();
  const starting = new Set<Entry>();
  // Never run the same identity twice after a lost start reply. Bounded and
  // fail-closed for the daemon lifetime; restart changes its enrolled instance ID.
  const attempted = new Set<string>();
  let disposed = false;
  const remove = async (id: string, entry: Entry) => {
    entry.stopped = true;
    if (sessions.get(id) === entry) sessions.delete(id);
    entry.cleanup?.(); entry.cleanup = undefined;
    if (entry.proxy) await (entry.closing ??= entry.proxy.close());
  };
  return {
    has(sessionId: string): boolean { return sessions.has(sessionId); },
    async startTerminal(raw: CliTerminalStartCommand): Promise<{ pid?: number }> {
      const command = CliTerminalStartCommandSchema.parse(raw);
      const { sessionId, projectId, credential } = command.grant;
      if (disposed) throw new Error('CLI runtime is closed');
      if (sessions.has(sessionId) || attempted.has(sessionId)) throw new Error('CLI session identity has already been used');
      if (attempted.size >= MAX_LAUNCH_IDENTITIES) throw new Error('CLI launch identity capacity reached');
      const config = executionCliConfig(options.loadConfig(), command.config);
      if (new Set([...sessions.values(), ...starting]).size >= resolveMaxLiveSessions(config)) throw new Error('CLI session capacity reached');
      if (!isAbsolute(command.root) || (command.cwd !== undefined && !isAbsolute(command.cwd)) || !lstatSync(command.root).isDirectory()) throw new Error('CLI launch requires an absolute directory root');
      const root = realpathSync(command.root), cwd = realpathSync(command.cwd ?? root);
      const rootStat = statSync(root), cwdStat = statSync(cwd);
      if (!isWithin(cwd, root) || !cwdStat.isDirectory()) throw new Error('CLI cwd is outside the authorized root');
      const entry: Entry = { stopped: false };
      sessions.set(sessionId, entry);
      starting.add(entry);
      attempted.add(sessionId);
      try {
        entry.proxy = await (options.startProxy ?? startCliCallbackProxy)({ grant: command.grant,
          forward: createCliCallbackForwarder({ grant: command.grant, serverUrl: options.serverUrl,
            hostId: options.hostId, hostKey: options.hostKey, fetchFn: options.fetchFn }) });
        if (disposed || entry.stopped) throw new Error('CLI launch was cancelled');
        const engine = (options.createEngine ?? (services => new PtyManager(services)))({
          sessionCredential: id => { if (id !== sessionId) throw new Error('CLI callback session mismatch'); return credential; },
          // Packed node-pty materializes/checks its own executable helper.
          prepareNativePty() {}
        });
        entry.engine = engine;
        engine.setProjectRoots(() => [root]);
        engine.setRulesResolver(() => command.rules ?? null);
        engine.setMcpBaseUrl(entry.proxy.baseUrl);
        const onData = (id: string, data: string) => {
          if (!entry.stopped && id === sessionId) options.emit({ terminalId: id, kind: 'terminal.output', payload: { data } });
        };
        const onExit = (id: string, exitCode: number) => {
          if (id !== sessionId || entry.stopped) return;
          options.emit({ terminalId: id, kind: 'terminal.exited', payload: { exitCode } });
          void remove(id, entry);
        };
        engine.on('data', onData); engine.on('exit', onExit);
        entry.cleanup = () => { engine.off('data', onData); engine.off('exit', onExit); };
        // Recheck the exact root immediately before the engine confines cwd.
        const currentRoot = statSync(command.root), currentCwd = statSync(command.cwd ?? root);
        if (realpathSync(command.root) !== root || realpathSync(command.cwd ?? root) !== cwd
          || !lstatSync(command.root).isDirectory()
          || currentRoot.dev !== rootStat.dev || currentRoot.ino !== rootStat.ino
          || currentCwd.dev !== cwdStat.dev || currentCwd.ino !== cwdStat.ino) throw new Error('CLI directory changed during launch');
        const { type: _type, grant: _grant, root: _root, rules: _rules, config: _config, ...launch } = command;
        const session = engine.create({ ...launch, cwd, config, projectId, preallocatedSessionId: sessionId });
        return { pid: session.pid };
      } catch (error) {
        entry.engine?.killAll();
        await remove(sessionId, entry);
        throw error;
      } finally { starting.delete(entry); }
    },
    async writeTerminal(input: { sessionId: string; data: string }): Promise<void> {
      const entry = sessions.get(input.sessionId);
      if (!entry?.engine || entry.stopped) throw new Error('CLI session is unavailable');
      entry.engine.write(input.sessionId, input.data);
    },
    async resizeTerminal(input: { sessionId: string; cols: number; rows: number }): Promise<void> {
      const entry = sessions.get(input.sessionId);
      if (!entry?.engine || entry.stopped) throw new Error('CLI session is unavailable');
      entry.engine.resize(input.sessionId, input.cols, input.rows);
    },
    async stopTerminal(input: { sessionId: string }): Promise<void> {
      const entry = sessions.get(input.sessionId); if (!entry) return;
      entry.engine?.close(input.sessionId);
      await remove(input.sessionId, entry);
    },
    async dispose(): Promise<void> {
      disposed = true;
      await Promise.all([...sessions].map(async ([id, entry]) => {
        entry.engine?.killAll(); await remove(id, entry);
      }));
    }
  };
}
export type EnrolledCli = ReturnType<typeof createEnrolledCli>;
