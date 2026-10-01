import { z } from 'zod';
import type { DynamicTool, ToolCallResponse } from '@zana-ai/zcc-domain/thread-runtime';
import type { ProductHttpContext } from '../../http/product-context.js';
import { previewService } from '../previews/preview-service.js';
import { pluginToolResultToResponse } from '../../plugins/plugin-agent-tools.js';

export const SHARE_PREVIEW_TOOL: DynamicTool = {
  name: 'share_preview',
  description: 'Share a running HTTP dev server on this thread’s execution machine through your private Zana Connect address. Use for a requested phone or remote preview. action=list shows previews; action=stop removes this thread’s share. Expires after eight hours, renewed by another share call. Requires Remote access. Does not start the server.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { action: { type: 'string', enum: ['share', 'list', 'stop'] }, port: { type: 'integer', minimum: 1024, maximum: 65535 } }, required: ['action'] }
};
const schema = z.object({ action: z.enum(['share', 'list', 'stop']), port: z.number().int().min(1024).max(65535).optional() }).strict();
export async function invokeSharePreview(ctx: ProductHttpContext, args: { threadId: string; input: unknown }): Promise<ToolCallResponse> {
  try {
    const input = schema.parse(args.input);
    const result = input.action === 'list' ? await previewService(ctx).list(args.threadId) : input.port === undefined ? (() => { throw new Error('port is required'); })() : await previewService(ctx).change({ port: input.port }, input.action === 'stop', args.threadId);
    return pluginToolResultToResponse('share_preview', { content: [{ type: 'text', text: JSON.stringify(result) }] });
  } catch (error) { return pluginToolResultToResponse('share_preview', { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Preview unavailable' }] }); }
}
