import { expect, it } from "vitest";
import {
  slackMarkdownBlocks,
  slackReadableText,
  compatibleSlackBlocks,
} from "./slack-markdown.js";

const elements = (text: string) =>
  slackMarkdownBlocks(text)[0].elements as any[];

it("keeps plain fallback readable and preserves images while degrading only rich blocks", () => {
  const source =
    "# Architecture\n\n**Overview**\n\n3. API\n4. Host\n\n- UI\n\n> Quote\n\n```js\nrun()\n```";
  expect(slackReadableText(source)).toBe(
    "Architecture\n\nOverview\n\n3. API\n4. Host\n\n• UI\n\nQuote\n\nrun()",
  );
  const image = { type: "image", slack_file: { id: "F123456" } };
  const result = compatibleSlackBlocks([
    ...slackMarkdownBlocks(source),
    {
      type: "table",
      rows: [
        [{ text: "Area" }, { text: "Status" }],
        [{ text: "API" }, { text: "Ready" }],
      ],
    },
    {
      type: "data_visualization",
      title: "Jobs",
      chart: { series: [{ data: [{ label: "Done", value: 3 }] }] },
    },
    image,
  ]);
  expect(result.at(-1)).toBe(image);
  expect(result.slice(0, -1).every((b) => b.type === "section")).toBe(true);
  expect(JSON.stringify(result)).toContain("API | Ready");
  expect(JSON.stringify(result)).toContain("Done: 3");
  expect(JSON.stringify(result)).not.toContain("**");
  const large = compatibleSlackBlocks(slackMarkdownBlocks("x".repeat(6000)));
  expect(large).toHaveLength(3);
  expect(large.every((b) => (b.text as any).text.length <= 2900)).toBe(true);
  expect(
    compatibleSlackBlocks([{ type: "rich_text", elements: [] }]),
  ).toMatchObject([{ text: { text: " " } }]);
});
const allText = (value: unknown): string =>
  Array.isArray(value)
    ? value.map(allText).join("")
    : value && typeof value === "object"
      ? Object.entries(value)
          .map(([k, v]) =>
            k === "text" ? String(v) : k === "elements" ? allText(v) : "",
          )
          .join("")
      : "";

it("formats the screenshot's bold references and code without showing Markdown markers or language labels", () => {
  const result = elements(
    "**The plug-in point is `src/agentiq/icr/app.py:49`.**\n\n**1. Register AgentIQ with ICR**\n\n```python\n_nodes = {\n  'chat': _chat\n}\n```\n\n- `request` contains the state.",
  );
  expect(result[0].elements).toEqual([
    { type: "text", text: "The plug-in point is ", style: { bold: true } },
    {
      type: "text",
      text: "src/agentiq/icr/app.py:49",
      style: { bold: true, code: true },
    },
    { type: "text", text: ".", style: { bold: true } },
  ]);
  expect(result[2]).toEqual({
    type: "rich_text_preformatted",
    elements: [{ type: "text", text: "_nodes = {\n  'chat': _chat\n}" }],
  });
  expect(result[3]).toMatchObject({ type: "rich_text_list", style: "bullet" });
  expect(allText(result)).not.toMatch(/\*\*|```|python/);
});
it("supports headings, nested emphasis, strike, quotes, breaks and escaped markers", () => {
  const result = elements(
    "# Heading\n\n**bold *italic*** and ~~removed~~  \nnext \\*literal\\*\n\n> **Quoted**\n\n---",
  );
  expect(result[0].elements[0]).toMatchObject({
    text: "Heading",
    style: { bold: true },
  });
  expect(result[1].elements).toContainEqual({
    type: "text",
    text: "italic",
    style: { bold: true, italic: true },
  });
  expect(result[1].elements).toContainEqual({
    type: "text",
    text: "removed",
    style: { strike: true },
  });
  expect(result[1].elements).toContainEqual({ type: "text", text: "\n" });
  expect(allText(result)).toContain("*literal*");
  expect(result[2]).toMatchObject({ type: "rich_text_quote" });
});
it("renders ordered and nested lists with stable numbering and literal task checkboxes", () => {
  const result = elements(
    "3. Third\n   - Child\n4. Fourth\n\n- [x] Done\n- [ ] Next",
  );
  expect(result[0]).toMatchObject({ style: "ordered", offset: 2, indent: 0 });
  expect(result[1]).toMatchObject({ style: "bullet", indent: 1 });
  expect(result[2]).toMatchObject({ style: "ordered", offset: 3, indent: 0 });
  expect(allText(result)).toContain("☑ Done☐ Next");
});
it("keeps mentions, URLs, HTML, images and file links as inert text", () => {
  const source =
    "<@U123456> <!channel> [source](file:///tmp/report.md) [web](https://example.com) https://example.com\n\n![diagram](https://example.com/a.png)\n\n<script>alert(1)</script>";
  const result = elements(source);
  expect(allText(result)).toContain("<@U123456> <!channel>");
  expect(allText(result)).toContain("source (file:///tmp/report.md)");
  expect(allText(result)).toContain("web (https://example.com)");
  expect(allText(result)).toContain("diagram (https://example.com/a.png)");
  expect(allText(result)).toContain("<script>alert(1)</script>");
  expect(JSON.stringify(result)).not.toMatch(
    /"type":"(?:user|channel|broadcast|link|image|button)"/,
  );
});
it("labels Mermaid as source rather than pretending Slack rendered a diagram", () => {
  expect(
    elements("```mermaid\nflowchart LR\n  UI[React] --> R[Reasoner]\n```"),
  ).toEqual([
    {
      type: "rich_text_section",
      elements: [
        {
          type: "text",
          text: "Diagram source (Mermaid)",
          style: { bold: true },
        },
      ],
    },
    {
      type: "rich_text_preformatted",
      elements: [
        { type: "text", text: "flowchart LR\n  UI[React] --> R[Reasoner]" },
      ],
    },
  ]);
});
it("preserves a Markdown table as a compact literal table", () => {
  expect(elements("| Area | Result |\n| --- | --- |\n| API | Pass |")).toEqual([
    {
      type: "rich_text_preformatted",
      elements: [{ type: "text", text: "Area | Result\nAPI | Pass" }],
    },
  ]);
});
it.each([
  "",
  "\n\n",
  "```\n\n```",
  "    indented()",
  "[ref]: https://example.com\n\n[ref]",
])("handles empty, indented and reference content: %j", (source) => {
  const result = elements(source);
  expect(result.length).toBeGreaterThan(0);
  expect(JSON.stringify(result)).not.toContain('"text":""');
});
it("bounds long input and deeply nested emphasis/lists", () => {
  expect(allText(elements("a".repeat(20_000)))).toHaveLength(12_000);
  const result = elements(
    Array.from(
      { length: 16 },
      (_, n) => `${"  ".repeat(n)}- **Level ${n}**`,
    ).join("\n"),
  );
  expect(
    result
      .filter((e) => e.type === "rich_text_list")
      .every((e) => e.indent <= 8),
  ).toBe(true);
});
