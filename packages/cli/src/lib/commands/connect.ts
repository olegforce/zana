import type { PreviewList } from '@zana-ai/zcc-contracts/previews';
import { errResult, type CliResult } from '../cli-result.js';
import { productRequest, renderOrJson, type ProductHttpDeps } from '../product-http.js';

export async function runConnectCommand(command: string | undefined, args: string[], json: boolean, deps?: ProductHttpDeps): Promise<CliResult> {
  const usage = 'Usage: zcc connect shares | expose <port> [--host <name-or-id>] | unexpose <port> [--host <name-or-id>]';
  if (!['shares', 'expose', 'unexpose'].includes(command ?? '')) return errResult(usage, 2);
  let body: { port: number; hostId?: string } | undefined;
  if (command === 'shares') { if (args.length) return errResult(usage, 2); }
  else {
    if (!/^[1-9]\d{3,4}$/.test(args[0] ?? '') || Number(args[0]) < 1024 || Number(args[0]) > 65535 || ![1, 3].includes(args.length) || (args.length === 3 && (args[1] !== '--host' || !args[2] || args[2].startsWith('--')))) return errResult(usage, 2);
    body = { port: Number(args[0]), ...(args[2] ? { hostId: args[2] } : {}) };
  }
  const result = await productRequest<PreviewList>(command === 'shares' ? 'GET' : command === 'expose' ? 'POST' : 'DELETE', '/api/v1/previews', { deps, body });
  if (!result.ok) return result.result;
  return renderOrJson(json, result.data, result.data.shares.length ? result.data.shares.map(share => `${share.hostName}:${share.port}\t${share.status}\t${share.url ?? 'Choose a Connect browser address'}\tuntil ${new Date(share.expiresAt).toISOString()}`).join('\n') + '\n' : 'No shared previews\n');
}
