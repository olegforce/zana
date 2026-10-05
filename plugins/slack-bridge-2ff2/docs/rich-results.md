# Rich results in Zana for Slack

In **Plugins → Zana for Slack → Configuration**, enable **Share rich results**. Agent reports also require **Share answers** and the destination channel's agent-summary setting. Results render directly in chat; custom web panels are optional and can stay off to avoid redundant task attachment cards.

Messages use native Slack blocks for text, preformatted code/diffs, tables, charts and task summaries. The custom panel adds a **Summary / Report** switch, local table sorting, accessible horizontal bar charts, colored diff excerpts and a three-column read-only task board. It refreshes every ten seconds. The existing launch forms, Home dashboard, fixed conversations and Stop/Mute controls remain the entry points.

The report is agent-supplied; Zana does not assert that checks passed or independently verify its values. Task states are a reported snapshot. Table sorting does not change stored data or trigger an agent action.

## Publishing contract

The existing `slack_bridge_publish` tool accepts this optional `result` next to its required concise `text`:

```json
{
  "text": "The review is ready. One change needs attention.",
  "result": {
    "title": "Release review",
    "sections": [
      {
        "type": "text",
        "title": "Finding",
        "text": "Review the retry setting before publishing."
      },
      {
        "type": "table",
        "title": "Checks",
        "columns": ["Check", "Status"],
        "rows": [
          ["Launch", "Passed"],
          ["Delivery", "Passed"]
        ]
      },
      {
        "type": "chart",
        "title": "Duration",
        "unit": "ms",
        "points": [
          { "label": "Launch", "value": 120 },
          { "label": "Delivery", "value": 210 }
        ]
      },
      {
        "type": "code",
        "title": "Example",
        "language": "typescript",
        "text": "const retries = 2;"
      },
      {
        "type": "diff",
        "title": "Suggested change",
        "text": "- retries: 0\n+ retries: 2"
      },
      {
        "type": "tasks",
        "title": "Next steps",
        "items": [
          { "text": "Review change", "status": "pending" },
          { "text": "Run checks", "status": "done" }
        ]
      }
    ]
  }
}
```

The host supplies the Project/thread and destination. Neither the agent nor report can choose another channel. Repeated agent publications revise one answer per turn; operator publications are separate deliveries. `queued` means durable acceptance, not confirmed delivery. Do not repeat an uncertain write.

## Bounds

| Field                 | Limit                                                                |
| --------------------- | -------------------------------------------------------------------- |
| Summary               | 2,000 characters                                                     |
| Report                | 16,000 UTF-8 bytes, 1–8 sections                                     |
| Title / section title | 120 / 50 characters                                                  |
| Text / code or diff   | 2,500 / 2,800 characters                                             |
| Table                 | One table, 1–4 columns, 1–20 rows; 100 characters per cell           |
| Chart                 | Two charts, 1–12 unique labels; finite nonnegative values up to 10¹² |
| Task board            | 1–12 items; statuses `pending`, `running`, `done`                    |

Unknown fields are rejected. Reports accept data, not HTML, JavaScript, arbitrary Slack blocks, actions or attachment paths. Excerpts are literal inert text; sharing does not grant filesystem access. Full files, transcripts, native questions and permission dialogs remain in Zana.

## Delivery and access

The existing outbox rechecks owner, connection, route, mute and sharing policy before sending and before any fallback. Only Slack-confirmed reports appear in the task panel. Slack may reject newer blocks in a workspace; a definitive rejection falls back to the concise answer and preserves the report for the authorized panel. Timeouts remain uncertain and do not retry.

Panel access remains owner-only, task-scoped and valid for five minutes. Policy changes invalidate prior grants, even if the setting is changed outside the normal RPC. Revocation/expiry clears displayed reports, including after suspended-page recovery. Offline snapshots are labeled and expire on the same deadline. Disabling rich results stops future queued report delivery and removes reports from newly opened panels; it does not erase previously posted Slack messages.

Turning custom panels off prevents new task attachments. Status refreshes explicitly clear retained preview metadata and attachments when the gateway supports removal. The operator RPC `removeTaskPreview({id: deliveryId})` removes a preview from one confirmed task message while retaining its recorded text and rich sections in that same message. Slack requires content on the update and an empty attachments array to remove the visible Work Object card. Cleanup requires an owned, connected destination and previews switched off. An older hosted gateway may reject removal until updated; status delivery still works, but the old card remains. Check Slack after an uncertain removal rather than assuming success.

This implementation uses [Slack tables](https://docs.slack.dev/reference/block-kit/blocks/table-block/), [chart blocks](https://docs.slack.dev/reference/block-kit/blocks/data-visualization-block/) and [Work Object embeds](https://docs.slack.dev/messaging/work-objects-embeds/). Dedicated assistant chat and Canvas publishing are follow-on work; this slice adds no new Slack scopes and requires no hosted service change. Native Slack availability still needs a real workspace trial.
