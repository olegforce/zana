import { createHash } from "node:crypto";
import { featureEnabled } from "./access.js";
import { pt, section, sameRoute } from "./home-view.js";
import {
  slackCall,
  DIRECT,
  TIMESTAMP,
  object,
  plainSlack,
  type Binding,
  type Config,
  type Delivery,
  type Mention,
  type Route,
  type SlackAck,
  type SlackConnection,
} from "./model.js";
import type { Store } from "./store.js";
import type { RichResult } from "./rich-result.js";
import { Lexer } from "marked";
import {
  diagramHash,
  diagramImages,
  diagramSources,
  type Diagram,
} from "./mermaid.js";

export type Question = { text: string; options: string[] };
export type SlackQuestion = {
  id: string;
  key: string;
  requestId: string;
  ownerEpoch?: string;
  route: Route;
  state: "waiting" | "answered" | "cancelled";
  questions: Question[];
  created: number;
  expires: number;
  viewId?: string;
  answers?: string[];
};
export type CanvasExport = {
  id: string;
  key: string;
  deliveryId: string;
  digest: string;
  ownerEpoch?: string;
  route: Route;
  state:
    | "draft"
    | "queued"
    | "creating"
    | "created"
    | "sharing"
    | "published"
    | "failed"
    | "uncertain";
  title: string;
  markdown: string;
  created: number;
  expires: number;
  viewId?: string;
  canvasId?: string;
  url?: string;
  next: number;
  note: string;
};
type Deps = {
  store: Store;
  config(): Config;
  client(): SlackConnection | undefined;
  route(b: Binding): Route | undefined;
  authorize(b: Binding): Promise<boolean>;
  accept(m: Mention, ack: SlackAck): Promise<void>;
  enqueue(b: Binding, text: string, id: string): void;
  changed(): void;
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const fingerprint = (d: Delivery) =>
  hash(JSON.stringify([d.text, d.result, d.revision || 1]));
const canvasUrl = (team: string, id: string) =>
  `https://app.slack.com/docs/${encodeURIComponent(team)}/${encodeURIComponent(id)}`;
const literal = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\\`*_~[\]#|]/g, "\\$&");
/** A deliberately shared report only: never read a file or replace an existing Canvas. */
export function canvasMarkdown(
  text: string,
  result?: RichResult,
  diagrams: Diagram[] = [],
): string {
  const sources = new Set(diagramSources({ text, result }).map(diagramHash));
  const images = new Map(
    [...diagramImages(diagrams)].filter(
      ([hash, image]) => sources.has(hash) && image.permalink,
    ),
  );
  const renderedText = (text: string) => {
    for (const t of Lexer.lex(text))
      if (
        t.type === "code" &&
        t.lang?.trim().toLowerCase() === "mermaid" &&
        images.has(diagramHash(t.text))
      )
        text = text.replace(t.raw, "");
    return literal(text.trim());
  };
  const lines = [renderedText(text)];
  if (result) {
    lines.push(`\n# ${literal(result.title)}`);
    for (const s of result.sections) {
      lines.push(`\n## ${literal(s.title)}`);
      if (s.type === "text") lines.push(renderedText(s.text));
      else if (s.type === "code" || s.type === "diff") {
        if (
          s.type === "code" &&
          s.language?.toLowerCase() === "mermaid" &&
          images.has(diagramHash(s.text))
        )
          continue;
        // A longer delimiter prevents an excerpt from breaking out of its code block.
        const fence = "`".repeat(
          Math.max(
            3,
            ...[...s.text.matchAll(/`+/g)].map((m) => m[0].length + 1),
          ),
        );
        // Fenced content is literal Markdown. Entity escaping would corrupt code.
        lines.push(`${fence}\n${s.text}\n${fence}`);
      } else if (s.type === "table")
        lines.push(
          `| ${s.columns.map(literal).join(" | ")} |\n| ${s.columns.map(() => "---").join(" | ")} |\n${s.rows.map((row) => `| ${row.map((v) => literal(v).replaceAll("\n", " ")).join(" | ")} |`).join("\n")}`,
        );
      else if (s.type === "chart")
        lines.push(
          s.points
            .map(
              (p) =>
                `- ${literal(p.label)}: ${p.value}${s.unit ? " " + literal(s.unit) : ""}`,
            )
            .join("\n"),
        );
      else if (s.type === "tasks")
        lines.push(
          s.items
            .map(
              (i) =>
                `- [${i.status === "done" ? "x" : " "}] ${literal(i.text)} (${i.status})`,
            )
            .join("\n"),
        );
    }
  }
  for (const image of images.values())
    lines.push(`\n![Diagram](${image.permalink})`);
  lines.push(
    "\n_Agent-supplied snapshot exported from an answer already shared to Slack._",
  );
  const markdown = lines.join("\n");
  if (Buffer.byteLength(markdown, "utf8") > 24000)
    throw new Error("This result is too large for a Canvas snapshot.");
  return markdown;
}
export function parseQuestions(value: unknown): Question[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3)
    throw new Error("Ask one to three short questions.");
  return value.map((item) => {
    const q = object(item);
    if (
      Object.keys(q).some((k) => !["text", "options"].includes(k)) ||
      typeof q.text !== "string" ||
      !q.text.trim() ||
      q.text.length > 250 ||
      !Array.isArray(q.options) ||
      q.options.length < 2 ||
      q.options.length > 3 ||
      q.options.some(
        (v: unknown) => typeof v !== "string" || !v.trim() || v.length > 75,
      ) ||
      new Set(q.options.map((v: string) => v.trim())).size !== q.options.length
    )
      throw new Error("Each question needs unique, short choices.");
    return {
      text: q.text.trim(),
      options: q.options.map((v: string) => v.trim()),
    };
  });
}
export const questionSchema = {
  type: "array",
  minItems: 1,
  maxItems: 3,
  items: {
    type: "object",
    properties: {
      text: { type: "string", minLength: 1, maxLength: 250 },
      options: {
        type: "array",
        minItems: 2,
        maxItems: 3,
        uniqueItems: true,
        items: { type: "string", minLength: 1, maxLength: 75 },
      },
    },
    required: ["text", "options"],
    additionalProperties: false,
  },
};
export class SlackForms {
  private busy = false;
  constructor(private deps: Deps) {}
  private permitted(b: Binding, route: Route, epoch?: string) {
    const c = this.deps.config(),
      current = this.deps.route(b);
    return (
      c.enabled &&
      !!c.owner &&
      !!this.deps.client() &&
      c.ownerEpoch === epoch &&
      !b.paused &&
      !["deleted", "archived"].includes(b.state) &&
      featureEnabled(c, "answers") &&
      !!current &&
      sameRoute(current, route) &&
      route.summaries
    );
  }
  ask(threadId: string, projectId: string, value: unknown) {
    const c = this.deps.config(),
      b = this.deps.store
        .list("binding")
        .find((b) => b.threadId === threadId && b.projectId === projectId),
      route = b && this.deps.route(b);
    if (
      c.questionsEnabled !== true ||
      !featureEnabled(c, "followups") ||
      !b ||
      !route ||
      !b.active ||
      !this.permitted(b, route, b.ownerEpoch)
    )
      throw new Error(
        "Slack question forms are disabled or this conversation cannot share answers.",
      );
    const questions = parseQuestions(value),
      id = `question:${b.active}`;
    const old = this.deps.store.get("question", id);
    if (old) return { id, state: old.state };
    if (this.deps.store.count("question", ["waiting"]) >= 100)
      throw new Error("Question queue is full.");
    const q: SlackQuestion = {
      id,
      key: b.key,
      requestId: b.active,
      route: { ...route },
      ownerEpoch: c.ownerEpoch,
      state: "waiting",
      questions,
      created: Date.now(),
      expires: Date.now() + 86400000,
    };
    this.deps.store.transaction(() => {
      this.deps.store.put("question", id, q);
      this.deps.enqueue(b, questions.map((q) => q.text).join("\n"), id);
      this.deps.store.put("delivery", id, {
        ...this.deps.store.get("delivery", id)!,
        questionId: id,
        requestedRoute: route,
      });
    });
    this.deps.changed();
    return {
      id,
      state: "queued",
      instruction:
        "End this turn and wait. The owner's answer will arrive as a follow-up in this same conversation. This form cannot grant execution permissions.",
    };
  }
  deliveryBlocks(d: Delivery): Record<string, unknown>[] | undefined {
    if (d.canvasId) {
      const r = this.deps.store.get("canvas", d.canvasId);
      return r?.url
        ? [
            section(d.text),
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  action_id: "canvas_link",
                  text: pt("Open Canvas"),
                  url: r.url,
                },
              ],
            },
          ]
        : undefined;
    }
    if (!d.questionId) return;
    const q = this.deps.store.get("question", d.questionId);
    if (!q) return;
    return [
      section(d.text),
      section(
        "Zana needs a preference or clarification. Execution permissions are reviewed in Zana.",
      ),
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "question_open",
            value: q.id,
            text: pt("Answer questions"),
          },
        ],
      },
    ];
  }
  resultActions(d: Delivery): Record<string, unknown>[] {
    const c = this.deps.config(),
      b = this.deps.store.get("binding", d.key),
      route = b && this.deps.route(b);
    if (
      c.canvasEnabled !== true ||
      d.questionId ||
      d.canvasId ||
      !["agent", "operator"].includes(d.origin || "") ||
      !b ||
      !route ||
      !this.permitted(b, route, b.ownerEpoch)
    )
      return [];
    return [
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "canvas_open",
            value: d.id,
            text: pt("Publish to Canvas"),
          },
        ],
      },
    ];
  }
  private authorized(p: Record<string, any>) {
    const c = this.deps.config();
    return (
      c.enabled &&
      c.owner &&
      p.user?.id === c.owner &&
      p.team?.id === c.identity?.team &&
      p.api_app_id === c.identity?.app
    );
  }
  private async open(p: Record<string, any>, ack: SlackAck) {
    const a = p.actions[0],
      isCanvas = a.action_id === "canvas_open",
      c = this.deps.config();
    const d =
      typeof a.value === "string" && a.value.length <= 150
        ? this.deps.store.get("delivery", a.value)
        : undefined;
    const b = d && this.deps.store.get("binding", d.key),
      route = b && this.deps.route(b);
    if (
      !d ||
      d.state !== "sent" ||
      !b ||
      !route ||
      !this.permitted(b, route, b.ownerEpoch) ||
      d.ts !== p.container?.message_ts ||
      d.channel !== p.container?.channel_id ||
      d.root !== p.message?.thread_ts ||
      !TIMESTAMP.test(a.action_ts || "") ||
      Math.abs(Date.now() - Number(a.action_ts) * 1000) > 300000 ||
      typeof p.trigger_id !== "string" ||
      !p.trigger_id ||
      p.trigger_id.length > 256 ||
      (isCanvas ? c.canvasEnabled !== true : c.questionsEnabled !== true)
    ) {
      await ack();
      return;
    }
    let record: CanvasExport | SlackQuestion, view: Record<string, unknown>;
    if (isCanvas) {
      const digest = fingerprint(d),
        id = `canvas:${hash(d.id + ":" + digest)}`;
      const old = this.deps.store.get("canvas", id);
      if (old && old.state !== "draft") {
        await ack();
        await slackCall(this.deps.client()!, "views.open", {
          trigger_id: p.trigger_id,
          view: {
            type: "modal",
            title: pt("Canvas snapshot"),
            close: pt("Done"),
            blocks: [
              section(`${old.title}\n${old.note || old.state}`),
              ...(old.url
                ? [
                    {
                      type: "actions",
                      elements: [
                        {
                          type: "button",
                          text: pt("Open Canvas"),
                          action_id: "canvas_link",
                          url: old.url,
                        },
                      ],
                    },
                  ]
                : []),
            ],
          },
        });
        return;
      }
      if (!old && this.deps.store.count("canvas") >= 500) {
        await ack();
        return;
      }
      record = {
        id,
        key: b.key,
        deliveryId: d.id,
        digest,
        ownerEpoch: c.ownerEpoch,
        route: { ...route },
        state: "draft",
        title: d.result?.title || b.title || "Zana result",
        markdown: canvasMarkdown(d.text, d.result, d.diagrams),
        created: Date.now(),
        expires: Date.now() + 15 * 60000,
        next: 0,
        note: "",
      };
      this.deps.store.put("canvas", record.id, record as CanvasExport);
      view = {
        type: "modal",
        callback_id: "zana_canvas_v1",
        private_metadata: record.id,
        title: pt("Publish to Canvas"),
        submit: pt("Publish snapshot"),
        close: pt("Cancel"),
        blocks: [
          section(record.title),
          section(
            DIRECT.test(b.channel)
              ? "Audience: you, the linked Slack owner. Zana creates a private Canvas and sends its link in this chat before granting you read access."
              : `Audience: members of #${route.name}. Slack adds the Canvas to this channel with edit access.`,
          ),
          section(
            "This copies the answer already shared to Slack into a persistent Canvas. Later exports create a new snapshot. Disabling sharing in Zana does not remove this Slack copy.",
          ),
          section(d.text),
        ],
      };
    } else {
      const q = d.questionId && this.deps.store.get("question", d.questionId);
      if (
        !q ||
        q.state !== "waiting" ||
        q.expires <= Date.now() ||
        q.requestId !== b.lastRequest ||
        !featureEnabled(c, "followups") ||
        !this.permitted(b, q.route, q.ownerEpoch)
      ) {
        await ack();
        return;
      }
      record = q;
      view = {
        type: "modal",
        callback_id: "zana_question_v1",
        private_metadata: q.id,
        title: pt("Answer Zana"),
        submit: pt("Send answers"),
        close: pt("Cancel"),
        blocks: [
          section(
            "Your answers become an ordinary follow-up to this same agent. This form cannot approve tool execution.",
          ),
          ...q.questions.flatMap((question, i) => [
            {
              type: "input",
              block_id: `q${i}`,
              optional: true,
              label: pt(plainSlack(question.text)),
              element: {
                type: "static_select",
                action_id: "choice",
                options: question.options.map((v, n) => ({
                  text: pt(plainSlack(v)),
                  value: String(n),
                })),
              },
            },
            {
              type: "input",
              block_id: `free${i}`,
              optional: true,
              label: pt("Or write your own answer"),
              element: {
                type: "plain_text_input",
                action_id: "text",
                max_length: 500,
              },
            },
          ]),
        ],
      };
    }
    await ack();
    const result = await slackCall(this.deps.client()!, "views.open", {
      trigger_id: p.trigger_id,
      view,
    });
    if (result.ok === true && typeof result.view?.id === "string") {
      record.viewId = result.view.id;
      if (isCanvas)
        this.deps.store.put("canvas", record.id, record as CanvasExport);
      else this.deps.store.put("question", record.id, record as SlackQuestion);
    }
  }
  async handle(p: Record<string, any>, ack: SlackAck): Promise<boolean> {
    const action =
      p.type === "block_actions" &&
      p.actions?.length === 1 &&
      ["canvas_open", "question_open"].includes(p.actions[0]?.action_id);
    const submit =
      p.type === "view_submission" &&
      ["zana_canvas_v1", "zana_question_v1"].includes(p.view?.callback_id);
    if (!action && !submit) return false;
    if (!this.authorized(p)) {
      await ack(submit ? { response_action: "clear" } : undefined);
      return true;
    }
    if (action) {
      await this.open(p, ack);
      return true;
    }
    const isCanvas = p.view.callback_id === "zana_canvas_v1",
      id = p.view.private_metadata;
    const record =
      typeof id === "string" && id.length <= 150
        ? isCanvas
          ? this.deps.store.get("canvas", id)
          : this.deps.store.get("question", id)
        : undefined;
    const b = record && this.deps.store.get("binding", record.key),
      c = this.deps.config();
    if (
      !record ||
      !b ||
      !record.viewId ||
      record.viewId !== p.view.id ||
      !this.permitted(b, record.route, record.ownerEpoch) ||
      (isCanvas ? c.canvasEnabled !== true : c.questionsEnabled !== true) ||
      record.expires <= Date.now()
    ) {
      await ack({ response_action: "clear" });
      return true;
    }
    if (isCanvas) {
      const exportRecord = record as CanvasExport,
        d = this.deps.store.get("delivery", exportRecord.deliveryId);
      if (
        exportRecord.state === "draft" &&
        d?.state === "sent" &&
        fingerprint(d) === exportRecord.digest &&
        (c.richResultsEnabled === true || !d.result)
      )
        this.deps.store.put("canvas", id, { ...exportRecord, state: "queued" });
      await ack({ response_action: "clear" });
      this.deps.changed();
      return true;
    }
    const q = record as SlackQuestion;
    if (
      q.state !== "waiting" ||
      q.requestId !== b.lastRequest ||
      !featureEnabled(c, "followups")
    ) {
      await ack({ response_action: "clear" });
      return true;
    }
    const values = object(p.view.state?.values),
      answers: string[] = [];
    for (const [i, question] of q.questions.entries()) {
      const free = values[`free${i}`]?.text?.value,
        choice = values[`q${i}`]?.choice?.selected_option?.value;
      const answer =
        typeof free === "string" && free.trim() && free.length <= 500
          ? free.trim()
          : typeof choice === "string" && /^[0-2]$/.test(choice)
            ? question.options[Number(choice)]
            : undefined;
      if (!answer) {
        await ack({
          response_action: "errors",
          errors: { [`q${i}`]: "Choose an option or write an answer." },
        });
        return true;
      }
      answers.push(answer);
    }
    const receiptId = `form:${hash(q.id)}`;
    // Leave the modal and question open when admission would reject the answer.
    // No receipt is consumed, so the same form can be submitted after the queue drains.
    if (
      !this.deps.store.get("receipt", receiptId) &&
      this.deps.store.count("receipt", [
        "received",
        "queued",
        "dispatching",
        "needs-review",
      ]) >= 100
    ) {
      await ack({
        response_action: "errors",
        errors: {
          q0: "Zana's request queue is full. Try sending these answers again shortly.",
        },
      });
      return true;
    }
    // Persist the stable receipt first. A crash before marking the form answered can
    // only replay that same receipt, so it cannot enqueue another follow-up.
    let response: Record<string, unknown> | undefined;
    try {
      await this.deps.accept(
        {
          id: receiptId,
          team: b.team,
          app: b.app,
          user: c.owner!,
          channel: b.channel,
          root: b.root,
          ts: `${Math.floor(Date.now() / 1000)}.000001`,
          text:
            "Answers to your Slack questions:\n" +
            q.questions
              .map((question, i) => `${i + 1}. ${question.text}\n${answers[i]}`)
              .join("\n\n"),
        },
        async () => {
          response = { response_action: "clear" };
        },
      );
    } catch (error) {
      throw error;
    }
    if (this.deps.store.get("receipt", receiptId)?.state === "rejected") {
      await ack({
        response_action: "errors",
        errors: {
          q0: "This answer was rejected. Send a new follow-up in the conversation.",
        },
      });
      return true;
    }
    this.deps.store.put("question", id, { ...q, state: "answered", answers });
    await ack(response);
    this.deps.changed();
    return true;
  }
  async tick(): Promise<void> {
    const client = this.deps.client();
    if (this.busy || !client) return;
    this.busy = true;
    try {
      for (const q of this.deps.store.list("question", ["waiting"], 100)) {
        const b = this.deps.store.get("binding", q.key);
        if (
          !b ||
          q.expires <= Date.now() ||
          this.deps.config().questionsEnabled !== true ||
          !featureEnabled(this.deps.config(), "followups") ||
          q.requestId !== b.lastRequest ||
          !this.permitted(b, q.route, q.ownerEpoch)
        ) {
          this.deps.store.put("question", q.id, { ...q, state: "cancelled" });
          this.deps.changed();
        }
      }
      if (this.deps.config().canvasEnabled !== true) return;
      const r = this.deps.store.next("canvas", [
        "queued",
        "created",
        "sharing",
      ]);
      if (!r) return;
      const b = this.deps.store.get("binding", r.key),
        d = this.deps.store.get("delivery", r.deliveryId);
      if (
        !b ||
        !d ||
        d.state !== "sent" ||
        fingerprint(d) !== r.digest ||
        (r.state === "queued" && r.expires <= Date.now()) ||
        (d.result && this.deps.config().richResultsEnabled !== true) ||
        !this.permitted(b, r.route, r.ownerEpoch) ||
        !(await this.deps.authorize(b)) ||
        !this.permitted(b, r.route, r.ownerEpoch) ||
        this.deps.client() !== client ||
        this.deps.config().canvasEnabled !== true
      ) {
        this.deps.store.put("canvas", r.id, {
          ...r,
          state: "failed",
          note: "Result or sharing permission changed before export.",
        });
        this.deps.changed();
        return;
      }
      if (r.state === "queued") {
        this.deps.store.put("canvas", r.id, { ...r, state: "creating" });
        try {
          const result = await slackCall(client, "canvases.create", {
            conversation_channel: b.channel,
            conversation_ts: b.root,
            title: r.title.slice(0, 200),
            document_content: { type: "markdown", markdown: r.markdown },
            ...(!DIRECT.test(b.channel) ? { channel_id: b.channel } : {}),
          });
          if (
            result.ok === true &&
            /^F[A-Z0-9]{5,30}$/.test(result.canvas_id || "")
          ) {
            r.canvasId = result.canvas_id;
            r.url = canvasUrl(b.team, result.canvas_id);
            r.state = "created";
            r.note = "Canvas created; link delivery pending.";
          } else {
            r.state = result.ok === false ? "failed" : "uncertain";
            r.note = `Canvas creation not confirmed: ${String(result.error || "unknown").slice(0, 80)}. Check Slack app scopes and plan.`;
          }
        } catch {
          r.state = "uncertain";
          r.note =
            "Canvas creation unconfirmed. Inspect Slack; automatic retries are disabled.";
        }
        this.deps.store.put("canvas", r.id, r);
        if (r.state === "failed" || r.state === "uncertain") {
          const notice = `canvas-notice:${r.id.slice(7)}`;
          this.deps.enqueue(
            b,
            r.state === "uncertain"
              ? "Canvas creation was not confirmed. Inspect Slack and the Canvas activity in Zana for Slack on your computer before attempting another export. Automatic retries are disabled."
              : "Canvas export could not be completed. Check the Slack app permissions and plan in Zana for Slack on your computer.",
            notice,
          );
          this.deps.store.put("delivery", notice, {
            ...this.deps.store.get("delivery", notice)!,
            canvasId: r.id,
            requestedRoute: r.route,
          });
        }
        this.deps.changed();
        return;
      }
      const announcement = `canvas-link:${r.id.slice(7)}`;
      if (r.state === "created") {
        this.deps.enqueue(
          b,
          `Canvas snapshot: ${r.title}\n${r.url}`,
          announcement,
        );
        this.deps.store.put("delivery", announcement, {
          ...this.deps.store.get("delivery", announcement)!,
          canvasId: r.id,
          requestedRoute: r.route,
        });
        r.state = "sharing";
        this.deps.store.put("canvas", r.id, r);
        this.deps.changed();
        return;
      }
      const delivery = this.deps.store.get("delivery", announcement);
      if (delivery?.state !== "sent") {
        if (
          delivery &&
          ["failed", "uncertain", "reviewed"].includes(delivery.state)
        ) {
          r.state = delivery.state === "failed" ? "failed" : "uncertain";
          r.note =
            "Canvas exists, but its link delivery was not confirmed. Inspect Slack before retrying.";
          this.deps.store.put("canvas", r.id, r);
          this.deps.changed();
        } else this.deps.store.put("canvas", r.id, { ...r, next: Date.now() });
        return;
      }
      // Slack requires a direct link delivery before granting user access to a private Canvas.
      if (DIRECT.test(b.channel)) {
        try {
          const result = await slackCall(client, "canvases.access.set", {
            canvas_id: r.canvasId,
            access_level: "read",
            user_ids: [this.deps.config().owner],
          });
          if (result.ok !== true) {
            r.state = "failed";
            r.note = `Canvas exists; owner access unavailable: ${String(result.error || "unknown").slice(0, 80)}.`;
          } else {
            r.state = "published";
            r.note = "Private snapshot shared with the linked owner.";
          }
        } catch {
          r.next = Date.now() + 60000;
          r.note =
            "Owner access update unconfirmed; this idempotent grant can be checked again.";
        }
      } else {
        r.state = "published";
        r.note = "Snapshot published to the selected channel.";
      }
      this.deps.store.put("canvas", r.id, r);
      this.deps.changed();
    } finally {
      this.busy = false;
    }
  }
}
