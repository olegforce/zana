import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createBoundedLineFramer, readBoundedLines } from "./bounded-line-reader.js";

function readAll(
  chunks: (string | Buffer)[],
  maxLineBytes?: number,
): Promise<{ lines: string[]; overflows: number[] }> {
  const lines: string[] = [];
  const overflows: number[] = [];
  const input = Readable.from(chunks);
  return new Promise((resolve) => {
    readBoundedLines({
      input,
      maxLineBytes,
      onLine: (line) => lines.push(line),
      onOverflow: (bytes) => overflows.push(bytes),
      onClose: () => resolve({ lines, overflows }),
    });
  });
}

describe("readBoundedLines", () => {
  it("reassembles lines split across chunks and strips CR", async () => {
    const { lines, overflows } = await readAll(
      ['{"a":', '1}\n{"b":2}\r\n', "trailing-without-newline"],
      1024,
    );
    expect(lines).toEqual(['{"a":1}', '{"b":2}', "trailing-without-newline"]);
    expect(overflows).toEqual([]);
  });

  // The whole point: `readline` would buffer this to death instead.
  it("discards a line past the cap and resumes at the next one", async () => {
    const { lines, overflows } = await readAll(
      ["ok-1\n", "x".repeat(50), "y".repeat(50), "\nok-2\n"],
      64,
    );
    expect(lines).toEqual(["ok-1", "ok-2"]);
    expect(overflows).toHaveLength(1);
    expect(overflows[0]).toBeGreaterThanOrEqual(100);
  });

  it("never emits an unterminated oversized tail at end of stream", async () => {
    const { lines, overflows } = await readAll(["z".repeat(500)], 64);
    expect(lines).toEqual([]);
    expect(overflows).toEqual([]);
  });

  it("rejects oversized complete lines and recovers within the same chunk", async () => {
    const result = await readAll(["12345\nok\nabcdef\nz\n"], 4);
    expect(result).toEqual({ lines: ["ok", "z"], overflows: [5, 6] });
  });

  it("checks a split line before emitting its terminating chunk", async () => {
    const result = await readAll(["123", "456\nnext\n"], 4);
    expect(result).toEqual({ lines: ["next"], overflows: [6] });
  });

  it("counts every byte discarded through the terminator", async () => {
    const result = await readAll(["12345", "678", "90\n", "ok"], 4);
    expect(result).toEqual({ lines: ["ok"], overflows: [10] });
  });

  it("accepts exact-cap lines at a terminator and at end of stream", async () => {
    const result = await readAll(["1234\n", "12", "34"], 4);
    expect(result).toEqual({ lines: ["1234", "1234"], overflows: [] });
  });

  it("preserves multibyte UTF-8 across byte chunks and counts bytes", async () => {
    const emoji = Buffer.from("🙂");
    const result = await readAll([
      emoji.subarray(0, 1), emoji.subarray(1, 3), emoji.subarray(3),
      Buffer.from("\nééé\na\n"),
    ], 4);
    expect(result).toEqual({ lines: ["🙂", "a"], overflows: [6] });
  });

  it("counts the CR byte while stripping accepted CRLF terminators", async () => {
    const result = await readAll(["abc", "\r", "\nabcd\r\nok\r\n"], 4);
    expect(result).toEqual({ lines: ["abc", "ok"], overflows: [5] });
  });

  it("handles empty chunks and blank lines with a zero-byte cap", async () => {
    const result = await readAll(["", Buffer.alloc(0), "\nx\n\n"], 0);
    expect(result).toEqual({ lines: ["", ""], overflows: [1] });
  });

  it("decodes an incomplete UTF-8 sequence at end of stream", async () => {
    expect(await readAll([Buffer.from([0xe2, 0x82])], 2)).toEqual({
      lines: ["�"], overflows: [],
    });
  });

  it("assembles large valid lines from many blocks using the default cap", async () => {
    const size = 4 * 1024 * 1024;
    const chunks = Array.from({ length: size / 1024 }, () => Buffer.alloc(1024, "x"));
    chunks.push(Buffer.from("\nshort\n"));
    const result = await readAll(chunks);
    expect(result.lines).toEqual(["x".repeat(size), "short"]);
    expect(result.overflows).toEqual([]);
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid byte cap %s before subscribing",
    (maxLineBytes) => {
      const input = Readable.from([]);
      expect(() => readBoundedLines({
        input, maxLineBytes, onLine: () => {}, onOverflow: () => {},
      })).toThrow(RangeError);
      expect(input.listenerCount("data")).toBe(0);
    },
  );

  it("does not require an end-of-stream callback", async () => {
    const input = Readable.from(["ok"]);
    const lines: string[] = [];
    readBoundedLines({ input, maxLineBytes: 4, onLine: line => lines.push(line), onOverflow: () => {} });
    await new Promise<void>(resolve => input.on("end", resolve));
    expect(lines).toEqual(["ok"]);
  });

  it("releases a partial frame when a pipe closes without an end event", () => {
    const input = new Readable({ read() {} });
    const lines: string[] = [];
    readBoundedLines({ input, onLine: line => lines.push(line), onOverflow: () => {} });
    input.emit("data", Buffer.from("partial"));
    input.emit("close");
    input.emit("end");
    expect(lines).toEqual([]);
  });
});

describe("bounded byte framer", () => {
  it("reads only a Uint8Array view rather than its backing allocation", () => {
    const lines: string[] = [];
    const framer = createBoundedLineFramer({
      onLine: line => lines.push(line), onOverflow: () => {}, maxLineBytes: 4,
    });
    const allocation = Uint8Array.from(Buffer.from("ignoredok\nignored"));
    framer.push(allocation.subarray(7, 10));
    expect(lines).toEqual(["ok"]);
  });

  it("clears partial and discarded frames without poisoning later input", () => {
    const lines: string[] = [];
    const overflows: number[] = [];
    const framer = createBoundedLineFramer({
      onLine: line => lines.push(line), onOverflow: bytes => overflows.push(bytes), maxLineBytes: 4,
    });
    framer.push("part");
    framer.clear();
    framer.push("oversized");
    framer.clear();
    framer.push("ok\ntail");
    framer.end();
    framer.end();
    expect(lines).toEqual(["ok", "tail"]);
    expect(overflows).toEqual([]);
  });
});
