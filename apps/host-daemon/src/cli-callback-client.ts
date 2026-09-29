import { CliCallbackRequestSchema, CliCallbackResponseSchema, CLI_CALLBACK_MAX_RESPONSE_BYTES, cliCallbackPaths, type CliCallbackGrant } from '@zana-ai/zcc-contracts/cli-callbacks';
import { joinServerUrl } from './server-url.js';
import type { CliCallbackRequest, CliCallbackResponse } from './cli-callback-proxy.js';

/** The CLI receives a loopback session capability. Only the daemon adds its
 * enrollment credential to the fixed product-owner endpoint. No retry of POSTs. */
export function createCliCallbackForwarder(options: {
  grant: CliCallbackGrant;
  serverUrl: string;
  hostId: string;
  hostKey: string;
  fetchFn?: typeof fetch;
}): (request: CliCallbackRequest) => Promise<CliCallbackResponse> {
  const paths = cliCallbackPaths(options.grant);
  const url = joinServerUrl(options.serverUrl, '/internal/hosts/cli-callback').href;
  const maxBytes = 4 * Math.ceil(CLI_CALLBACK_MAX_RESPONSE_BYTES / 3) + 4096;
  return async request => {
    if (!paths.has(request.path)) throw new Error('CLI callback path is not granted');
    const body = CliCallbackRequestSchema.parse({ sessionId: options.grant.sessionId, path: request.path, headers: request.headers, bodyBase64: request.body.toString('base64') });
    request.signal.throwIfAborted();
    const response = await (options.fetchFn ?? fetch)(url, {
      method: 'POST', redirect: 'error', signal: request.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${options.hostKey}`, 'x-zcc-host-id': options.hostId },
      body: JSON.stringify(body)
    });
    const reader = response.body?.getReader();
    try {
      if (response.status !== 200) throw new Error(`CLI callback rejected (${response.status})`);
      const advertised = response.headers.get('content-length');
      if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > maxBytes)) throw new Error('CLI callback response exceeds limit');
      const chunks: Buffer[] = []; let size = 0;
      if (reader) {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maxBytes) throw new Error('CLI callback response exceeds limit');
          chunks.push(Buffer.from(chunk.value));
        }
      }
      const result = CliCallbackResponseSchema.parse(JSON.parse(Buffer.concat(chunks, size).toString('utf8')));
      const bytes = Buffer.from(result.bodyBase64, 'base64');
      if (bytes.length > CLI_CALLBACK_MAX_RESPONSE_BYTES || bytes.toString('base64') !== result.bodyBase64) throw new Error('Invalid CLI callback response');
      return { status: result.status, contentType: result.contentType, body: bytes };
    } finally { await reader?.cancel().catch(() => undefined); }
  };
}
