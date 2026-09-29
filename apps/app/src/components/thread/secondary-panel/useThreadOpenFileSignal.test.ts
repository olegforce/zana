import { afterEach, describe, expect, it } from 'vitest';
import { addClosableTab, emptySecondaryPanelState } from './threadSecondaryPanelState.js';
import {
  bufferThreadOpenFile,
  MAX_PENDING_PREVIEWS_PER_THREAD,
  MAX_PENDING_PREVIEW_THREADS,
  consumePendingOpenFile,
  isOpenableWorkspaceRelPath,
  openWorkspaceFileForThread,
  parseThreadOpenFilePayload,
  resetThreadOpenFileBuffer,
  tabFromOpenFile
} from './useThreadOpenFileSignal.js';

describe('thread-open file signal', () => {
  it.each(['workspace', 'thread-storage'] as const)('clears a previous line focus when requesting a whole %s file', (source) => {
    const focused = addClosableTab(emptySecondaryPanelState(), tabFromOpenFile({ source, path: 'report.md', lineNumber: 2 }));
    const wholeFile = addClosableTab(focused, tabFromOpenFile({ source, path: 'report.md', lineNumber: null }));
    expect(wholeFile.tabs[0].id).toBe(focused.tabs[0].id);
    expect(wholeFile.tabs[0].lineNumber).toBeNull();
  });
  afterEach(() => {
    resetThreadOpenFileBuffer();
  });

  it('parses workspace and storage payloads and ignores malformed ones', () => {
    expect(parseThreadOpenFilePayload(null)).toBeNull();
    expect(parseThreadOpenFilePayload({ threadId: 't1', file: null })).toEqual({
      threadId: 't1',
      file: null
    });
    expect(parseThreadOpenFilePayload({
      threadId: 't1',
      file: { source: 'workspace', path: 'src/a.ts', lineNumber: 12 }
    })?.file).toEqual({ source: 'workspace', path: 'src/a.ts', lineNumber: 12 });
    expect(parseThreadOpenFilePayload({
      threadId: 't1',
      file: { source: 'thread-storage', path: 'notes/a.md', lineNumber: null }
    })?.file).toEqual({ source: 'thread-storage', path: 'notes/a.md', lineNumber: null });
  });

  it('buffers then drains the oldest file for a thread', () => {
    bufferThreadOpenFile('t1', { source: 'workspace', path: 'a.ts', lineNumber: null });
    bufferThreadOpenFile('t1', { source: 'thread-storage', path: 'b.md', lineNumber: 2 });
    expect(consumePendingOpenFile('missing')).toBeNull();
    expect(consumePendingOpenFile('t1')).toMatchObject({ path: 'a.ts' });
    expect(consumePendingOpenFile('t1')).toMatchObject({ path: 'b.md' });
    expect(consumePendingOpenFile('t1')).toBeNull();
  });

  it('maps intents onto file-preview and storage-preview tabs', () => {
    expect(tabFromOpenFile({ source: 'workspace', path: 'src/a.ts', lineNumber: null })).toEqual({
      kind: 'file-preview',
      title: 'a.ts',
      path: 'src/a.ts',
      lineNumber: null
    });
    expect(tabFromOpenFile({ source: 'thread-storage', path: 'notes/plan.md', lineNumber: null })).toEqual({
      kind: 'storage-preview',
      title: 'plan.md',
      path: 'notes/plan.md',
      lineNumber: null
    });
    expect(tabFromOpenFile({ source: 'workspace', path: 'src/a.ts', lineNumber: 12 })).toEqual({
      kind: 'file-preview',
      title: 'a.ts',
      path: 'src/a.ts',
      lineNumber: 12
    });
  });

  it('bounds pending threads and files and coalesces repeated paths with their latest line', () => {
    for (let thread = 0; thread <= MAX_PENDING_PREVIEW_THREADS; thread++) {
      bufferThreadOpenFile(`t${thread}`, { source: 'workspace', path: 'a.md', lineNumber: null });
    }
    expect(consumePendingOpenFile('t0')).toBeNull();
    expect(consumePendingOpenFile('t1')?.path).toBe('a.md');
    for (let file = 0; file <= MAX_PENDING_PREVIEWS_PER_THREAD; file++) {
      bufferThreadOpenFile('files', { source: 'workspace', path: `${file}.md`, lineNumber: null });
    }
    expect(consumePendingOpenFile('files')?.path).toBe('1.md');
    bufferThreadOpenFile('coalesced', { source: 'workspace', path: 'a.md', lineNumber: 1 });
    bufferThreadOpenFile('coalesced', { source: 'thread-storage', path: 'a.md', lineNumber: null });
    bufferThreadOpenFile('coalesced', { source: 'workspace', path: 'a.md', lineNumber: 9 });
    expect(consumePendingOpenFile('coalesced')?.source).toBe('thread-storage');
    expect(consumePendingOpenFile('coalesced')).toEqual({ source: 'workspace', path: 'a.md', lineNumber: 9 });
    expect(consumePendingOpenFile('coalesced')).toBeNull();
  });

  it('opens confined workspace paths on a thread and rejects escapes', () => {
    expect(isOpenableWorkspaceRelPath('src/a.ts')).toBe(true);
    expect(isOpenableWorkspaceRelPath('../secret')).toBe(false);
    expect(isOpenableWorkspaceRelPath('')).toBe(false);
    expect(openWorkspaceFileForThread(null, 'src/a.ts')).toBe(false);
    expect(openWorkspaceFileForThread('t1', '../secret')).toBe(false);
    expect(openWorkspaceFileForThread('t1', 'src/a.ts')).toBe(true);
    expect(consumePendingOpenFile('t1')).toEqual({
      source: 'workspace',
      path: 'src/a.ts',
      lineNumber: null
    });
  });

  it('parses the hub thread-open payload an MCP preview emits', () => {
    expect(parseThreadOpenFilePayload({
      type: 'thread-open',
      projectId: 'p1',
      threadId: 't1',
      split: 'right',
      file: { source: 'workspace', path: 'src/a.ts', lineNumber: 3 }
    })).toEqual({
      threadId: 't1',
      file: { source: 'workspace', path: 'src/a.ts', lineNumber: 3 }
    });
  });
});
