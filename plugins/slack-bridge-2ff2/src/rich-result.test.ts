import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import {
  parseRichResult,
  renderRichResult,
  richResultBlocks,
  richResultSchema,
} from "./rich-result.js";
import { sampleResult } from "./embed-view.js";
const report = (section: unknown) => ({ title: "Report", sections: [section] });
const table = {
  type: "table",
  title: "Checks",
  columns: ["Check", "Time"],
  rows: [
    ["B", "12"],
    ["A", "2"],
  ],
};
describe("bounded report contract", () => {
  it("normalizes all six section types and preserves code whitespace", () => {
    expect(parseRichResult(sampleResult())).toEqual(sampleResult());
    const value = parseRichResult(
      report({
        type: "code",
        title: " Example ",
        text: "  x\n",
        language: " c++ ",
      }),
    );
    expect(value.sections[0]).toEqual({
      type: "code",
      title: "Example",
      text: "  x\n",
      language: "c++",
    });
    expect(
      parseRichResult(
        report({ type: "diff", title: "Change", text: "-old\n+new" }),
      ).sections[0],
    ).not.toHaveProperty("language");
    expect(richResultSchema.additionalProperties).toBe(false);
    expect(
      (richResultSchema.properties.sections as any).items.oneOf,
    ).toHaveLength(6);
  });
  it.each([
    null,
    [],
    {},
    { title: 1, sections: [] },
    { title: "x", sections: [] },
    { title: "x".repeat(121), sections: [] },
    { ...sampleResult(), path: "/private" },
    {
      title: "x",
      sections: Array(9).fill({ type: "text", title: "x", text: "x" }),
    },
  ])("rejects malformed reports %j", (value) =>
    expect(() => parseRichResult(value)).toThrow("Invalid rich result"),
  );
  it.each([
    { type: "html", title: "X", text: "x" },
    { type: "text", title: "X", text: " " },
    { type: "text", title: "X", text: "x".repeat(2501) },
    { type: "code", title: "X", text: "x", language: "<script>" },
    { type: "code", title: "X", text: "x", language: "" },
    { type: "diff", title: "X", text: "x".repeat(2801) },
    { ...table, rows: [["one"]] },
    { ...table, columns: [" "] },
    { ...table, rows: [["x".repeat(101), "y"]] },
    { ...table, rows: Array(21).fill(["x", "y"]) },
    { ...table, url: "https://private" },
    {
      type: "chart",
      title: "X",
      unit: "ms",
      points: [{ label: "a", value: NaN }],
    },
    {
      type: "chart",
      title: "X",
      unit: "ms",
      points: [{ label: "a", value: -1 }],
    },
    {
      type: "chart",
      title: "X",
      unit: "ms",
      points: [{ label: "a", value: 1e13 }],
    },
    {
      type: "chart",
      title: "X",
      unit: "ms",
      points: [{ label: "a", value: "1" }],
    },
    {
      type: "chart",
      title: "X",
      unit: "ms",
      points: [
        { label: "a", value: 1 },
        { label: "a", value: 2 },
      ],
    },
    {
      type: "chart",
      title: "X",
      unit: "ms",
      points: [{ label: "a", value: 1, url: "private" }],
    },
    {
      type: "tasks",
      title: "X",
      items: [{ text: "work", status: "approved" }],
    },
    {
      type: "tasks",
      title: "X",
      items: [{ text: "work", status: "done", action: "run" }],
    },
  ])("rejects invalid section %j", (section) =>
    expect(() => parseRichResult(report(section))).toThrow(),
  );
  it("caps native block counts and total serialized UTF-8 size", () => {
    const chart = {
      type: "chart",
      title: "Chart",
      unit: "ms",
      points: [{ label: "A", value: 0 }],
    };
    expect(() =>
      parseRichResult({ title: "X", sections: [table, table] }),
    ).toThrow();
    expect(() =>
      parseRichResult({ title: "X", sections: [chart, chart, chart] }),
    ).toThrow();
    expect(() =>
      parseRichResult({
        title: "X",
        sections: Array(4).fill({
          type: "text",
          title: "X",
          text: "界".repeat(1400),
        }),
      }),
    ).toThrow();
  });
  it("builds literal Slack blocks without agent supplied mentions or actions", () => {
    const r = sampleResult();
    r.sections.unshift({
      type: "text",
      title: "Literal",
      text: "<@U123456> <!channel> <script>",
    });
    const blocks = richResultBlocks(r, "Summary");
    expect(blocks).toHaveLength(16);
    expect(blocks[4]).toMatchObject({
      type: "rich_text",
    });
    expect(JSON.stringify(blocks[4])).toContain("<@U123456>");
    expect(JSON.stringify(blocks[4])).not.toMatch(
      /"type":"(?:user|broadcast|link)"/,
    );
    expect(blocks.find((b) => b.type === "table")).toMatchObject({
      rows: [
        [
          { type: "raw_text", text: "Check" },
          { type: "raw_text", text: "Duration (ms)" },
          { type: "raw_text", text: "Status" },
        ],
        ...r.sections
          .filter((s) => s.type === "table")
          .flatMap((s) =>
            s.rows.map((row) =>
              row.map((text) => ({ type: "raw_text", text })),
            ),
          ),
      ],
    });
    expect(blocks.find((b) => b.type === "data_visualization")).toMatchObject({
      chart: {
        type: "bar",
        axis_config: {
          categories: ["Launch", "Permissions", "Delivery"],
          x_label: "Category",
        },
      },
    });
    expect(JSON.stringify(blocks)).not.toContain('"action_id"');
  });
});
it("renders inert code, diff, chart, task lanes and accessible sortable tables; clearing removes all data", () => {
  const dom = new JSDOM("<main></main>"),
    root = dom.window.document.querySelector("main")!;
  const result = parseRichResult({
    title: "<img onerror=alert(1)>",
    sections: [
      table,
      {
        type: "code",
        title: "Source",
        text: "</script><img src=x onerror=alert(1)>",
      },
      {
        type: "diff",
        title: "Change",
        text: "--- before\n+++ after\n-old\n+new\n context",
      },
      {
        type: "chart",
        title: "Chart",
        unit: "ms",
        points: [
          { label: "zero", value: 0 },
          { label: "one", value: 10 },
        ],
      },
      {
        type: "tasks",
        title: "Tasks",
        items: [{ text: "Private work", status: "done" }],
      },
      { type: "text", title: "Notes", text: "Hello" },
    ],
  });
  renderRichResult(root, result);
  expect(root.querySelector("img")).toBeNull();
  expect(root.querySelector("script")).toBeNull();
  expect(root.querySelector("code")?.textContent).toContain("</script>");
  expect(root.querySelector(".diff-added")?.textContent).toBe("+new\n");
  expect(root.querySelector(".diff-removed")?.textContent).toBe("-old\n");
  expect(root.querySelectorAll(".result-lane")).toHaveLength(3);
  expect(root.querySelectorAll(".result-lane .report-note")).toHaveLength(2);
  expect(
    root.querySelector('[role="img"]')?.getAttribute("aria-label"),
  ).toContain("zero 0 ms");
  expect((root.querySelector(".chart-bar") as HTMLElement).style.width).toBe(
    "0%",
  );
  const timeSort = root.querySelectorAll("button")[1];
  timeSort.click();
  expect(root.querySelector("tbody tr")?.textContent).toBe("A2");
  expect(root.querySelector('[aria-sort="ascending"]')).not.toBeNull();
  timeSort.click();
  expect(root.querySelector("tbody tr")?.textContent).toBe("B12");
  root.querySelectorAll("button")[0].click();
  expect(root.querySelector("tbody tr")?.textContent).toBe("A2");
  renderRichResult(root, undefined);
  expect(root.textContent).toBe("");
  dom.window.close();
});
