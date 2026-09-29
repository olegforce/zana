import { SERVER_RUNTIME_PROTOCOL_VERSION, ServerRuntimeInboundSchema, type ServerRuntimeInbound } from '@zana-ai/zcc-contracts/runtime';

/** EventEmitter does not await listeners. Always return request failures to main
 * so invalid installs and offline operations cannot become silent timeouts. */
export async function dispatchRuntimeMessage(
  data: unknown,
  postMessage: (message: unknown) => void,
  handle: (message: ServerRuntimeInbound) => Promise<void>
): Promise<void> {
  const parsed = ServerRuntimeInboundSchema.safeParse(data);
  if (!parsed.success) {
    postMessage({ type: 'error', protocolVersion: SERVER_RUNTIME_PROTOCOL_VERSION, message: 'invalid server runtime message' });
    return;
  }
  try { await handle(parsed.data); }
  catch (error) {
    postMessage({
      type: 'error', protocolVersion: SERVER_RUNTIME_PROTOCOL_VERSION,
      ...('id' in parsed.data ? { id: parsed.data.id } : {}),
      message: (error instanceof Error ? error.message : String(error)).slice(0, 8192)
    });
  }
}
