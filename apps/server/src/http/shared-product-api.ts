import type { IncomingMessage, ServerResponse } from 'node:http';
import { validSharedProductCall } from '@zana-ai/zcc-contracts/shared-product';
import { asControlResult, callControlAsProductServer } from './cli-agent-ops.js';
import { readJsonBody, sendJson } from './json.js';
import type { ProductHttpContext } from './product-context.js';
/** Auth/CSRF are enforced by the enclosing product ingress. Main reauthorizes every operation. */
export async function handleSharedProductApi(req: IncomingMessage, res: ServerResponse, ctx: ProductHttpContext, path: string, method: string): Promise<boolean> {
  if (path !== '/api/v1/shared-product') return false;
  if (method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed' }); return true; }
  const input = await readJsonBody(req);
  if (!validSharedProductCall(input) || Buffer.byteLength(JSON.stringify(input)) > 128 * 1024) { sendJson(res, 400, { error: 'Unsupported shared product operation' }); return true; }
  const result = asControlResult(await callControlAsProductServer(ctx.dataDir, 'product.invoke', input));
  sendJson(res, result.ok ? 200 : 503, result);
  return true;
}
