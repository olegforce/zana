import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexProvider } from '../codex/provider.js';

// Parse the provider's actual argv in Codex without a model call, credentials,
// or the user's config. An argv snapshot alone missed quoted CLI key segments.
async function readMcpConfig(args: string[]): Promise<Record<string, unknown>> {
  const home = await mkdtemp(join(tmpdir(), 'zcc-codex-approval-'));
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.env.ZCC_CODEX_BIN || 'codex', [...args, 'app-server', '--stdio'], {
        cwd: home,
        env: { ...process.env, CODEX_HOME: home },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let buffer = '';
      let bytes = 0;
      let result: Record<string, unknown> | undefined;
      let failure: Error | undefined;
      const fail = (error: Error) => { failure ??= error; child.kill('SIGKILL'); };
      const timer = setTimeout(() => fail(new Error('Codex config/read timed out')), 15_000);
      const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
      child.stdin.on('error', fail);
      child.on('error', fail);
      child.stderr.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) fail(new Error('Codex inspection output exceeded 1 MiB'));
      });
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { fail(new Error('Codex inspection output exceeded 1 MiB')); return; }
        buffer += chunk.toString();
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line);
            if (message.error) throw new Error(JSON.stringify(message.error));
            if (message.id === 1) {
              send({ method: 'initialized' });
              send({ id: 2, method: 'config/read', params: { includeLayers: false } });
            } else if (message.id === 2) {
              result = message.result.config.mcp_servers['zcc-inbox'];
              child.kill('SIGKILL');
            }
          } catch (error) { fail(error as Error); }
        }
      });
      child.on('close', () => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else if (result) resolve(result);
        else reject(new Error('Codex exited without a config/read result'));
      });
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'zcc-approval-test', version: '1.0' } } });
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe.skipIf(process.env.ZCC_LIVE_CODEX !== '1')('native Codex MCP approvals', () => {
  const provider = new CodexProvider();
  const serverArgs = provider.mcpArgs('codex', 'http://127.0.0.1:9');

  it('applies exact dotted and plain tool names', async () => {
    const config = await readMcpConfig([...serverArgs, ...provider.mcpApprovalArgs('codex', {
      tools: ['execution.work.complete', 'execution.work.block', 'inbox_push']
    })]);
    expect(config.tools).toEqual({
      'execution.work.complete': { approval_mode: 'approve' },
      'execution.work.block': { approval_mode: 'approve' },
      inbox_push: { approval_mode: 'approve' }
    });
    expect(config.default_tools_approval_mode).toBeUndefined();
  }, 20_000);

  it('applies explicit server-wide trust without per-tool entries', async () => {
    const config = await readMcpConfig([...serverArgs, ...provider.mcpApprovalArgs('codex', {
      defaultToolsApprovalMode: 'approve'
    })]);
    expect(config.default_tools_approval_mode).toBe('approve');
    expect(config.tools).toBeUndefined();
  }, 20_000);
});
