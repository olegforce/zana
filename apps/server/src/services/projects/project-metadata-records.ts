import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { ProjectMetadataRequestSchema, type ProjectMetadataRecord, type ProjectMetadataResult } from '@zana-ai/zcc-contracts/project-metadata-records';
import type { HostRpcCommand, HostListDirResult, HostReadPathResult, HostWriteFileResult } from '@zana-ai/zcc-contracts/host-rpc';
import type { ProductHttpContext } from '../../http/product-context.js';
import { resolveProjectHost } from '../../http/project-host.js';
import { validateScheduleFile } from '../scheduler/schedule-validation.js';
import { validateGoalFile } from '../goals/goal-validation.js';
import { validateFollowUpFile } from '../followups/followup-validation.js';
import { projectMetadataLocation } from './project-metadata.js';

const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_LIST_BYTES = 8 * 1024 * 1024;
const validators = { schedules: validateScheduleFile, goals: validateGoalFile, followups: validateFollowUpFile };
const hash = (content: string) => createHash('sha256').update(content).digest('hex');
const conflict = () => Object.assign(new Error('Project metadata changed; refresh it before retrying.'), { code: 'metadata_conflict' });

/** The instance's managers call this private runtime operation. Caller supplies
 * record identity/revision only; project path and host come from the server.
 * Mutations use the host's atomic revision check, including local-owner records.
 */
export async function projectMetadataRecords(ctx: ProductHttpContext, raw: unknown, requestDeadline = Date.now() + 15_000): Promise<ProjectMetadataResult> {
  const request = ProjectMetadataRequestSchema.parse(raw);
  const deadline = Math.min(requestDeadline, Date.now() + 15_000);
  const project = ctx.toProjects().find(row => row.id === request.projectId);
  if (!project) throw new Error('Unknown metadata project');
  const owner = projectMetadataLocation(project);
  const hostId = resolveProjectHost(ctx, owner.hostId);
  ctx.hostHub.ensureHostSessionReady(hostId);
  const rpc = <T>(command: HostRpcCommand): Promise<T> => {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) return Promise.reject(new Error('Project metadata operation timed out'));
    return ctx.hostHub.callHostOnlineRpc<T>({ hostId, command, timeoutMs });
  };
  const prefix = `.zcc/${request.kind}`;
  const pathFor = (id: string) => posix.join(owner.path, prefix, `${id}.json`);
  const envelope = (records: ProjectMetadataRecord[]): ProjectMetadataResult => ({ projectId: project.id, kind: request.kind, hostId, records });
  function checked(id: string, content: string): ProjectMetadataRecord {
    if (Buffer.byteLength(content) > MAX_RECORD_BYTES) throw new Error('Project metadata record exceeds 1 MiB');
    const value: unknown = JSON.parse(content);
    const parsed = validators[request.kind](value);
    if ('error' in parsed) throw new Error(`Invalid ${request.kind} record: ${parsed.error}`);
    if (parsed.id !== id || parsed.projectId !== project!.id) throw new Error('Project metadata record identity mismatch');
    return { id, content, sha256: hash(content) };
  }
  async function read(id: string): Promise<ProjectMetadataRecord | null> {
    try {
      const result = await rpc<HostReadPathResult>({ type: 'host.read_path', rootPath: owner.path, path: pathFor(id) });
      if (result.contentEncoding !== 'utf8') throw new Error('Project metadata must be UTF-8 JSON');
      return checked(id, result.content);
    } catch (error) {
      if ((error as { code?: string }).code === 'path_not_found') return null;
      throw error;
    }
  }
  if (request.action === 'list') {
    let listing: HostListDirResult;
    try {
      listing = await rpc<HostListDirResult>({ type: 'host.list_dir', root: owner.path, relPath: prefix });
    } catch (error) {
      if ((error as { code?: string }).code === 'path_not_found') return envelope([]);
      throw error;
    }
    if (listing.entries.length >= 2000) throw new Error('Project metadata directory exceeds the complete listing limit');
    const records: ProjectMetadataRecord[] = [];
    let bytes = 0;
    for (const entry of listing.entries) {
      if (!/\.json$/i.test(entry.name)) continue;
      if (entry.kind !== 'file' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}\.json$/.test(entry.name)) throw new Error('Invalid project metadata filename');
      const record = await read(entry.name.slice(0, -5));
      if (record === null) continue; // Concurrent external removal, not an empty/offline substitute.
      bytes += Buffer.byteLength(record.content);
      if (bytes > MAX_LIST_BYTES) throw new Error('Project metadata listing exceeds 8 MiB');
      records.push(record);
    }
    return envelope(records);
  }
  if (request.action === 'write') {
    const record = checked(request.id, request.content);
    try {
      const result = await rpc<HostWriteFileResult>({
        type: 'host.write_file', rootPath: owner.path, path: pathFor(request.id), content: request.content,
        contentEncoding: 'utf8', createParents: true, mode: 0o600, expectedSha256: request.expectedSha256
      });
      if (result.outcome !== 'written') throw conflict();
    } catch (error) {
      // A missing reply is not permission to replay a write. Accept only an
      // exact read-back of the attempted commit; preserve conflicts/errors.
      if ((error as { code?: string }).code === 'metadata_conflict') throw error;
      const observed = await read(request.id).catch(() => null);
      if (observed?.sha256 !== record.sha256) throw error;
    }
    return envelope([record]);
  }
  try {
    await rpc({ type: 'host.remove_path', rootPath: owner.path, path: pathFor(request.id), recursive: false, expectedSha256: request.expectedSha256 });
  } catch (error) {
    // Retrying a delete must never remove a later replacement of this record.
    const observed = await read(request.id).catch(() => undefined);
    if (observed !== null) throw error;
  }
  return envelope([]);
}
