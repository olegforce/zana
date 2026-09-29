import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { PROJECT_FEED_MAX_BYTES, PROJECT_FEED_MAX_EVENTS, ProjectFeedEventSchema, ProjectFeedRequestSchema, type ProjectFeedResult } from '@zana-ai/zcc-contracts/project-feed';
import type { HostRpcCommand, HostReadPathResult, HostFileMetadataResult, HostWriteFileResult } from '@zana-ai/zcc-contracts/host-rpc';
import type { ProductHttpContext } from '../../http/product-context.js';
import { resolveProjectHost } from '../../http/project-host.js';
import { projectMetadataLocation } from '../projects/project-metadata.js';
import { BoundedKeyedQueue } from '../bounded-keyed-queue.js';

const queues = new WeakMap<ProductHttpContext, BoundedKeyedQueue>();
const hash = (content: string) => createHash('sha256').update(content).digest('hex');
const code = (error: unknown) => (error as { code?: string })?.code;

/** Original-owner JSONL, preserving existing event IDs and format. All callers
 * serialize here; the daemon repeats confinement and checks the file revision. */
export async function projectFeed(ctx: ProductHttpContext, raw: unknown, requestDeadline = Date.now() + 15_000): Promise<ProjectFeedResult> {
  const request = ProjectFeedRequestSchema.parse(raw);
  const requestBytes = Buffer.byteLength(JSON.stringify(request));
  if (requestBytes > PROJECT_FEED_MAX_BYTES) throw new Error('Activity feed request is too large');
  if (request.action === 'append' && request.events.some(event => event.projectId !== request.projectId)) throw new Error('Activity feed project mismatch');
  const queue = queues.get(ctx) ?? new BoundedKeyedQueue(4, 100, 'Too many pending activity feed operations'); queues.set(ctx, queue);
  const deadline = Math.min(requestDeadline, Date.now() + 15_000);
  return queue.run(request.projectId, async () => {
    const project = ctx.toProjects().find(row => row.id === request.projectId);
    if (!project) throw new Error('Unknown activity feed project');
    const owner = projectMetadataLocation(project), hostId = resolveProjectHost(ctx, owner.hostId);
    ctx.hostHub.ensureHostSessionReady(hostId);
    const boundaryPath = posix.join(owner.path, '.zcc'), path = posix.join(boundaryPath, 'activity.jsonl');
    const scope = { rootPath: owner.path, boundaryPath, path };
    const rpc = <T>(command: HostRpcCommand): Promise<T> => {
      const timeoutMs = deadline - Date.now();
      if (timeoutMs <= 0) return Promise.reject(new Error('Activity feed operation timed out'));
      const current = ctx.toProjects().find(row => row.id === request.projectId);
      // Compare against primitive owner values captured before I/O. A store
      // implementation may update the registered Project object in place.
      if (!current || current.path !== owner.path || current.hostId !== owner.hostId || current.remote) return Promise.reject(new Error('Activity feed owner changed'));
      return ctx.hostHub.callHostOnlineRpc<T>({ hostId, command, timeoutMs });
    };
    async function read(): Promise<{ content: string; sha256: string | null }> {
      try {
        const metadata = await rpc<HostFileMetadataResult>({ type: 'host.file_metadata', ...scope });
        if (metadata.sizeBytes > PROJECT_FEED_MAX_BYTES) throw new Error('Activity feed file is too large');
        const result = await rpc<HostReadPathResult>({ type: 'host.read_path', ...scope });
        if (result.contentEncoding !== 'utf8' || Buffer.byteLength(result.content) > PROJECT_FEED_MAX_BYTES) throw new Error('Activity feed must be bounded UTF-8 JSONL');
        return { content: result.content, sha256: hash(result.content) };
      } catch (error) { if (code(error) === 'path_not_found') return { content: '', sha256: null }; throw error; }
    }
    const observed = await read();
    const events: ProjectFeedResult['events'] = [];
    let malformed = false;
    for (const line of observed.content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = ProjectFeedEventSchema.parse(JSON.parse(line));
        if (event.projectId !== project.id) throw new Error('Activity feed record project mismatch');
        events.push(event);
      } catch { malformed = true; }
    }
    events.sort((a, b) => b.ts - a.ts);
    if (request.action === 'list') return { projectId: project.id, hostId, events: events.slice(0, PROJECT_FEED_MAX_EVENTS), added: 0 };
    // A read can display intact lines of a damaged legacy file. A write cannot
    // silently delete the damaged lines as a side effect of adding a commit.
    if (malformed) throw new Error('Activity feed contains invalid records; repair the file before writing');
    const seen = new Set(events.map(event => event.dedupeKey));
    let added = 0;
    for (const event of request.events) {
      if (seen.has(event.dedupeKey)) continue;
      seen.add(event.dedupeKey); added++;
      events.push({ ...event, id: `feed_${hash(`${project.id}\0${event.dedupeKey}`)}` });
    }
    events.sort((a, b) => b.ts - a.ts); events.length = Math.min(events.length, PROJECT_FEED_MAX_EVENTS);
    let content = events.map(event => JSON.stringify(event) + '\n').join('');
    while (Buffer.byteLength(content) > PROJECT_FEED_MAX_BYTES) { events.pop(); content = events.map(event => JSON.stringify(event) + '\n').join(''); }
    if (added) {
      try {
        const result = await rpc<HostWriteFileResult>({ type: 'host.write_file', ...scope, content, contentEncoding: 'utf8', createParents: true, mode: 0o600, expectedSha256: observed.sha256 });
        if (result.outcome !== 'written') throw Object.assign(new Error('Activity feed changed; refresh before retrying'), { code: 'metadata_conflict' });
      } catch (error) {
        if (code(error) === 'metadata_conflict' || (await read().catch(() => null))?.sha256 !== hash(content)) throw error;
      }
    }
    return { projectId: project.id, hostId, events, added };
  }, requestBytes * 2);
}
