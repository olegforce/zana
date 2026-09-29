# Bounded thread history

Zana applies the history protections used by BB to its own event schema and UI.
Source attribution: [BB history reference](third-party/bb-shared-machines.md).

The host's acknowledged event transaction ignores incoming `turn/diff/updated`
workspace snapshots. Ignoring them consumes no event sequence, and replaying an
acknowledged batch cannot insert them. Completed file changes and conversation
messages are still stored.

Completed command, tool, image-generation, web-fetch and web-search output
strings above 32,768 characters are stored separately. The timeline event keeps
2,048 characters from each end, with a preview marker and original length.
Full output is available for bounded hydration for seven days; after that the
preview remains. User and assistant messages do not expire. Forks copy the
retained output with its original expiry, and deleting or rewinding an event
also removes its retained output.

A product-context maintenance timer runs every 30 seconds and is disposed with
the context. It deletes at most 32 expired outputs and examines at most 32 old
diff snapshots per pass. A durable indexed cursor resumes snapshot cleanup
after restart. Cleanup preserves each thread's highest event sequence. Existing
large inline tool outputs are also previewed inside SQLite during timeline reads.

The same timer also advances five BB-derived policies: rate-limit snapshots,
context usage, token usage, resolved stream fragments, and background-task
progress. Each policy examines at most 32 indexed candidates per interval.
Metadata indexes resolve supporting events without loading their output into
JavaScript. Cursors and deletions commit together; a locked database defers this
work immediately and restores the normal SQLite timeout.

Usage cleanup discovers the latest root snapshot and the latest root context
capacity in a bounded first pass, then deletes obsolete snapshots in a second
pass. Nested-turn usage cannot replace root usage. If rewind removes a keeper,
discovery restarts before deletion. The header separately reads bounded windows
of root usage and capacity metadata, so a later update with unknown capacity
does not hide the retained capacity. Rate-limit cleanup retains the latest
snapshot on an unarchived thread; archived threads can discard it subject to
the highest-sequence safeguard.

Resolved-item cleanup retains the first fragment of each event kind, turn,
item and parent identity. Subsequent assistant, command and reasoning fragments
are removed only when a later matching completed item contains final output.
Empty assistant/reasoning results and missing command output are preserved
conservatively. Final results, started items, user messages, file changes and
unresolved fragments are not deleted. Background progress retains the latest
live state until a newer matching progress or completion supersedes it.

Timeline pages default to 20 conversation groups, with a maximum of 100.
Indexed request boundaries guide selection. Reads are bounded by payload bytes
and 50,000 event positions, with separate context for a streamed message that
crosses the window boundary. Ignored payloads and large output previews are
selected in SQLite before strings reach V8. The general database-read ceiling
remains 16 MiB. A request requiring a larger indivisible payload fails with a
recoverable error; it does not return an apparently complete partial history.

The response target is 4 MiB / 500 leaves. A single indivisible row can exceed
that target within the database-read ceiling. Content cursors continue inside
a large turn, preserve nested parent identities, and pin the history tip so new
appends do not enter an older-page walk. A removed anchor or changed display
surface requires a reload. As in BB, edits to existing history are best effort
between pages, rather than a retained database snapshot. Latest goal and usage
state is queried separately so an old snapshot does not widen the history read.
The server's latest-row cache is capped at 64 entries and 32 MiB of serialized rows.

The thread view offers **Load earlier messages**. Expanded turns offer
**Load earlier details** and retry failed requests. Clients recursively merge
turn and delegation children by stable identity. The main view caps accumulated
history at 32 × 1024² serialized JSON characters and explains when a reload is
needed. This renderer limit counts UTF-16 code units, not UTF-8 bytes or total
process memory. Expanded-turn details use the same limit.

HTTP clients must follow `timelinePage.olderCursor` by sending both
`beforeAnchorId` and `beforeAnchorSeq`, and keep display options unchanged.
`GET /api/v1/threads/:id/timeline/turn-summary-details` accepts `beforeCursor`
and returns `olderCursor`; repeat until null. Raw event HTTP remains a separate
bounded event stream and now returns stored tool previews, not an implicit
hydration of every retained output.

Regression coverage includes acknowledged-batch replay, atomic preview/output
writes, expiry and rewind, bounded cleanup across reopen, nested page merging,
large streamed messages, and the built-Electron 1,200 MiB Unicode history plus
continuation regression. Built UI tests exercise both older-message and
expanded-turn controls. A separate built-Electron regression runs the real
maintenance timer, verifies pruning and retained answers/output/context capacity,
then continues the conversation with unchanged runtime PIDs. The thread launch
live suites remain required.
