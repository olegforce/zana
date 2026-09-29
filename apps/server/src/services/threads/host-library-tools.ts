import { LibraryAgentRequestSchema } from '@zana-ai/zcc-contracts/library-agent';
import { withProjectLibrary } from '../library/project-library-queue.js';
import { invokeRemoteLibraryTool } from '../library/remote-library-tools.js';
/** Agent tools share the product runtime and its original-owner journal with user edits. */
import type { DynamicTool, ToolCallResponse } from '@zana-ai/zcc-domain/thread-runtime';
import type { LibraryDoc } from '@zana-ai/zcc-domain/product';
import { pluginToolResultToResponse } from '../../plugins/plugin-agent-tools.js';
import type { ProductHttpContext } from '../../http/product-context.js';
import {
  LIBRARY_LIST_DESCRIPTION,
  LIBRARY_READ_DESCRIPTION,
  LIBRARY_REMOVE_DESCRIPTION,
  LIBRARY_WRITE_DESCRIPTION
} from '../library/library-mcp-tools.js';

export const LIBRARY_WRITE_NAME = 'library_write';
export const LIBRARY_READ_NAME = 'library_read';
export const LIBRARY_LIST_NAME = 'library_list';
export const LIBRARY_REMOVE_NAME = 'library_remove';

export const HOST_LIBRARY_INSTRUCTION =
  'Persist project knowledge with `library_write` / `library_read` / `library_list` / `library_remove` (this project\'s `.zcc/library`).';

const FRONT_MATTER_FENCE = '---';
const MAX_FRONT_MATTER_TAGS = 100;

export const HOST_LIBRARY_TOOLS: DynamicTool[] = [
  {
    name: LIBRARY_WRITE_NAME,
    description: LIBRARY_WRITE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['relPath'],
      properties: {
        relPath: { type: 'string', minLength: 1 },
        title: { type: 'string' },
        content: { type: 'string' },
        summary: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } }
      }
    },
    presentation: {
      label: { pending: 'Saving library doc', completed: 'Saved library doc' },
      icon: { glyph: 'Book' }
    }
  },
  {
    name: LIBRARY_READ_NAME,
    description: LIBRARY_READ_DESCRIPTION,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['relPath'],
      properties: { relPath: { type: 'string', minLength: 1 } }
    },
    presentation: {
      label: { pending: 'Reading library doc', completed: 'Read library doc' },
      icon: { glyph: 'BookOpen' }
    }
  },
  {
    name: LIBRARY_LIST_NAME,
    description: LIBRARY_LIST_DESCRIPTION,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    presentation: {
      label: { pending: 'Listing library', completed: 'Listed library' },
      icon: { glyph: 'Library' }
    }
  },
  {
    name: LIBRARY_REMOVE_NAME,
    description: LIBRARY_REMOVE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['relPath'],
      properties: { relPath: { type: 'string', minLength: 1 } }
    },
    presentation: {
      label: { pending: 'Removing library doc', completed: 'Removed library doc' },
      icon: { glyph: 'Trash' }
    }
  }
];

function fail(name: string, error: string): ToolCallResponse {
  return pluginToolResultToResponse(name, { ok: false, error });
}

export function kindFromExt(ext: string): LibraryDoc['kind'] {
  const lower = ext.toLowerCase();
  if (lower === '.md' || lower === '.markdown') return 'md';
  if (lower === '.pdf') return 'pdf';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(lower)) return 'image';
  if (['.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.hpp', '.sh', '.bash', '.zsh', '.json', '.yaml', '.yml', '.toml', '.xml', '.html', '.css', '.scss', '.sql'].includes(lower)) return 'code';
  return 'other';
}

export function validateAgentRelPath(relPath: string): void {
  if (!relPath || relPath.trim() === '') throw new Error('relPath is required');
  const normalized = relPath.split('\\').join('/');
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) {
    throw new Error('relPath must be relative, not absolute');
  }
  if (normalized.includes('..')) throw new Error('relPath must not contain ".." (path traversal)');
  const segments = normalized.split('/').filter((s) => s.length > 0);
  for (const seg of segments) {
    if (seg.startsWith('.')) {
      throw new Error(`relPath segment "${seg}" is reserved (no dot-prefixed names)`);
    }
  }
  if (segments[segments.length - 1] === 'index.json') {
    throw new Error('relPath "index.json" is reserved (the library manifest)');
  }
}

export function serializeFrontMatter(
  meta: { id: string; title: string; summary?: string; tags?: string[]; createdAt: number; sourceKind?: string },
  body: string
): string {
  const lines: string[] = [FRONT_MATTER_FENCE];
  lines.push(`id: ${JSON.stringify(meta.id)}`);
  lines.push(`title: ${JSON.stringify(meta.title)}`);
  if (meta.summary !== undefined) lines.push(`summary: ${JSON.stringify(meta.summary)}`);
  if (meta.tags && meta.tags.length > 0) {
    lines.push(`tags: [${meta.tags.map((t) => JSON.stringify(t)).join(', ')}]`);
  }
  if (meta.sourceKind) lines.push(`source: ${JSON.stringify(meta.sourceKind)}`);
  lines.push(`createdAt: ${meta.createdAt}`);
  lines.push(FRONT_MATTER_FENCE);
  lines.push('');
  return `${lines.join('\n')}${body}`;
}

export function parseFrontMatter(raw: string): { meta: { id?: string; title?: string; summary?: string; tags?: string[]; createdAt?: number; sourceKind?: string }; body: string } | null {
  if (!raw.startsWith(`${FRONT_MATTER_FENCE}\n`)) return null;
  const needle = `\n${FRONT_MATTER_FENCE}`;
  let end = raw.indexOf(needle, FRONT_MATTER_FENCE.length);
  while (end >= 0) {
    const after = raw[end + needle.length];
    if (after === undefined || after === '\n') break;
    end = raw.indexOf(needle, end + needle.length);
  }
  if (end < 0) return null;
  const block = raw.slice(FRONT_MATTER_FENCE.length + 1, end);
  const afterFence = raw.indexOf('\n', end + 1);
  const body = afterFence < 0 ? '' : raw.slice(afterFence + 1);
  const meta: { id?: string; title?: string; summary?: string; tags?: string[]; createdAt?: number; sourceKind?: string } = {};
  const decode = (v: string): string => {
    const t = v.trim();
    if (t.startsWith('"')) {
      try {
        return JSON.parse(t) as string;
      } catch {
        return t;
      }
    }
    return t;
  };
  for (const line of block.split('\n')) {
    const sepIdx = line.indexOf(':');
    if (sepIdx < 0) continue;
    const key = line.slice(0, sepIdx).trim();
    const val = line.slice(sepIdx + 1).trim();
    if (key === 'id') meta.id = decode(val);
    else if (key === 'title') meta.title = decode(val);
    else if (key === 'summary') meta.summary = decode(val);
    else if (key === 'source') meta.sourceKind = decode(val);
    else if (key === 'createdAt') {
      const n = Number(val);
      if (Number.isFinite(n)) meta.createdAt = n;
    } else if (key === 'tags') {
      const inner = val.replace(/^\[/, '').replace(/\]$/, '').trim();
      if (inner) {
        meta.tags = inner.split(',').slice(0, MAX_FRONT_MATTER_TAGS).map((t) => decode(t)).filter((t) => t.length > 0);
      }
    }
  }
  return { meta, body };
}

export function summarize(doc: LibraryDoc) {
  return {
    relPath: doc.relPath,
    title: doc.title,
    summary: doc.summary,
    tags: doc.tags,
    kind: doc.kind,
    updatedAt: doc.updatedAt
  };
}

export async function invokeHostLibraryTool(ctx: ProductHttpContext, args: { name: string; threadId?: string; projectId: string; input: unknown }, deadline?: number): Promise<ToolCallResponse> {
  try {
    const input = args.input && typeof args.input === 'object' && !Array.isArray(args.input) ? args.input : {};
    LibraryAgentRequestSchema.parse({ ...input, action: args.name.replace(/^library_/, ''), projectId: args.projectId, sessionId: args.threadId });
    return await withProjectLibrary(`${ctx.dataDir}:${args.projectId}`, async () => {
      const project = ctx.toProjects().find(row => row.id === args.projectId);
      if (!project) return fail(args.name, 'Project is not registered');
      return invokeRemoteLibraryTool(ctx, project, args, deadline);
    }, JSON.stringify(input).length * 2);
  } catch (error) {
    return fail(args.name, error instanceof Error ? error.message : 'Shared metadata host unavailable');
  }
}
