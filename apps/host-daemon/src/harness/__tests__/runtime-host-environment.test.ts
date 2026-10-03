import { describe, expect, it, vi } from 'vitest';
import type { RuntimeSupervisor } from '../../../../desktop/src/runtime/runtime-supervisor.js';
import type { TerminalHostEvent } from '@zana-ai/zcc-contracts/terminal-execution';
import { TERMINAL_HOST_PROTOCOL_VERSION } from '@zana-ai/zcc-contracts/terminal-execution';
import { createRuntimeHostExecutionEnvironment } from '../runtime-host-environment.js';

const deadline = '2026-08-19T12:00:05.000Z';
const binding = {
  hostId: '00000000-0000-4000-8000-000000000011',
  instanceId: '00000000-0000-4000-8000-000000000012',
  hostConnectionId: '00000000-0000-4000-8000-000000000013'
};

describe('runtime host execution environment', () => {
  it('keeps local environment wrappers transparent and releases a failed live channel', async () => {
    const unsubscribe = vi.fn();
    const runtime = {
      onTerminalEvent: () => unsubscribe,
      executeTerminal: async (command: { kind: string; sessionId: string }) => {
        if (command.kind === 'start') return [{ kind: 'started', protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION, binding, sessionId: command.sessionId, launchEpoch: 0, pid: 12 }];
        throw new Error('server disconnected');
      },
      terminalEventsSince: async () => { throw new Error('replay unavailable'); },
    } as unknown as RuntimeSupervisor;
    const environment = createRuntimeHostExecutionEnvironment({ runtime });
    const inner = { command: '/bin/zsh', args: [] };
    const env = { PATH: '/bin' };
    expect(environment.wrap(inner, {} as never)).toBe(inner);
    expect(environment.rewriteCallbackEnv(env, {} as never)).toBe(env);
    expect(environment.status({} as never)).toEqual({ isolated: false });
    const session = await environment.createSession!(inner, { sessionId: 'failed-channel', projectId: 'project-1', cwd: '/workspace', cols: 80, rows: 24, sessionEnv: {} });
    const exits: number[] = [];
    session.onData(() => {});
    session.onExit(({ exitCode }) => exits.push(exitCode));
    await new Promise(resolve => setTimeout(resolve, 0));
    session.write('probe');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(exits).toEqual([-1]);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    session.resize(90, 30);
    session.kill();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(exits).toEqual([-1]);
  });

  it('releases every terminal listener when repeated start commands reject', async () => {
    const listeners = new Set<(event: TerminalHostEvent) => void>();
    const unsubscribe = vi.fn((listener: (event: TerminalHostEvent) => void) => listeners.delete(listener));
    const failure = new Error('server terminal-execute request timed out');
    const runtime = {
      onTerminalEvent: (listener: (event: TerminalHostEvent) => void) => {
        listeners.add(listener);
        return () => { unsubscribe(listener); };
      },
      executeTerminal: vi.fn().mockRejectedValue(failure),
    } as unknown as RuntimeSupervisor;
    const environment = createRuntimeHostExecutionEnvironment({ runtime });
    for (let index = 0; index < 100; index += 1) {
      await expect(environment.createSession!(
        { command: '/bin/zsh', args: [] },
        { sessionId: `failed-${index}`, projectId: 'project-1', cwd: '/workspace', cols: 80, rows: 24, sessionEnv: {} },
      )).rejects.toBe(failure);
      expect(listeners.size).toBe(0);
    }
    expect(unsubscribe).toHaveBeenCalledTimes(100);
  });

  it('owns local shell I/O through signed server-host commands', async () => {
    const commands: unknown[] = [];
    let listener: ((event: TerminalHostEvent) => void) | null = null;
    const runtime: RuntimeSupervisor = {
      rendererUrl: 'http://127.0.0.1:1/',
      hostUrl: 'http://127.0.0.1:2',
      hostToken: 'token',
      hostSigningKey: 'key',
      appVersion: async () => '',
      listProjects: async () => [],
      addProject: async () => { throw new Error('not used'); },
      updateProject: async () => { throw new Error('not used'); },
      reorderProjects: async () => { throw new Error('not used'); },
      touchProject: async () => { throw new Error('not used'); },
      removeProject: async () => null,
      getProjectSettings: async () => ({}),
      setProjectSettings: async () => ({}),
      recordTerminalEvent: async () => true,
      terminalEventsSince: async () => [],
      executeTerminal: async (command) => {
        commands.push(command);
        if (command.kind !== 'start') return [];
        return [
          { kind: 'accepted', protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION, binding, commandId: command.commandId, sessionId: 'session-1', launchEpoch: 0, hostSessionId: 'host-1' },
          { kind: 'started', protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION, binding, sessionId: 'session-1', launchEpoch: 0, pid: 1234 }
        ];
      },
      onTerminalEvent: (next) => {
        listener = next;
        return () => { listener = null; };
      },
      onProjectSettingsChanged: () => () => {},
      onPluginCapabilitiesChanged: () => () => {},
      listPluginApps: async () => [],
      onPluginAppsChanged: () => () => {},
      installPlugin: async () => { throw new Error('not used'); },
      enablePlugin: async () => { throw new Error('not used'); },
      disablePlugin: async () => { throw new Error('not used'); },
      removePlugin: async () => { throw new Error('not used'); },
      reloadPlugin: async () => { throw new Error('not used'); },
      searchPlugins: async () => [],
      outdatedPlugins: async () => [],
      updatePlugin: async () => { throw new Error('not used'); },
      listMarketplaces: async () => [],
      addMarketplace: async () => { throw new Error('not used'); },
      refreshMarketplace: async () => { throw new Error('not used'); },
      removeMarketplace: async () => { throw new Error('not used'); },
      callPluginRpc: async () => { throw new Error('not used'); },
      getPluginSettings: async () => ({ descriptors: {}, values: {} }),
      setPluginSettings: async () => { throw new Error('not used'); },
      relaunchEnrolledHost: async () => ({ ok: true as const }),
      pluginLogs: async () => [],
      pluginCliContributions: async () => [],
      runPluginCli: async () => { throw new Error('not used'); },
      close: async () => {}
    };
    const environment = createRuntimeHostExecutionEnvironment({
      runtime,
      now: () => Date.parse('2026-08-19T12:00:00.000Z'),
      commandId: (() => {
        let next = 1;
        return () => `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`;
      })()
    });

    const session = await environment.createSession!(
      { command: '/bin/zsh', args: ['-l'] },
      {
        sessionId: 'session-1',
        projectId: 'project-1',
        cwd: '/workspace',
        cols: 80,
        rows: 24,
        sessionEnv: { ZCC_MCP_URL: 'http://127.0.0.1:3000/mcp' },
        spawnEnv: { PATH: '/usr/bin', ZCC_MCP_URL: 'http://127.0.0.1:3000/mcp' }
      }
    );

    expect(session.pid).toBe(1234);
    expect(commands).toEqual([
      {
        kind: 'start',
        protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
        commandId: '00000000-0000-4000-8000-000000000001',
        sessionId: 'session-1',
        launchEpoch: 0,
        deadlineAt: deadline,
        projectId: 'project-1',
        launch: {
          argv: ['/bin/zsh', '-l'],
          cwd: '/workspace',
          env: { PATH: '/usr/bin', ZCC_MCP_URL: 'http://127.0.0.1:3000/mcp' },
          cols: 80,
          rows: 24,
          mode: 'local-pty'
        }
      }
    ]);

    const output: string[] = [];
    const exits: number[] = [];
    session.onData((data) => output.push(data));
    session.onExit(({ exitCode }) => exits.push(exitCode));
    expect(listener).not.toBeNull();
    listener!({ kind: 'output', protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION, binding, sessionId: 'session-1', launchEpoch: 0, sequence: 0, data: 'hello' });
    session.write('echo hi\r');
    session.resize(120, 40);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(commands.slice(1)).toEqual([
      expect.objectContaining({ kind: 'write', data: 'echo hi\r', sessionId: 'session-1', launchEpoch: 0, deadlineAt: deadline }),
      expect.objectContaining({ kind: 'resize', cols: 120, rows: 40, sessionId: 'session-1', launchEpoch: 0, deadlineAt: deadline })
    ]);
    listener!({ kind: 'exited', protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION, binding, sessionId: 'session-1', launchEpoch: 0, sequence: 1, code: 0, expected: false });
    expect(output).toEqual(['hello']);
    expect(exits).toEqual([0]);

    const expectedSession = await environment.createSession!(
      { command: '/bin/zsh', args: [] },
      { sessionId: 'session-1', projectId: 'project-1', cwd: '/workspace', cols: 80, rows: 24, sessionEnv: {}, spawnEnv: {} }
    );
    expectedSession.terminateExpected!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(commands.at(-1)).toEqual(expect.objectContaining({ kind: 'terminate', expected: true }));
  });

  it('fails closed when the host does not acknowledge a terminal start', async () => {
    const runtime: RuntimeSupervisor = {
      rendererUrl: 'http://127.0.0.1:1/',
      hostUrl: 'http://127.0.0.1:2',
      hostToken: 'token',
      hostSigningKey: 'key',
      appVersion: async () => '',
      listProjects: async () => [],
      addProject: async () => { throw new Error('not used'); },
      updateProject: async () => { throw new Error('not used'); },
      reorderProjects: async () => { throw new Error('not used'); },
      touchProject: async () => { throw new Error('not used'); },
      removeProject: async () => null,
      getProjectSettings: async () => ({}),
      setProjectSettings: async () => ({}),
      recordTerminalEvent: async () => true,
      terminalEventsSince: async () => [],
      executeTerminal: async (command) => [{ kind: 'rejected', protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION, binding, commandId: command.commandId, sessionId: command.sessionId, launchEpoch: command.launchEpoch, reason: 'host unavailable' }],
      onTerminalEvent: () => () => {},
      onProjectSettingsChanged: () => () => {},
      onPluginCapabilitiesChanged: () => () => {},
      listPluginApps: async () => [],
      onPluginAppsChanged: () => () => {},
      installPlugin: async () => { throw new Error('not used'); },
      enablePlugin: async () => { throw new Error('not used'); },
      disablePlugin: async () => { throw new Error('not used'); },
      removePlugin: async () => { throw new Error('not used'); },
      reloadPlugin: async () => { throw new Error('not used'); },
      searchPlugins: async () => [],
      outdatedPlugins: async () => [],
      updatePlugin: async () => { throw new Error('not used'); },
      listMarketplaces: async () => [],
      addMarketplace: async () => { throw new Error('not used'); },
      refreshMarketplace: async () => { throw new Error('not used'); },
      removeMarketplace: async () => { throw new Error('not used'); },
      callPluginRpc: async () => { throw new Error('not used'); },
      getPluginSettings: async () => ({ descriptors: {}, values: {} }),
      setPluginSettings: async () => { throw new Error('not used'); },
      relaunchEnrolledHost: async () => ({ ok: true as const }),
      pluginLogs: async () => [],
      pluginCliContributions: async () => [],
      runPluginCli: async () => { throw new Error('not used'); },
      close: async () => {}
    };
    const environment = createRuntimeHostExecutionEnvironment({ runtime });

    await expect(environment.createSession!(
      { command: '/bin/zsh', args: [] },
      { sessionId: 'session-1', projectId: 'project-1', cwd: '/workspace', cols: 80, rows: 24, sessionEnv: {}, spawnEnv: {} }
    )).rejects.toThrow('host unavailable');
  });

  it('replays bounded host output before delivering live events without duplication', async () => {
    const commands: Array<{ kind: string; afterSequence?: number }> = [];
    let listener: ((event: TerminalHostEvent) => void) | null = null;
    const runtime: RuntimeSupervisor = {
      rendererUrl: 'http://127.0.0.1:1/',
      hostUrl: 'http://127.0.0.1:2',
      hostToken: 'token',
      hostSigningKey: 'key',
      appVersion: async () => '',
      listProjects: async () => [],
      addProject: async () => { throw new Error('not used'); },
      updateProject: async () => { throw new Error('not used'); },
      reorderProjects: async () => { throw new Error('not used'); },
      touchProject: async () => { throw new Error('not used'); },
      removeProject: async () => null,
      getProjectSettings: async () => ({}),
      setProjectSettings: async () => ({}),
      recordTerminalEvent: async () => true,
      terminalEventsSince: async (_sessionId, afterSequence) => {
        commands.push({ kind: 'events-since', afterSequence });
        listener!({ kind: 'output', protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION, binding, sessionId: 'session-1', launchEpoch: 0, sequence: 2, data: 'live' });
        return [
          { kind: 'output', protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION, binding, sessionId: 'session-1', launchEpoch: 0, sequence: 0, data: 'zero' },
          { kind: 'output', protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION, binding, sessionId: 'session-1', launchEpoch: 0, sequence: 1, data: 'one' }
        ];
      },
      executeTerminal: async (command) => {
        commands.push(command);
        if (command.kind === 'start') {
          return [
            { kind: 'accepted', protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION, binding, commandId: command.commandId, sessionId: command.sessionId, launchEpoch: 0, hostSessionId: 'host-1' },
            { kind: 'started', protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION, binding, sessionId: command.sessionId, launchEpoch: 0, pid: 1234 }
          ];
        }
        return [];
      },
      onTerminalEvent: (next) => {
        listener = next;
        return () => { listener = null; };
      },
      onProjectSettingsChanged: () => () => {},
      onPluginCapabilitiesChanged: () => () => {},
      listPluginApps: async () => [],
      onPluginAppsChanged: () => () => {},
      installPlugin: async () => { throw new Error('not used'); },
      enablePlugin: async () => { throw new Error('not used'); },
      disablePlugin: async () => { throw new Error('not used'); },
      removePlugin: async () => { throw new Error('not used'); },
      reloadPlugin: async () => { throw new Error('not used'); },
      searchPlugins: async () => [],
      outdatedPlugins: async () => [],
      updatePlugin: async () => { throw new Error('not used'); },
      listMarketplaces: async () => [],
      addMarketplace: async () => { throw new Error('not used'); },
      refreshMarketplace: async () => { throw new Error('not used'); },
      removeMarketplace: async () => { throw new Error('not used'); },
      callPluginRpc: async () => { throw new Error('not used'); },
      getPluginSettings: async () => ({ descriptors: {}, values: {} }),
      setPluginSettings: async () => { throw new Error('not used'); },
      relaunchEnrolledHost: async () => ({ ok: true as const }),
      pluginLogs: async () => [],
      pluginCliContributions: async () => [],
      runPluginCli: async () => { throw new Error('not used'); },
      close: async () => {}
    };
    const environment = createRuntimeHostExecutionEnvironment({ runtime });
    const session = await environment.createSession!(
      { command: '/bin/zsh', args: [] },
      { sessionId: 'session-1', projectId: 'project-1', cwd: '/workspace', cols: 80, rows: 24, sessionEnv: {}, spawnEnv: {} }
    );
    const output: string[] = [];

    session.onData((data) => output.push(data));
    await new Promise((resolve) => setTimeout(resolve, 0));
    listener!({ kind: 'output', protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION, binding, sessionId: 'session-1', launchEpoch: 0, sequence: 2, data: 'duplicate' });
    listener!({ kind: 'output', protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION, binding, sessionId: 'session-1', launchEpoch: 0, sequence: 3, data: 'three' });

    expect(commands.find((command) => command.kind === 'events-since')).toMatchObject({ afterSequence: -1 });
    expect(output).toEqual(['zero', 'one', 'live', 'three']);
  });
});
