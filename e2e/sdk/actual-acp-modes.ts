import { createAcpAgentConnection } from '../../packages/provider-bridge-acp/src/bridge/agent-connection.js';
import { acpInitializeResultSchema, acpSessionNewResultSchema } from '../../plugins/provider-acp/src/wire.js';

/** Query the installed CLI independently of the product's cached catalog.
 * Reuses the BB-derived stdio connection; never sends a model prompt. */
export async function actualOpenCodeModeLabels(cwd: string): Promise<string[]> {
  const connection = createAcpAgentConnection({
    command: 'opencode', args: ['acp'], cwd, env: { ...process.env }, recordThreadId: null,
    onNotification: () => {}, onRequest: (_method, _params, responder) => responder.error(-32601, 'Probe does not support client requests'), onExit: () => {},
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        await connection.request({ method: 'initialize', params: {
          protocolVersion: 1, clientInfo: { name: 'zana-e2e', version: '1' },
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        }, resultSchema: acpInitializeResultSchema });
        const session = await connection.request({ method: 'session/new', params: { cwd, mcpServers: [] }, resultSchema: acpSessionNewResultSchema });
        const modes = session.configOptions?.find(option => option.category === 'mode' || option.id === 'mode')?.options;
        if (!modes?.length) throw new Error('Installed OpenCode did not advertise session modes');
        return modes.map(mode => mode.value === 'build' ? 'Agent' : mode.value === 'plan' ? 'Plan' : mode.name ?? mode.value);
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Installed OpenCode mode probe timed out')), 30_000); }),
    ]);
  } finally { clearTimeout(timer); connection.kill(); }
}
