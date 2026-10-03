/**
 * The largest single JSON-RPC line either side of the bridge wire will
 * assemble. Real traffic is far below this: the biggest messages are tool
 * results and item payloads, which the producers already bound. The cap
 * exists because `readline` does not have one — an unterminated or runaway
 * line grows its internal buffer until the process dies, and the bridge is
 * now third-party code on both sides of that pipe.
 */
export const MAX_JSON_RPC_LINE_BYTES = 64 * 1024 * 1024;

export interface BoundedLineReaderArgs {
  input: NodeJS.ReadableStream;
  /** Complete lines, without their terminator. */
  onLine: (line: string) => void;
  /**
   * An oversized line was discarded (bytes counted so far when the cap was
   * passed). Reading continues from the next terminator, so one runaway
   * message costs its own content and nothing else.
   */
  onOverflow: (bytes: number) => void;
  onClose?: () => void;
  maxLineBytes?: number;
}

/**
 * Newline-delimited reader with a hard per-line cap — `readline` with the
 * bound it lacks. CR is stripped so a CRLF producer parses as JSON.
 */
export function readBoundedLines(args: BoundedLineReaderArgs): void {
  const maxLineBytes = args.maxLineBytes ?? MAX_JSON_RPC_LINE_BYTES;
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 0) {
    throw new RangeError("maxLineBytes must be a non-negative safe integer");
  }
  // Coalesce even one-byte input chunks into bounded blocks. Keeping each
  // incoming chunk would otherwise need up to maxLineBytes array entries.
  const blockBytes = Math.max(1, Math.min(maxLineBytes, 64 * 1024));
  let blocks: Buffer[] = [];
  let block: Buffer | null = null;
  let blockUsed = 0;
  let lineBytes = 0;
  let discarding = false;

  function clearLine(): void {
    blocks = [];
    block = null;
    blockUsed = 0;
    lineBytes = 0;
    discarding = false;
  }

  function append(chunk: Buffer, start: number, end: number): void {
    lineBytes += end - start;
    if (discarding) return;
    if (lineBytes > maxLineBytes) {
      discarding = true;
      blocks = [];
      block = null;
      blockUsed = 0;
      return;
    }
    while (start < end) {
      block ??= Buffer.allocUnsafe(blockBytes);
      const copied = Math.min(end - start, blockBytes - blockUsed);
      chunk.copy(block, blockUsed, start, start + copied);
      blockUsed += copied;
      start += copied;
      if (blockUsed === blockBytes) {
        blocks.push(block);
        block = null;
        blockUsed = 0;
      }
    }
  }

  function emit(): void {
    if (block !== null) blocks.push(block.subarray(0, blockUsed));
    // Decode once per complete line, preserving UTF-8 split across chunks and
    // avoiding a rescan of the entire pending line on every data event.
    const line = Buffer.concat(blocks, lineBytes).toString("utf8");
    clearLine();
    args.onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  }

  args.input.on("data", (chunk: Buffer | string) => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    let start = 0;
    for (;;) {
      const newlineIndex = bytes.indexOf(10, start);
      if (newlineIndex === -1) {
        break;
      }
      append(bytes, start, newlineIndex);
      if (discarding) {
        const discardedBytes = lineBytes;
        clearLine();
        args.onOverflow(discardedBytes);
      } else {
        emit();
      }
      start = newlineIndex + 1;
    }
    append(bytes, start, bytes.length);
  });

  args.input.on("end", () => {
    if (!discarding && lineBytes > 0) {
      emit();
    }
    clearLine();
    args.onClose?.();
  });
  // A destroyed child pipe can close without end; release its partial frame.
  args.input.once("close", clearLine);
}
