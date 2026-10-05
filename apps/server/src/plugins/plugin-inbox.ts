import { z } from 'zod';
import type { InboxEntry } from '@zana-ai/zcc-domain/product';
import type {
  PluginSdkInboxEntry,
  PluginSdkInboxSearchArgs,
  PluginSdkInboxSearchResult,
  PluginSdkInboxReport
} from '@zana-ai/zcc-plugin-sdk/server';
import type { ProductHttpContext } from '../http/product-context.js';
import { readPluginProjectFile } from '../http/plugin-project-files.js';

const id = z.string().min(1).max(256);
const scope = z.array(id).min(1).max(500);
const search = z
  .object({
    projectIds: scope,
    query: z.string().max(500).optional(),
    before: id.optional(),
    limit: z.number().int().min(1).max(25).optional(),
    unreadOnly: z.boolean().optional(),
    reportsOnly: z.boolean().optional()
  })
  .strict();
const read = z
  .object({
    projectIds: scope,
    entryId: id,
    documentIndex: z.number().int().min(0).max(99).optional()
  })
  .strict();
export const INBOX_REPORT_MAX_CHARS = 20_000;

function projects(ctx: ProductHttpContext, ids: string[]) {
  const registered = new Map(ctx.toProjects().map((p) => [p.id, p]));
  for (const id of ids) if (!registered.has(id)) throw new Error('Unrecognized inbox Project');
  return registered;
}
function entryView(
  e: InboxEntry,
  name: string,
  readIds: Record<string, true>
): PluginSdkInboxEntry {
  return {
    id: e.id,
    ts: e.ts,
    projectId: e.projectId,
    projectName: name,
    subject: (e.subject || e.intent || 'Report from Zana').slice(0, 200),
    comments: (e.comments || '').slice(0, 4000),
    documents: e.docs?.length || 0,
    unread: readIds[e.id] !== true
  };
}
export async function searchPluginInbox(
  ctx: ProductHttpContext,
  input: PluginSdkInboxSearchArgs
): Promise<PluginSdkInboxSearchResult> {
  const args = search.parse(input),
    registered = projects(ctx, args.projectIds),
    allowed = new Set(args.projectIds);
  const page = await ctx.inbox.read({ limit: 500, before: args.before });
  const state = await ctx.inboxRead.getReadState();
  const needle = (args.query || '').trim().toLowerCase(),
    limit = args.limit || 10;
  const entries: PluginSdkInboxEntry[] = [];
  let last: string | undefined;
  for (let i = 0; i < page.entries.length; i++) {
    const e = page.entries[i];
    last = e.id;
    if (
      !allowed.has(e.projectId) ||
      (args.reportsOnly && !e.report && !e.docs?.length) ||
      (args.unreadOnly && state.readIds[e.id])
    )
      continue;
    if (
      needle &&
      ![e.subject, e.intent, e.comments, ...(e.docs || []).map((d) => d.path)].some((v) =>
        v?.toLowerCase().includes(needle)
      )
    )
      continue;
    entries.push(entryView(e, registered.get(e.projectId)!.name, state.readIds));
    if (entries.length === limit)
      return { entries, hasMore: i < page.entries.length - 1 || page.hasMore, nextBefore: last };
  }
  return { entries, hasMore: page.hasMore, ...(last ? { nextBefore: last } : {}) };
}
export async function readPluginInbox(
  ctx: ProductHttpContext,
  input: { projectIds: string[]; entryId: string; documentIndex?: number }
): Promise<PluginSdkInboxReport> {
  const args = read.parse(input),
    registered = projects(ctx, args.projectIds);
  // The inbox has a finite retention cap. Page rather than accumulating its contents.
  let before: string | undefined, entry: InboxEntry | undefined;
  for (let page = 0; page < 20 && !entry; page++) {
    const result = await ctx.inbox.read({ limit: 500, before });
    entry = result.entries.find((e) => e.id === args.entryId);
    if (!result.hasMore || !result.entries.length) break;
    before = result.entries.at(-1)!.id;
  }
  if (!entry || !args.projectIds.includes(entry.projectId))
    throw new Error('Report is unavailable in the approved Projects');
  const state = await ctx.inboxRead.getReadState();
  const view = entryView(entry, registered.get(entry.projectId)!.name, state.readIds);
  if (!entry.docs?.length)
    return {
      ...view,
      content: (entry.comments || '').slice(0, INBOX_REPORT_MAX_CHARS),
      truncated: (entry.comments || '').length > INBOX_REPORT_MAX_CHARS
    };
  const index = args.documentIndex ?? 0,
    doc = entry.docs[index];
  if (!doc) throw new Error('Report document is unavailable');
  // Path comes from main's inbox entry. The host revalidates the registered
  // checkout and realpath containment, including symlinks, before reading it.
  const result = await readPluginProjectFile(ctx, {
    path: doc.path,
    source: { kind: 'workspace', projectId: entry.projectId, environmentId: null, threadId: null }
  });
  if (result.contentEncoding !== 'utf8') throw new Error('This report document is not text');
  return {
    ...view,
    documentIndex: index,
    content: result.content.slice(0, INBOX_REPORT_MAX_CHARS),
    truncated: result.content.length > INBOX_REPORT_MAX_CHARS
  };
}
