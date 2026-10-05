import { afterEach, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import puppeteer from "puppeteer";
import { setup, body } from "../test/helpers.js";
import {
  renderMermaid,
  drawMermaid,
  prepareDiagrams,
  diagramSources,
  diagramHash,
  diagramImages,
} from "./mermaid.js";
import { slackMarkdownBlocks } from "./slack-markdown.js";
import { richResultBlocks } from "./rich-result.js";
import { canvasMarkdown } from "./slack-forms.js";
import type { Delivery } from "./model.js";

const source = "flowchart LR\n UI[React] --> R[Reasoner]";
const text = `**Architecture**\n\n\`\`\`mermaid\n${source}\n\`\`\``;
const fixtures: ReturnType<typeof setup>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture() {
  const f = setup();
  fixtures.push(f);
  return f;
}
const delivery = (): Delivery => ({
  id: "diagram-answer",
  key: "key",
  channel: "C123456",
  root: "1791050000.000001",
  text,
  state: "queued",
  created: Date.now(),
  next: 0,
  attempts: 0,
  note: "",
});
const ready = {
  hash: diagramHash(source),
  state: "ready" as const,
  fileId: "F987654",
  permalink: "https://test.slack.com/files/U999999/F987654/diagram.png",
};
const png = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001",
  "hex",
);

it.each([
  [300, 200],
  [10000, 4000],
  [0, 100],
  [100, 0],
  [-10, 100],
  [Infinity, 100],
  [100, NaN],
])("bounds Mermaid's SVG layout dimensions %s × %s", async (width, height) => {
  const dom = new JSDOM('<div id="diagram"></div>');
  Object.defineProperty(dom.window.SVGSVGElement.prototype, "viewBox", {
    get: () => ({ baseVal: { width, height } }),
  });
  vi.stubGlobal("document", dom.window.document);
  const initialize = vi.fn();
  vi.stubGlobal("mermaid", {
    initialize,
    render: async () => ({ svg: '<svg viewBox="0 0 300 200"></svg>' }),
  });
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    await expect(drawMermaid(source)).rejects.toThrow("dimensions");
  else {
    const size = await drawMermaid(source);
    expect(size.width).toBeLessThanOrEqual(1600);
    expect(size.height).toBeLessThanOrEqual(1600);
    expect(dom.window.document.querySelector("svg")?.style.width).toBe(
      `${size.width}px`,
    );
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict", maxEdges: 200 }),
    );
  }
  dom.window.close();
});
it("closes the browser on oversize images, uses a cache fallback, and blocks all page requests", async () => {
  const abort = vi.fn(),
    close = vi.fn(async () => {});
  const page = {
    setViewport: vi.fn(),
    setRequestInterception: vi.fn(),
    on: vi.fn((_event, handler) => handler({ abort })),
    setContent: vi.fn(),
    addScriptTag: vi.fn(),
    evaluate: vi.fn(async () => ({ width: 10, height: 10 })),
    screenshot: vi.fn(async () => Buffer.alloc(160 * 1024 + 1)),
  };
  vi.spyOn(puppeteer, "launch")
    .mockRejectedValueOnce(new Error("No installed Chrome"))
    .mockResolvedValueOnce({ newPage: async () => page, close } as any);
  await expect(
    renderMermaid(source, AbortSignal.timeout(1000)),
  ).rejects.toThrow("too large");
  expect(close).toHaveBeenCalledTimes(1);
  expect(abort).toHaveBeenCalledTimes(1);
});

it("renders flowchart and sequence diagrams with real isolated Chromium and preserves PNG dimensions", async () => {
  for (const s of [
    source,
    "sequenceDiagram\n Client->>Server: Request\n Server-->>Client: Response",
  ]) {
    const image = await renderMermaid(s, AbortSignal.timeout(30_000));
    expect(image.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(image.readUInt32BE(16)).toBeLessThanOrEqual(1600);
    expect(image.readUInt32BE(20)).toBeLessThanOrEqual(1600);
    expect(image.length).toBeLessThan(160 * 1024);
  }
}, 60_000);
it.each([
  "a".repeat(6001),
  '%%{init: {"securityLevel":"loose"}}%%\nflowchart LR',
  "---\nconfig: anything",
  'flowchart LR\n click A href "https://example.com"',
  "flowchart LR\n A[<img src='file:///tmp/private'>]",
])("rejects renderer directives and external resources", async (s) => {
  await expect(renderMermaid(s, AbortSignal.timeout(1000))).rejects.toThrow();
});
it("honors pre-cancelled rendering and closes invalid-diagram browsers", async () => {
  await expect(renderMermaid(source, AbortSignal.abort())).rejects.toThrow();
  await expect(
    renderMermaid("not a mermaid diagram", AbortSignal.timeout(30_000)),
  ).rejects.toThrow();
}, 40_000);
it("collects bounded unique diagram sources from nested Markdown and rich code/text sections", () => {
  expect(
    diagramSources({
      text,
      result: {
        title: "Report",
        sections: [
          { type: "code", title: "Diagram", language: "mermaid", text: source },
          {
            type: "text",
            title: "Sequence",
            text: "```mermaid\nsequenceDiagram\n A->>B: Hi\n```",
          },
          { type: "code", title: "Plain", language: "python", text: "x()" },
        ],
      },
    }),
  ).toEqual([source, "sequenceDiagram\n A->>B: Hi"]);
  expect(diagramSources({ text: "```mermaid\n\n```" })).toEqual([]);
  expect(
    diagramSources({
      text: `> \`\`\`mermaid\n> ${source.split("\n").join("\n> ")}\n> \`\`\``,
    }),
  ).toEqual([source]);
});
it("replaces rendered source in native text, rich code and Canvas using only the recorded image", () => {
  const images = diagramImages([ready]);
  const blocks = slackMarkdownBlocks(text, images);
  expect(blocks.at(-1)).toMatchObject({
    type: "image",
    slack_file: { id: ready.fileId },
  });
  expect(JSON.stringify(blocks)).not.toContain("flowchart");
  expect(
    JSON.stringify(
      slackMarkdownBlocks(`\`\`\`mermaid\n${source}\n\`\`\``, images),
    ),
  ).not.toContain("flowchart");
  const listed = `- Architecture\n\n  \`\`\`mermaid\n  ${source.split("\n").join("\n  ")}\n  \`\`\``;
  const listedBlocks = slackMarkdownBlocks(listed, images);
  expect(JSON.stringify(listedBlocks)).not.toContain("flowchart");
  expect(listedBlocks.at(-1)).toMatchObject({ type: "image" });
  expect(JSON.stringify(slackMarkdownBlocks(listed))).toContain("flowchart");
  expect(
    JSON.stringify(
      slackMarkdownBlocks(
        `> \`\`\`mermaid\n> ${source.split("\n").join("\n> ")}\n> \`\`\``,
        images,
      ),
    ),
  ).not.toContain("flowchart");
  const result = {
    title: "Report",
    sections: [
      {
        type: "code" as const,
        title: "Diagram",
        language: "mermaid",
        text: source,
      },
    ],
  };
  expect(richResultBlocks(result, "Ready", images).at(-1)).toMatchObject({
    type: "image",
  });
  expect(canvasMarkdown(text, result, [ready])).toContain(
    `![Diagram](${ready.permalink})`,
  );
  expect(canvasMarkdown(text, result, [ready])).not.toContain("flowchart");
  expect(
    canvasMarkdown(text, undefined, [{ ...ready, permalink: undefined }]),
  ).toContain("flowchart");
  expect(canvasMarkdown("No diagram", undefined, [ready])).not.toContain(
    "![Diagram]",
  );
});
it.each(["success", "rejected", "ambiguous", "render-failed", "revoked"])(
  "prepares %s diagrams without duplicate uploads on revisions/restart",
  async (condition) => {
    const f = fixture(),
      d = delivery();
    f.store.put("delivery", d.id, d);
    let allowed = true;
    const render = vi.fn(async () => {
      if (condition === "render-failed") throw new Error("Bad graph");
      if (condition === "revoked") allowed = false;
      return png;
    });
    const call = vi.fn(async () => {
      if (condition === "ambiguous") throw new Error("lost");
      return condition === "rejected"
        ? { ok: false, error: "missing_scope" }
        : { ok: true, file_id: ready.fileId, permalink: ready.permalink };
    });
    const client = { call, start: vi.fn(), close: vi.fn() };
    await prepareDiagrams(
      f.store,
      d,
      client,
      () => allowed,
      AbortSignal.timeout(1000),
      render,
    );
    const current = f.store.get("delivery", d.id)!;
    if (condition === "revoked") expect(call).not.toHaveBeenCalled();
    else {
      expect(current.diagrams?.[0].state).toBe(
        condition === "success"
          ? "ready"
          : condition === "ambiguous"
            ? "uncertain"
            : "failed",
      );
      await prepareDiagrams(
        f.store,
        current,
        client,
        () => true,
        AbortSignal.timeout(1000),
        render,
      );
      expect(render).toHaveBeenCalledTimes(1);
      expect(call).toHaveBeenCalledTimes(condition === "render-failed" ? 0 : 1);
    }
  },
);
it("preserves newer revisions during upload and avoids using interrupted uploads", async () => {
  const f = fixture(),
    d = delivery();
  f.store.put("delivery", d.id, d);
  const client = {
    call: vi.fn(async () => {
      f.store.put("delivery", d.id, {
        ...f.store.get("delivery", d.id)!,
        text: "New answer",
        revision: 2,
      });
      return { ok: true, file_id: ready.fileId };
    }),
    start: vi.fn(),
    close: vi.fn(),
  };
  await prepareDiagrams(
    f.store,
    d,
    client,
    () => true,
    AbortSignal.timeout(1000),
    async () => png,
  );
  expect(f.store.get("delivery", d.id)).toMatchObject({
    text: "New answer",
    revision: 2,
  });
  expect(diagramImages([{ ...ready, state: "uploading" }]).size).toBe(0);
});
it("publishes one answer with one image and reuses the upload when the answer is revised", async () => {
  const f = fixture();
  await f.connect();
  f.bridge.config.routes[0].summaries = true;
  await f.receive(body("Diagram please", "diagram-task"));
  await f.bridge.tick();
  await new Promise((r) => setImmediate(r));
  (f.bridge as any).diagramRenderer = vi.fn(async () => png);
  const previous = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (m, args) =>
    m === "files.uploadDiagram"
      ? { ok: true, file_id: ready.fileId, permalink: ready.permalink }
      : previous(m, args),
  );
  await f.bridge.publish("th1", "p1", text);
  for (let n = 0; n < 3; n++) {
    (f.bridge as any).channelNext.clear();
    await f.bridge.flush();
  }
  expect(f.store.get("delivery", "answer:diagram-task")?.state).toBe("sent");
  const answer = f.call.mock.calls.find(
    ([m, a]) =>
      m === "chat.postMessage" &&
      a.blocks?.some((b: any) => b.type === "image"),
  );
  expect(answer?.[1].blocks.at(-1)).toMatchObject({
    type: "image",
    slack_file: { id: ready.fileId },
  });
  await f.bridge.publish(
    "th1",
    "p1",
    text.replace("Architecture", "Updated architecture"),
  );
  (f.bridge as any).channelNext.clear();
  await f.bridge.flush();
  expect(
    f.call.mock.calls.filter(([m]) => m === "files.uploadDiagram"),
  ).toHaveLength(1);
  expect(
    f.call.mock.calls.filter(
      ([m, a]) =>
        m === "chat.postMessage" &&
        a.blocks?.some((b: any) => b.type === "image"),
    ),
  ).toHaveLength(1);
});

async function imageFixture(reject: (args: any) => unknown) {
  const f = fixture();
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  await f.connect();
  f.bridge.config.routes[0].summaries = true;
  await f.receive(body("Diagram please", "image-retry"));
  await f.bridge.tick();
  await new Promise((r) => setImmediate(r));
  (f.bridge as any).diagramRenderer = vi.fn(async () => png);
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (method, args) => {
    if (method === "files.uploadDiagram")
      return { ok: true, file_id: ready.fileId, permalink: ready.permalink };
    if (
      ["chat.postMessage", "chat.update"].includes(method) &&
      args.blocks?.some((b: any) => b.type === "image")
    ) {
      const rejected = reject(args);
      if (rejected) return rejected;
    }
    return original(method, args);
  });
  const advance = async (ms = 10000) => {
    now += ms;
    (f.bridge as any).channelNext.clear();
    await f.bridge.flush();
  };
  await advance();
  f.call.mockClear();
  await f.bridge.publish("th1", "p1", text);
  // Deliver the single in-place formatting notice before testing image attempts.
  await advance();
  expect(f.store.get("delivery", "status:image-retry")?.text).toContain(
    "🎨 Formatting in process…",
  );
  f.call.mockClear();
  return {
    ...f,
    advance,
    answer: () => f.store.get("delivery", "answer:image-retry")!,
  };
}

it("waits for definitively rejected new images, then sends one formatted answer without another upload", async () => {
  let attempts = 0;
  const f = await imageFixture(() =>
    ++attempts < 3 ? { ok: false, error: "invalid_blocks" } : undefined,
  );
  await f.advance();
  expect(f.answer()).toMatchObject({ state: "queued", imageRetries: 1 });
  await f.advance(0);
  expect(attempts).toBe(1);
  await f.advance();
  expect(f.answer()).toMatchObject({ state: "queued", imageRetries: 2 });
  await f.advance();
  expect(f.answer()).toMatchObject({ state: "sent", presentation: "rich" });
  expect(
    f.call.mock.calls.filter(([m]) => m === "files.uploadDiagram"),
  ).toHaveLength(1);
  const posts = f.call.mock.calls.filter(([m]) => m === "chat.postMessage");
  expect(posts).toHaveLength(3);
  expect(posts.at(-1)![1].blocks).toMatchObject([
    { type: "rich_text" },
    { type: "image" },
  ]);
});

it("caps image retries, preserves a readable diagram link, and does not disable the next reply’s formatting", async () => {
  const f = await imageFixture(() => ({ ok: false, error: "invalid_blocks" }));
  for (let i = 0; i < 4; i++) await f.advance();
  expect(f.answer()).toMatchObject({
    state: "sent",
    imageRetries: 3,
    presentation: "text",
  });
  const last = f.call.mock.calls
    .filter(([m]) => m === "chat.postMessage")
    .at(-1)![1];
  expect(last.blocks).toBeUndefined();
  expect(last.text).not.toContain("**");
  expect(last.text).toContain(ready.permalink);
  expect(
    f.call.mock.calls.filter(([m]) => m === "files.uploadDiagram"),
  ).toHaveLength(1);
  f.call.mockClear();
  await f.bridge.publish("th1", "p1", "# Next answer\n\n**Formatted**");
  await f.advance();
  await f.advance();
  const update = f.call.mock.calls.find(
    ([m, a]) => m === "chat.update" && a.ts === f.answer().ts,
  )![1];
  expect(update.blocks).toMatchObject([{ type: "rich_text" }]);
  expect(JSON.stringify(update.blocks)).not.toContain(ready.fileId);
  expect(f.answer()).toMatchObject({ imageRetries: 0, presentation: "rich" });
});

it("never retries an ambiguous image write, and rechecks revoked sharing before a deferred attempt", async () => {
  const uncertain = await imageFixture(() => {
    throw new Error("Connection lost");
  });
  await uncertain.advance();
  expect(uncertain.answer().state).toBe("uncertain");
  uncertain.call.mockClear();
  await uncertain.advance();
  expect(
    uncertain.call.mock.calls.some(([m]) => m === "chat.postMessage"),
  ).toBe(false);
  const revoked = await imageFixture(() => ({
    ok: false,
    error: "invalid_blocks",
  }));
  await revoked.advance();
  revoked.bridge.config.routes = [];
  revoked.call.mockClear();
  await revoked.advance();
  expect(revoked.answer().state).toBe("failed");
  expect(revoked.call.mock.calls.some(([m]) => m === "chat.postMessage")).toBe(
    false,
  );
});

it("keeps uploaded images in a compatible reply when optional rich blocks are unsupported", async () => {
  const f = await imageFixture((args) =>
    args.blocks.some((b: any) => b.type === "rich_text")
      ? { ok: false, error: "feature_not_enabled" }
      : undefined,
  );
  await f.advance();
  expect(f.answer()).toMatchObject({
    state: "sent",
    presentation: "compatible",
  });
  const last = f.call.mock.calls
    .filter(([m]) => m === "chat.postMessage")
    .at(-1)![1];
  expect(last.blocks).toMatchObject([
    { type: "section", text: { type: "plain_text" } },
    { type: "image" },
  ]);
  expect(last.blocks[0].text.text).not.toContain("**");
});

it("preserves a revised answer arriving during a definitive image rejection", async () => {
  let f: Awaited<ReturnType<typeof imageFixture>>;
  f = await imageFixture(() => {
    void f.bridge.publish("th1", "p1", "Revised answer");
    return { ok: false, error: "invalid_blocks" };
  });
  await f.advance();
  expect(f.answer()).toMatchObject({
    text: "Revised answer",
    state: "queued",
    imageRetries: 0,
    revision: 2,
  });
  await f.advance();
  await f.advance();
  expect(f.answer()).toMatchObject({
    text: "Revised answer",
    state: "sent",
    presentation: "rich",
  });
});

it("keeps one formatting footer through rendering and image-processing waits, then removes the temporary notice", async () => {
  let attempts = 0;
  const f = await imageFixture(() =>
    ++attempts === 1 ? { ok: false, error: "invalid_blocks" } : undefined,
  );
  const before = f.store.get("delivery", "status:image-retry")!;
  expect(before).toMatchObject({
    state: "sent",
    text: "⚙️ Working…\n\n🎨 Formatting in process…",
  });
  let release!: (value: Buffer) => void;
  (f.bridge as any).diagramRenderer = vi.fn(
    () =>
      new Promise<Buffer>((resolve) => {
        release = resolve;
      }),
  );
  const rendering = f.advance();
  await new Promise((resolve) => setImmediate(resolve));
  expect(f.store.get("delivery", before.id)?.revision).toBe(before.revision);
  expect(f.call.mock.calls.some(([m]) => m === "chat.postMessage")).toBe(false);
  f.threads.get("th1").status = "idle";
  await f.bridge.event({ name: "thread.idle", threadId: "th1" });
  expect(f.store.get("delivery", before.id)?.text).toBe(before.text);
  release(png);
  await rendering;
  expect(f.answer()).toMatchObject({ state: "queued", imageRetries: 1 });
  expect(f.store.get("delivery", before.id)?.revision).toBe(before.revision);
  await f.advance();
  expect(f.answer().state).toBe("sent");
  expect(f.store.get("delivery", before.id)?.remove).toBe(true);
  await f.advance();
  expect(f.store.get("delivery", before.id)?.state).toBe("removed");
  expect(
    f.call.mock.calls.filter(([m]) => m === "files.uploadDiagram"),
  ).toHaveLength(1);
  expect(f.call.mock.calls.filter(([m]) => m === "chat.delete")).toEqual([
    ["chat.delete", { channel: before.channel, ts: before.ts }],
  ]);
  const accepted = f.call.mock.calls
    .filter(([m]) => m === "chat.postMessage")
    .at(-1)![1];
  expect(JSON.stringify(accepted)).not.toContain("Formatting in process");
});
