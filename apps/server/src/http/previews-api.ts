import type { IncomingMessage, ServerResponse } from 'node:http';
import { PreviewInputSchema } from '@zana-ai/zcc-contracts/previews';
import type { ProductHttpContext } from './product-context.js';
import { readJsonBody, sendJson } from './json.js';
import { previewService } from '../services/previews/preview-service.js';

export async function handlePreviewsApi(req: IncomingMessage, res: ServerResponse, ctx: ProductHttpContext, path: string, method: string): Promise<boolean> {
  if (path !== '/api/v1/previews') return false;
  try {
    if (req.headers['x-zcc-caller-session-id'] !== undefined || req.headers['x-zcc-caller-credential'] !== undefined) {
      sendJson(res, 403, { error: 'Use the share_preview tool from an agent thread; preview commands in a host shell are operator actions.' }); return true;
    }
    if (method === 'GET') sendJson(res, 200, await previewService(ctx).list());
    else if (method === 'POST' || method === 'DELETE') {
      const parsed = PreviewInputSchema.safeParse(await readJsonBody(req));
      if (!parsed.success) { sendJson(res, 400, { error: 'Choose a port between 1024 and 65535 and a registered machine' }); return true; }
      sendJson(res, 200, await previewService(ctx).change(parsed.data, method === 'DELETE'));
    } else sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) { sendJson(res, 409, { error: error instanceof Error ? error.message : 'Preview unavailable' }); }
  return true;
}
