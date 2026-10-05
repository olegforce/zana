import { slackMarkdownBlocks } from "./slack-markdown.js";
import { diagramHash, diagramBlock, type Diagram } from "./mermaid.js";

/** Deliberately shareable data only. No paths, URLs, HTML or arbitrary Slack blocks. */
export type ResultSection =
  | { type: "text"; title: string; text: string }
  | { type: "code" | "diff"; title: string; language?: string; text: string }
  | { type: "table"; title: string; columns: string[]; rows: string[][] }
  | {
      type: "chart";
      title: string;
      unit: string;
      points: { label: string; value: number }[];
    }
  | {
      type: "tasks";
      title: string;
      items: { text: string; status: "pending" | "running" | "done" }[];
    };
export type RichResult = { title: string; sections: ResultSection[] };
export const RESULT_MAX_BYTES = 16_000;
const invalid = () => {
  throw new Error(
    "Invalid rich result. Use bounded text, code, diff, table, chart or task sections.",
  );
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid();
}
function text(value: unknown, max: number, preserve = false): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    return invalid();
  return preserve ? value : value.trim();
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || !value.length || value.length > max)
    return invalid();
  return value;
}
export function parseRichResult(value: unknown): RichResult {
  const result = record(value);
  exact(result, ["title", "sections"]);
  const title = text(result.title, 120);
  let tables = 0,
    charts = 0;
  const sections = list(result.sections, 8).map((raw): ResultSection => {
    const s = record(raw),
      title = text(s.title, 50);
    switch (s.type) {
      case "text":
        exact(s, ["type", "title", "text"]);
        return { type: s.type, title, text: text(s.text, 2500, true) };
      case "code":
      case "diff": {
        exact(s, ["type", "title", "language", "text"]);
        const language =
          s.language === undefined ? undefined : text(s.language, 30);
        if (language && !/^[a-zA-Z0-9_+#.-]+$/.test(language)) invalid();
        return {
          type: s.type,
          title,
          ...(language ? { language } : {}),
          text: text(s.text, 2800, true),
        };
      }
      case "table": {
        exact(s, ["type", "title", "columns", "rows"]);
        if (++tables > 1) invalid();
        const columns = list(s.columns, 4).map((v) => text(v, 60));
        const rows = list(s.rows, 20).map((row) => {
          const cells = list(row, 4);
          if (cells.length !== columns.length) invalid();
          return cells.map((cell) => text(cell, 100));
        });
        return { type: s.type, title, columns, rows };
      }
      case "chart": {
        exact(s, ["type", "title", "unit", "points"]);
        if (++charts > 2) invalid();
        const unit = text(s.unit, 40);
        const labels = new Set<string>();
        const points = list(s.points, 12).map((raw) => {
          const point = record(raw);
          exact(point, ["label", "value"]);
          const label = text(point.label, 20);
          if (
            labels.has(label) ||
            typeof point.value !== "number" ||
            !Number.isFinite(point.value) ||
            point.value < 0 ||
            point.value > 1e12
          )
            invalid();
          labels.add(label);
          return { label, value: point.value as number };
        });
        return { type: s.type, title, unit, points };
      }
      case "tasks": {
        exact(s, ["type", "title", "items"]);
        const items = list(s.items, 12).map((raw) => {
          const item = record(raw);
          exact(item, ["text", "status"]);
          if (!["pending", "running", "done"].includes(item.status as string))
            invalid();
          return {
            text: text(item.text, 150),
            status: item.status as "pending" | "running" | "done",
          };
        });
        return { type: s.type, title, items };
      }
      default:
        return invalid();
    }
  });
  const parsed = { title, sections };
  if (
    new TextEncoder().encode(JSON.stringify(parsed)).length > RESULT_MAX_BYTES
  )
    invalid();
  return parsed;
}

const stringField = (maxLength: number) => ({
  type: "string",
  minLength: 1,
  maxLength,
});
const shape = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: "object", properties, required, additionalProperties: false });
export const richResultSchema = shape({
  title: stringField(120),
  sections: {
    type: "array",
    minItems: 1,
    maxItems: 8,
    items: {
      oneOf: [
        shape({
          type: { const: "text" },
          title: stringField(50),
          text: stringField(2500),
        }),
        ...["code", "diff"].map((type) =>
          shape(
            {
              type: { const: type },
              title: stringField(50),
              language: stringField(30),
              text: stringField(2800),
            },
            ["type", "title", "text"],
          ),
        ),
        shape({
          type: { const: "table" },
          title: stringField(50),
          columns: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: stringField(60),
          },
          rows: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "array",
              minItems: 1,
              maxItems: 4,
              items: stringField(100),
            },
          },
        }),
        shape({
          type: { const: "chart" },
          title: stringField(50),
          unit: stringField(40),
          points: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: shape({
              label: stringField(20),
              value: { type: "number", minimum: 0, maximum: 1e12 },
            }),
          },
        }),
        shape({
          type: { const: "tasks" },
          title: stringField(50),
          items: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: shape({
              text: stringField(150),
              status: { enum: ["pending", "running", "done"] },
            }),
          },
        }),
      ],
    },
  },
});

/** Formatting uses literal rich-text nodes; an agent cannot mention users or supply actions. */
export function richResultBlocks(
  result: RichResult,
  summary: string,
  images = new Map<string, Diagram>(),
): Record<string, unknown>[] {
  const pt = (text: string) => ({ type: "plain_text", text });
  const blocks: Record<string, unknown>[] = [
    { type: "header", text: pt(result.title) },
    ...slackMarkdownBlocks(summary, images),
    {
      type: "context",
      elements: [
        pt(
          "Agent report · supplied by the agent, not independently verified by Zana",
        ),
      ],
    },
  ];
  for (const s of result.sections) {
    if (s.type !== "chart") blocks.push({ type: "header", text: pt(s.title) });
    if (s.type === "text") blocks.push(...slackMarkdownBlocks(s.text, images));
    else if (
      s.type === "code" &&
      s.language?.toLowerCase() === "mermaid" &&
      images.has(diagramHash(s.text))
    )
      blocks.push(diagramBlock(images.get(diagramHash(s.text))!));
    else if (s.type === "code" || s.type === "diff")
      blocks.push({
        type: "rich_text",
        elements: [
          {
            type: "rich_text_preformatted",
            elements: [{ type: "text", text: s.text }],
          },
        ],
      });
    else if (s.type === "table")
      blocks.push({
        type: "table",
        column_settings: s.columns.map(() => ({ is_wrapped: true })),
        rows: [s.columns, ...s.rows].map((row) =>
          row.map((text) => ({ type: "raw_text", text })),
        ),
      });
    else if (s.type === "chart")
      blocks.push({
        type: "data_visualization",
        title: s.title,
        chart: {
          type: "bar",
          series: [{ name: s.unit.slice(0, 20), data: s.points }],
          axis_config: {
            categories: s.points.map((p) => p.label),
            x_label: "Category",
            y_label: s.unit,
          },
        },
      });
    else if (s.type === "tasks")
      blocks.push({
        type: "section",
        text: pt(
          s.items
            .map(
              (item) =>
                ({ pending: "To do", running: "In progress", done: "Done" })[
                  item.status
                ] +
                " · " +
                item.text,
            )
            .join("\n"),
        ),
      });
  }
  return blocks;
}

/**
 * Self-contained DOM renderer; embedded into the nonce-protected task page.
 * Keep every dependency inside this function so production bundling is safe.
 */
export function renderRichResult(
  root: HTMLElement,
  result: RichResult | undefined,
): void {
  const doc = root.ownerDocument;
  root.replaceChildren();
  if (!result) return;
  const node = (tag: string, text?: string, className?: string) => {
    const el = doc.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  root.append(
    node("h2", result.title),
    node("p", "Agent report · supplied by the agent", "report-note"),
  );
  for (const section of result.sections) {
    const group = node("section", undefined, "result-section");
    group.append(node("h3", section.title));
    if (section.type === "text")
      group.append(node("p", section.text, "result-text"));
    else if (section.type === "code" || section.type === "diff") {
      const pre = node("pre", undefined, "result-code");
      if (section.language)
        group.append(node("p", section.language, "report-note"));
      const code = node("code");
      if (section.type === "diff")
        section.text.split("\n").forEach((line) => {
          const el = node(
            "span",
            line + "\n",
            line.startsWith("+") && !line.startsWith("+++")
              ? "diff-added"
              : line.startsWith("-") && !line.startsWith("---")
                ? "diff-removed"
                : "diff-context",
          );
          code.append(el);
        });
      else code.textContent = section.text;
      pre.append(code);
      group.append(pre);
    } else if (section.type === "table") {
      const wrap = node("div", undefined, "result-table-wrap"),
        table = doc.createElement("table");
      table.append(node("caption", section.title));
      const head = doc.createElement("thead"),
        header = doc.createElement("tr"),
        body = doc.createElement("tbody");
      section.columns.forEach((label, index) => {
        const th = doc.createElement("th"),
          sort = doc.createElement("button");
        th.scope = "col";
        sort.type = "button";
        sort.textContent = label + " ↕";
        sort.setAttribute("aria-label", "Sort by " + label);
        let ascending = false;
        sort.addEventListener("click", () => {
          ascending = !ascending;
          [...body.rows]
            .sort((a, b) => {
              const left = a.cells[index].textContent || "",
                right = b.cells[index].textContent || "";
              return (
                left.localeCompare(right, undefined, { numeric: true }) *
                (ascending ? 1 : -1)
              );
            })
            .forEach((row) => body.append(row));
          [...header.cells].forEach((cell) =>
            cell.removeAttribute("aria-sort"),
          );
          th.setAttribute("aria-sort", ascending ? "ascending" : "descending");
          [...header.querySelectorAll("button")].forEach((button, i) => {
            button.textContent =
              section.columns[i] +
              (i === index ? (ascending ? " ↑" : " ↓") : " ↕");
          });
        });
        th.append(sort);
        header.append(th);
      });
      section.rows.forEach((values) => {
        const row = doc.createElement("tr");
        values.forEach((value) => row.append(node("td", value)));
        body.append(row);
      });
      head.append(header);
      table.append(head, body);
      wrap.append(table);
      group.append(wrap);
    } else if (section.type === "chart") {
      const chart = node("div", undefined, "result-chart");
      chart.setAttribute("role", "img");
      chart.setAttribute(
        "aria-label",
        section.title +
          ": " +
          section.points
            .map((p) => p.label + " " + p.value + " " + section.unit)
            .join(", "),
      );
      const max = Math.max(1, ...section.points.map((p) => p.value));
      group.append(node("p", section.unit, "report-note"));
      section.points.forEach((point) => {
        const row = node("div", undefined, "chart-row"),
          track = node("div", undefined, "chart-track"),
          bar = node("div", undefined, "chart-bar");
        bar.style.width = (point.value / max) * 100 + "%";
        track.append(bar);
        row.append(
          node("span", point.label),
          track,
          node("span", String(point.value), "chart-value"),
        );
        chart.append(row);
      });
      group.append(chart);
    } else if (section.type === "tasks") {
      const board = node("div", undefined, "result-board");
      for (const status of ["pending", "running", "done"] as const) {
        const lane = node("div", undefined, "result-lane");
        lane.append(
          node(
            "h4",
            { pending: "To do", running: "In progress", done: "Done" }[status],
          ),
        );
        const items = section.items.filter((item) => item.status === status);
        items.forEach((item) =>
          lane.append(node("p", item.text, "result-task")),
        );
        if (!items.length) lane.append(node("p", "No items", "report-note"));
        board.append(lane);
      }
      group.append(board);
    }
    root.append(group);
  }
}
