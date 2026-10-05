# Progress and formatted answers

One temporary status message belongs to each Slack task. Zana revises it in place for working, thinking or attention; unchanged activity does not send another message. An idle callback is checked against the current thread before ending the task. An unanswered automatic continuation restores the same receipt and status. Polling also repairs a missed active callback after reload, checking at most two active tasks and one rotating unanswered task per ten-second poll.

After the turn ends and the answer is confirmed sent, the temporary status is removed. A turn that actually ends without publishing shows an attention notice. Failed, stopped and uncertain deliveries retain their useful notices. Muting suppresses delivery while work continues.

Shared answer text and rich-report text accept standard Markdown. A bounded Marked lexer converts headings, bold/italic/strike, lists, checkboxes, quotes, inline code and fenced code into Slack `rich_text` blocks. Code bodies are preserved, with the language fence removed. Tables have a compact preformatted fallback. This does not change the existing answer/report limits or sharing consent.

Only literal rich-text nodes are generated. Mentions, Markdown links, HTML and image references never become user/broadcast/action nodes or cause an upload/fetch. A definitive unsupported-block response falls back per reply to compatible blocks, preserving images and readable text. If Slack also rejects those blocks, the literal answer loses Markdown markers and includes verified diagram links. One rejection never disables rich formatting for future replies. An ambiguous write is not retried.

Mermaid fences and rich-result code sections with `language: mermaid` render locally to PNG. Up to two unique diagrams appear as native Slack image blocks in the same answer. Slack hosts the generated image privately; completing its upload does not send a separate file post. Identical source reuses the recorded upload across answer revisions and reloads. An uncertain upload is never repeated automatically. If rendering, permission or upload fails, the answer retains labelled **Diagram source (Mermaid)**. Include a short readable overview alongside diagrams.

While a reply’s Mermaid image is rendering, uploading or waiting for Slack to process it, the existing working notice ends with **🎨 Formatting in process…**. It updates in place, survives bounded image retries and disappears when the answer is confirmed delivered. It adds no extra thread reply.

Slack may reject a newly completed upload while it is still processing. A definitive `invalid_blocks` response for a reply containing an image defers the same reply for bounded waits of one, three and eight seconds before fallback. Each attempt rechecks sharing and destination authority, and reuses the original upload. The working notice remains until the final answer is confirmed sent; no extra reply is posted.

The existing optional, owner-confirmed Canvas export reuses confirmed diagram images through Slack file permalinks and removes the corresponding source fence. It does not enable Canvas automatically. Mermaid rendering uses strict settings, local assets and disabled network requests in an isolated headless Chromium process; it requires installed Google Chrome or Puppeteer's downloaded Chromium. Source, time, dimensions and PNG size are bounded. Markdown files and referenced local images are not read or uploaded.

Activation requires the prepared gateway update, Slack's `files:write` bot permission and app reinstall. The manifests request no `files:read` permission. Until activation, existing Slack installations continue to receive the source fallback.

References: [Slack rich-text blocks](https://docs.slack.dev/reference/block-kit/blocks/rich-text-block/), [Slack formatting](https://docs.slack.dev/messaging/formatting-message-text/). Slack also has a [Markdown block](https://docs.slack.dev/reference/block-kit/blocks/markdown-block/) for apps using platform AI features; native rich text avoids depending on that feature being enabled.
