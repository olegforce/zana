import { useEffect, useRef, useState } from 'react';
import { buildTimelineViewRows, type ThreadTimelineViewRow } from '@zana-ai/zcc-thread-view';
import { mergeTimelinePages, type TimelineRow } from '@zana-ai/zcc-server-contract';
import { product } from '../../../lib/product-client.js';
import { ExpandableTimelineRow } from './ExpandableTimelineRow.js';
import { TimelineRows } from './TimelineRows.js';
import type { TimelineTitle } from '@zana-ai/zcc-thread-view';
import { TimelineTitleView } from './TimelineTitleView.js';
import type { TimelineTitleActionHandler, TimelineTitleLinkHandler } from './TimelineTitleView.js';
import type { collectTimelineAutoExpansionRowIds } from './timeline-auto-expand.js';
import { StencilLines } from '../../ui/Skeleton.js';
import type { ThreadChatMessageAction } from '@zana-ai/zcc-plugin-sdk/app';

export function TurnArchiveRow({
  row,
  title,
  now,
  dim,
  expansion,
  unreadRowId,
  onCopy,
  onMessageExpand,
  onTitleAction,
  onTitleLink,
  onOpenDiff,
  threadId,
  streamingAssistantMessageId,
  forceExpandedRowIds,
  projectId,
  parentThreadId,
  threadIdle,
  onFork,
  messageActions,
  includePluginMessageActions,
  filePathHints
}: {
  row: Extract<ThreadTimelineViewRow, { kind: 'turn' }>;
  title: TimelineTitle;
  now: number;
  dim?: boolean;
  expansion: ReturnType<typeof collectTimelineAutoExpansionRowIds>;
  unreadRowId?: string | null;
  onCopy?: (text: string) => void;
  onMessageExpand?: () => void;
  onTitleAction?: TimelineTitleActionHandler;
  onTitleLink?: TimelineTitleLinkHandler;
  onOpenDiff?: (path: string) => void;
  threadId?: string;
  streamingAssistantMessageId?: string | null;
  forceExpandedRowIds?: ReadonlySet<string>;
  projectId?: string | null;
  parentThreadId?: string | null;
  threadIdle?: boolean;
  onFork?: (sourceSeqEnd?: number) => void;
  messageActions?: readonly ThreadChatMessageAction[];
  includePluginMessageActions?: boolean;
  filePathHints?: readonly string[];
}) {
  const [open, setOpen] = useState(row.status === 'interrupted');
  const [children, setChildren] = useState<ThreadTimelineViewRow[] | null>(row.children);
  const [loading, setLoading] = useState(false);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [earlierPortion, setEarlierPortion] = useState(false);
  const details = useRef<TimelineRow[]>([]);
  const generation = useRef(0);
  const expanded = open || forceExpandedRowIds?.has(row.id) === true;

  useEffect(() => {
    setChildren(row.children);
    setOlderCursor(null);
    setLoadError(false);
    setEarlierPortion(false);
    details.current = [];
    generation.current++;
    return () => { generation.current++; };
  }, [row.children, row.id, row.sourceSeqStart, row.sourceSeqEnd, threadId]);

  const loadDetails = async (beforeCursor?: string) => {
    if (!threadId) return;
    const current = generation.current;
    setLoading(true);
    setLoadError(false);
    try {
      const body = await product.threads.timelineTurnSummaryDetails(threadId, {
        turnId: row.turnId, sourceSeqStart: String(row.sourceSeqStart), sourceSeqEnd: String(row.sourceSeqEnd), beforeCursor
      });
      if (current !== generation.current) return;
      const merged = beforeCursor ? mergeTimelinePages(body.rows as TimelineRow[], details.current) : body.rows as TimelineRow[];
      if (JSON.stringify(merged).length > 32 * 1024 * 1024) {
        details.current = body.rows as TimelineRow[];
        setEarlierPortion(true);
      } else {
        details.current = merged;
        if (!beforeCursor) setEarlierPortion(false);
      }
      setChildren(buildTimelineViewRows(details.current));
      setOlderCursor(body.olderCursor ?? null);
    } catch { if (current === generation.current) setLoadError(true); }
    finally { if (current === generation.current) setLoading(false); }
  };

  useEffect(() => {
    if (expanded && children === null && row.children === null) void loadDetails();
  }, [children, expanded, row.children, row.id, row.sourceSeqEnd, row.sourceSeqStart, row.turnId, threadId]);

  return (
    <ExpandableTimelineRow
      testId="thread-turn-summary"
      rowId={row.id}
      status={row.status}
      dim={dim}
      open={expanded}
      expandable
      onToggle={setOpen}
      summary={(
        <TimelineTitleView
          title={title}
          now={now}
          onAction={onTitleAction}
          onLink={onTitleLink}
        />
      )}
    >
      {olderCursor && <button type="button" disabled={loading} onClick={() => void loadDetails(olderCursor)}>Load earlier details</button>}
      {earlierPortion && <button type="button" disabled={loading} onClick={() => void loadDetails()}>Showing earlier details. Return to latest details</button>}
      {loadError && <button type="button" onClick={() => void loadDetails(olderCursor ?? undefined)}>Could not load details. Retry</button>}
      {loading && !children ? (
        <div data-testid="thread-turn-loading">
          <StencilLines label="Loading turn" widths={['70%', '55%', '40%']} />
        </div>
      ) : children && children.length > 0 ? (
        <TimelineRows
          rows={children}
          now={now}
          expansion={expansion}
          unreadRowId={unreadRowId}
          onCopy={onCopy}
          onMessageExpand={onMessageExpand}
          onTitleAction={onTitleAction}
          onTitleLink={onTitleLink}
          onOpenDiff={onOpenDiff}
          threadId={threadId}
          nested
          compactActivityIntents
        streamingAssistantMessageId={streamingAssistantMessageId}
        forceExpandedRowIds={forceExpandedRowIds}
        projectId={projectId}
        parentThreadId={parentThreadId}
        threadIdle={threadIdle}
        onFork={onFork}
        scopeActive={false}
        messageActions={messageActions}
        includePluginMessageActions={includePluginMessageActions}
        filePathHints={filePathHints}
      />
      ) : open ? (
        <p className="thread-timeline-system">No details</p>
      ) : null}
    </ExpandableTimelineRow>
  );
}
