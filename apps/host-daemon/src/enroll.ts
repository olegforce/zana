import { homedir } from 'node:os';
import {
  HOST_RPC_PROTOCOL_VERSION,
  HostEnrollRequestSchema,
  HostEnrollResponseSchema,
  type HostEnrollResponse
} from '@zana-ai/zcc-contracts/host-rpc';
import { joinServerUrl } from './server-url.js';

export const HOST_ENROLL_TIMEOUT_MS = 15_000;
export const HOST_ENROLL_MAX_RESPONSE_BYTES = 16 * 1024;

async function readEnrollmentResponse(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty host enrollment response');
  // Node 22 can leave a streamed body pending after fetch's signal is aborted.
  // Cancel our reader directly; a stalled source's cancel promise must not
  // prevent the pending read from closing and releasing the enrollment lock.
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (signal.aborted) abort();
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) return Buffer.concat(chunks).toString('utf8');
      size += value.byteLength;
      if (size > HOST_ENROLL_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Host enrollment response is too large');
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

export async function enrollDaemonHost(input: {
  serverUrl: string;
  token: string;
  hostName: string;
  instanceId: string;
  hostId?: string;
  homeDir?: string;
  fetchFn?: typeof fetch;
}): Promise<HostEnrollResponse> {
  const fetchFn = input.fetchFn ?? fetch;
  const controller = new AbortController();
  // Covers response streaming as well as connection/headers. A stalled server
  // must release the installation lock instead of hanging enrollment forever.
  const timer = setTimeout(() => controller.abort(), HOST_ENROLL_TIMEOUT_MS);
  timer.unref();
  try {
    const response = await fetchFn(joinServerUrl(input.serverUrl, '/internal/hosts/enroll'), {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: {
        authorization: `Bearer ${input.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(HostEnrollRequestSchema.parse({
        protocolVersion: HOST_RPC_PROTOCOL_VERSION,
        hostName: input.hostName,
        instanceId: input.instanceId,
        homeDir: input.homeDir ?? homedir(),
        ...(input.hostId ? { hostId: input.hostId } : {})
      }))
    });
    const body = await readEnrollmentResponse(response, controller.signal);
    if (response.status !== 201) {
      // Remote error bodies can echo credentials. Status is sufficient for
      // the caller's protocol-upgrade detection (409), without logging them.
      throw new Error(`Failed to enroll daemon host: ${response.status}`);
    }
    let enrolled: HostEnrollResponse;
    try { enrolled = HostEnrollResponseSchema.parse(JSON.parse(body)); }
    // JSON/schema errors can quote response contents, including echoed secrets.
    catch { throw new Error('Invalid host enrollment response'); }
    if (input.hostId && enrolled.hostId !== input.hostId) throw new Error('Host enrollment returned a different machine');
    return enrolled;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Host enrollment timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
