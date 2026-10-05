import { Lexer, type Token, type MarkedToken } from "marked";
import { diagramHash, diagramBlock, type Diagram } from "./mermaid.js";

type Style = Partial<Record<"bold" | "italic" | "strike" | "code", boolean>>;
type Element = Record<string, unknown>;

// Generate only literal rich-text nodes. Slack mention/link/action nodes are
// never accepted from the agent, including Markdown links and embedded HTML.
function inline(tokens: Token[], style: Style = {}, depth = 0): Element[] {
  const text = (value: string, extra: Style = {}) => ({
    type: "text",
    text: value,
    ...(Object.keys(style).length || Object.keys(extra).length
      ? { style: { ...style, ...extra } }
      : {}),
  });
  return (tokens as MarkedToken[]).flatMap((token): Element[] => {
    if (depth > 12) return [text(token.raw)];
    switch (token.type) {
      case "strong":
        return inline(token.tokens, { ...style, bold: true }, depth + 1);
      case "em":
        return inline(token.tokens, { ...style, italic: true }, depth + 1);
      case "del":
        return inline(token.tokens, { ...style, strike: true }, depth + 1);
      case "codespan":
        return [text(token.text, { code: true })];
      case "br":
        return [text("\n")];
      case "link": {
        const label = inline(token.tokens, style, depth + 1);
        // Keep references readable without enabling auto-parsing or URL access.
        return token.text === token.href
          ? label
          : [...label, text(` (${token.href})`)];
      }
      case "image":
        return [text(`${token.text || "Image"} (${token.href})`)];
      case "escape":
        return [text(token.text)];
      case "text":
        return token.tokens
          ? inline(token.tokens, style, depth + 1)
          : [text(token.text)];
      default:
        return [text(token.raw)];
    }
  });
}

function blocks(
  tokens: Token[],
  indent = 0,
  images = new Map<string, Diagram>(),
): Element[] {
  const elements: Element[] = [];
  const section = (children: Element[], type = "rich_text_section") => {
    if (children.length) elements.push({ type, elements: children });
  };
  for (const token of tokens as MarkedToken[]) {
    switch (token.type) {
      case "space":
        break;
      case "heading":
        section(inline(token.tokens, { bold: true }));
        break;
      case "paragraph":
      case "text":
        section(inline(token.tokens || Lexer.lexInline(token.text)));
        break;
      case "code":
        if (
          token.lang?.trim().toLowerCase() === "mermaid" &&
          images.has(diagramHash(token.text))
        )
          break;
        if (token.lang?.trim().toLowerCase() === "mermaid")
          section([
            {
              type: "text",
              text: "Diagram source (Mermaid)",
              style: { bold: true },
            },
          ]);
        section(
          [{ type: "text", text: token.text || " " }],
          "rich_text_preformatted",
        );
        break;
      case "blockquote":
        for (const child of blocks(token.tokens, indent, images)) {
          if (child.type === "rich_text_section")
            section(child.elements as Element[], "rich_text_quote");
          else elements.push(child);
        }
        break;
      case "list": {
        let items: Element[] = [],
          offset = typeof token.start === "number" ? token.start - 1 : 0;
        const flush = () => {
          if (!items.length) return;
          elements.push({
            type: "rich_text_list",
            style: token.ordered ? "ordered" : "bullet",
            indent: Math.min(indent, 8),
            ...(token.ordered && offset > 0 ? { offset } : {}),
            elements: items,
          });
          offset += items.length;
          items = [];
        };
        for (const item of token.items) {
          const parts = (item.tokens as MarkedToken[]).filter(
            (t) =>
              t.type !== "list" &&
              t.type !== "space" &&
              t.type !== "checkbox" &&
              !(
                t.type === "code" &&
                t.lang?.trim().toLowerCase() === "mermaid" &&
                images.has(diagramHash(t.text))
              ),
          );
          const children: Element[] = item.task
            ? [{ type: "text", text: item.checked ? "☑ " : "☐ " }]
            : [];
          parts.forEach((part, index) => {
            if (index) children.push({ type: "text", text: "\n" });
            children.push(
              ...inline(
                "tokens" in part && part.tokens
                  ? part.tokens
                  : Lexer.lexInline(part.raw),
              ),
            );
          });
          items.push({
            type: "rich_text_section",
            elements: children.length
              ? children
              : [{ type: "text", text: " " }],
          });
          const nested = item.tokens.filter((t) => t.type === "list");
          if (nested.length && indent < 8) {
            flush();
            elements.push(...blocks(nested, indent + 1, images));
          }
        }
        flush();
        break;
      }
      case "table":
        // A compact literal table also works on installations without table blocks.
        section(
          [
            {
              type: "text",
              text: [token.header, ...token.rows]
                .map((row) => row.map((cell) => cell.text).join(" | "))
                .join("\n"),
            },
          ],
          "rich_text_preformatted",
        );
        break;
      case "hr":
        section([{ type: "text", text: "────────────────" }]);
        break;
      default:
        section([{ type: "text", text: token.raw }]);
    }
  }
  return elements;
}

/** Bounded Markdown → Slack rich text; no HTML execution, mentions or actions. */
export function slackMarkdownBlocks(
  text: string,
  images = new Map<string, Diagram>(),
): Record<string, unknown>[] {
  const content = text.slice(0, 12_000);
  const tokens = Lexer.lex(content, { gfm: true });
  const elements = blocks(tokens, 0, images);
  const used = new Set<string>();
  const collect = (tokens: Token[]) => {
    for (const t of tokens as MarkedToken[]) {
      if (
        t.type === "code" &&
        t.lang?.trim().toLowerCase() === "mermaid" &&
        images.has(diagramHash(t.text))
      )
        used.add(diagramHash(t.text));
      else if ("tokens" in t && t.tokens) collect(t.tokens);
      else if (t.type === "list")
        for (const item of t.items) collect(item.tokens);
    }
  };
  collect(tokens);
  return [
    {
      type: "rich_text",
      elements: elements.length
        ? elements
        : [
            {
              type: "rich_text_section",
              elements: [
                { type: "text", text: used.size ? "Diagram" : content || " " },
              ],
            },
          ],
    },
    ...[...used].map((hash) => diagramBlock(images.get(hash)!)),
  ];
}

function readable(elements: Element[]): string {
  return elements
    .map((element) => {
      if (element.type === "text") return String(element.text || "");
      const children = (element.elements || []) as Element[];
      if (element.type === "rich_text_list")
        return children
          .map(
            (child, i) =>
              `${element.style === "ordered" ? Number(element.offset || 0) + i + 1 + "." : "•"} ${readable([child])}`,
          )
          .join("\n");
      return children
        .map((child) => readable([child]))
        .join(element.type === "rich_text" ? "\n\n" : "");
    })
    .join("");
}

/** A readable fallback never exposes Markdown punctuation as literal output. */
export function slackReadableText(text: string): string {
  return readable(
    slackMarkdownBlocks(text).filter((b) => b.type === "rich_text"),
  );
}

/** Keep uploaded images and ordinary blocks when optional rich blocks are rejected. */
export function compatibleSlackBlocks(
  input: Record<string, unknown>[],
): Record<string, unknown>[] {
  const section = (text: string) => ({
    type: "section",
    text: { type: "plain_text", text: text || " " },
  });
  return input.flatMap((block) => {
    let text: string;
    if (block.type === "rich_text") text = readable([block]);
    else if (block.type === "table")
      text = (block.rows as { text: string }[][])
        .map((row) => row.map((cell) => cell.text).join(" | "))
        .join("\n");
    else if (block.type === "data_visualization") {
      const chart = block.chart as {
        series: { data: { label: string; value: number }[] }[];
      };
      text =
        String(block.title) +
        "\n" +
        chart.series
          .flatMap((series) =>
            series.data.map((point) => `${point.label}: ${point.value}`),
          )
          .join("\n");
    } else return [block];
    return Array.from(
      { length: Math.max(1, Math.ceil(text.length / 2900)) },
      (_, i) => section(text.slice(i * 2900, (i + 1) * 2900)),
    );
  });
}
