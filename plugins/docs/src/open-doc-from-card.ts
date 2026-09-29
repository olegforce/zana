import type { JsonValue } from '@zana-ai/zcc-plugin-sdk';
import type { ZccNavigate } from '@zana-ai/zcc-plugin-sdk/app';
import { libraryPanelSubPath } from './library-panel-path.js';
import type { ParsedDocDirective } from './doc-directive.js';

export function openDocFromCard({
  document,
  projectId,
  threadId,
  openWorkspaceFile,
  openThreadPanel,
  toPluginPanel
}: {
  document: ParsedDocDirective;
  projectId?: string | null;
  threadId?: string | null;
  openWorkspaceFile?: ((path: string) => boolean) | null;
  openThreadPanel?: ZccNavigate['openThreadPanel'];
  toPluginPanel?: ZccNavigate['toPluginPanel'];
}): boolean {
  if (document.source === 'workspace') {
    if (typeof openWorkspaceFile !== 'function') return false;
    return openWorkspaceFile(document.path) === true;
  }
  const params: JsonValue = {
    path: document.path,
    scope: document.scope,
    title: document.title,
    ...(document.scope === 'project' && typeof projectId === 'string' && projectId.trim()
      ? { projectId: projectId.trim() }
      : {})
  };
  const panelThreadId = typeof threadId === 'string' && threadId.trim() ? threadId.trim() : undefined;
  const opened =
    typeof openThreadPanel === 'function' &&
    openThreadPanel({
      actionId: 'document',
      title: document.title,
      params,
      ...(panelThreadId ? { threadId: panelThreadId } : {})
    }) === true;
  if (opened) return true;
  if (typeof toPluginPanel === 'function') {
    toPluginPanel('panel', {
      subPath: libraryPanelSubPath({
        scope: document.scope,
        projectId,
        relPath: document.path
      })
    });
  }
  return false;
}
