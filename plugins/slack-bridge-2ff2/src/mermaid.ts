import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mermaidScriptUrl } from "../runtime-assets.js";
import { Lexer } from "marked";
import type { Delivery, SlackConnection } from "./model.js";
import { slackCall } from "./model.js";
import type { Store } from "./store.js";

export type Diagram = {
  hash: string;
  state: "uploading" | "ready" | "failed" | "uncertain";
  fileId?: string;
  permalink?: string;
};
export const diagramHash = (source: string) =>
  createHash("sha256").update(source.trim()).digest("hex");
export const MAX_PNG = 160 * 1024;

/** Runs inside the isolated page; independently tested with malformed layout output. */
export async function drawMermaid(text: string) {
  const mermaid = (globalThis as any).mermaid;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "neutral",
    maxTextSize: 6000,
    maxEdges: 200,
    flowchart: { htmlLabels: false },
  });
  const { svg } = await mermaid.render("slack-diagram", text);
  const container = document.getElementById("diagram")!;
  container.innerHTML = svg;
  const element = container.querySelector("svg")!;
  const box = element.viewBox.baseVal;
  if (
    !Number.isFinite(box.width) ||
    !Number.isFinite(box.height) ||
    box.width <= 0 ||
    box.height <= 0
  )
    throw new Error("Invalid diagram dimensions.");
  const scale = Math.min(1.5, 1600 / box.width, 1600 / box.height);
  const width = Math.ceil(box.width * scale),
    height = Math.ceil(box.height * scale);
  element.style.maxWidth = "none";
  element.style.width = `${width}px`;
  element.style.height = `${height}px`;
  container.style.width = `${width}px`;
  container.style.height = `${height}px`;
  return { width, height };
}

export function diagramSources(d: Pick<Delivery, "text" | "result">): string[] {
  const sources: string[] = [];
  const visit = (tokens: any[]) => {
    for (const t of tokens) {
      if (t.type === "code" && t.lang?.trim().toLowerCase() === "mermaid")
        sources.push(t.text.trim());
      else if (t.tokens) visit(t.tokens);
      else if (t.items) for (const item of t.items) visit(item.tokens);
    }
  };
  visit(Lexer.lex(d.text));
  for (const s of d.result?.sections || []) {
    if (s.type === "text") visit(Lexer.lex(s.text));
    if (s.type === "code" && s.language?.toLowerCase() === "mermaid")
      sources.push(s.text.trim());
  }
  return [...new Set(sources)].filter(Boolean).slice(0, 2);
}

/** Local, isolated Chromium rendering. Agent source cannot load resources or configure the renderer. */
export async function renderMermaid(
  source: string,
  signal: AbortSignal,
): Promise<Buffer> {
  if (
    source.length > 6000 ||
    /%%\{|^\s*---|^\s*click\b|(?:https?|file):|<\s*(?:img|script|iframe)\b/im.test(
      source,
    )
  )
    throw new Error("Unsupported diagram content.");
  signal.throwIfAborted();
  const { default: puppeteer } = await import("puppeteer");
  const browser = await puppeteer
    .launch({ headless: true, timeout: 15_000, channel: "chrome" })
    .catch(() => puppeteer.launch({ headless: true, timeout: 15_000 }));
  const close = () => {
    void browser.close().catch(() => {});
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    signal.throwIfAborted();
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      void request.abort();
    });
    await page.setContent(
      '<html><body style="margin:0;background:white"><div id="diagram"></div></body></html>',
    );
    await page.addScriptTag({
      content: await readFile(
        mermaidScriptUrl,
        "utf8",
      ),
    });
    const size = await page.evaluate(drawMermaid, source);
    await page.setViewport({ ...size, deviceScaleFactor: 1 });
    const png = Buffer.from(
      await page.screenshot({ type: "png", clip: { x: 0, y: 0, ...size } }),
    );
    if (png.length > MAX_PNG) throw new Error("Diagram image too large.");
    signal.throwIfAborted();
    return png;
  } finally {
    signal.removeEventListener("abort", close);
    await browser.close();
  }
}

export type DiagramRenderer = typeof renderMermaid;
/** Upload each source once per answer, including after restart or answer revision. */
export async function prepareDiagrams(
  store: Store,
  d: Delivery,
  client: SlackConnection,
  allowed: () => boolean,
  signal: AbortSignal,
  render: DiagramRenderer = renderMermaid,
): Promise<Diagram[]> {
  const sources = diagramSources(d),
    entries = d.diagrams || [];
  for (const source of sources) {
    const hash = diagramHash(source);
    if (entries.some((e) => e.hash === hash)) continue;
    const entry: Diagram = { hash, state: "failed" };
    entries.push(entry);
    let uploading = false;
    try {
      const png = await render(source, signal);
      if (!allowed()) return entries;
      entry.state = "uploading";
      store.put("delivery", d.id, {
        ...store.get("delivery", d.id)!,
        diagrams: entries,
      });
      uploading = true;
      const result = await slackCall(client, "files.uploadDiagram", {
        channel: d.channel,
        thread_ts: d.root,
        png: png.toString("base64"),
      });
      if (
        result.ok === true &&
        /^F[A-Z0-9]{5,30}$/.test(result.file_id || "")
      ) {
        entry.state = "ready";
        entry.fileId = result.file_id;
        entry.permalink =
          typeof result.permalink === "string" ? result.permalink : undefined;
      } else entry.state = result.ok === false ? "failed" : "uncertain";
    } catch {
      entry.state = uploading ? "uncertain" : "failed";
    }
    // Preserve a newer text revision, but never send its old image in that revision.
    const current = store.get("delivery", d.id);
    if (current)
      store.put("delivery", d.id, { ...current, diagrams: entries.slice(-8) });
    if (!allowed()) break;
  }
  return entries.filter((e) => sources.some((s) => diagramHash(s) === e.hash));
}

export function diagramImages(diagrams: Diagram[] = []): Map<string, Diagram> {
  return new Map(
    diagrams
      .filter((d) => d.state === "ready" && d.fileId)
      .map((d) => [d.hash, d]),
  );
}
export const diagramBlock = (d: Diagram) => ({
  type: "image",
  slack_file: { id: d.fileId },
  alt_text: "Generated Mermaid diagram",
  title: { type: "plain_text", text: "Diagram" },
});
