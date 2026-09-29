export const PRODUCT_TERMINAL_OUTPUT_MAX_BYTES = 256 * 1024;

export interface BoundedTerminalOutput {
  text: string;
  truncated: boolean;
}

export function appendBoundedTerminalOutput(
  current: BoundedTerminalOutput | undefined,
  chunk: string,
  maxBytes = PRODUCT_TERMINAL_OUTPUT_MAX_BYTES
): BoundedTerminalOutput {
  const next = `${current?.text ?? ''}${chunk}`;
  const encoded = Buffer.from(next, 'utf8');
  if (encoded.byteLength <= maxBytes) {
    return { text: next, truncated: current?.truncated ?? false };
  }
  return { text: utf8Tail(encoded, maxBytes), truncated: true };
}

export function terminalOutputSlice(
  buffer: BoundedTerminalOutput | undefined,
  tailBytes?: number
): BoundedTerminalOutput {
  const text = buffer?.text ?? '';
  const truncated = buffer?.truncated ?? false;
  if (tailBytes === undefined || !Number.isFinite(tailBytes) || tailBytes < 0) {
    return { text, truncated };
  }
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.byteLength <= tailBytes) return { text, truncated };
  return {
    text: utf8Tail(encoded, tailBytes),
    truncated: true
  };
}

/** Discard an incomplete leading code point instead of emitting replacement bytes. */
function utf8Tail(bytes: Buffer, requested: number): string {
  const limit = Math.max(0, Math.floor(requested));
  let start = Math.max(0, bytes.length - limit);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}
