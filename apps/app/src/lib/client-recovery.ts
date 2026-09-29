import type { CcApi } from '@zana-ai/zcc-desktop-contract';
import { subscribeProductReconnect, subscribeProductWs } from './product-ws.js';

/** Rehydrate missed notifications using reads only. Each result is fenced by
 * live events so an older snapshot cannot undo a newly received update. */
export function subscribeClientRecovery(product: CcApi, apply: {
  projects: (value: Awaited<ReturnType<CcApi['projects']['list']>>) => void;
  inbox: (value: Awaited<ReturnType<CcApi['inbox']['history']>>) => void;
  suggestions: (value: Awaited<ReturnType<CcApi['suggestions']['list']>>) => void;
  saved: (value: Awaited<ReturnType<CcApi['saved']['list']>>) => void;
  terminals: (projectId: string, value: Awaited<ReturnType<CcApi['terminals']['list']>>) => void;
}, projectId?: string) {
  let stopped = false;
  const revisions = { projects: 0, inbox: 0, suggestions: 0, saved: 0, terminals: 0 };
  const stopEvents = subscribeProductWs(event => {
    const type = event.type === 'shared:changed' ? (event.payload as { channel?: string })?.channel ?? '' : event.type;
    const family = type.split(':')[0] as keyof typeof revisions;
    if (family in revisions && !type.endsWith(':data') && !type.endsWith(':onData')) revisions[family]++;
  });
  const stopReconnect = subscribeProductReconnect(async () => {
    const before = { ...revisions };
    const current = (family: keyof typeof revisions) => !stopped && before[family] === revisions[family];
    await Promise.allSettled([
      product.projects.list().then(async projects => {
        if (current('projects')) apply.projects(projects);
        // Bound concurrent list reads on accounts with many projects.
        for (let i = 0; i < projects.length && !stopped; i += 8) {
          await Promise.allSettled(projects.slice(i, i + 8).map(async project => {
            if (projectId && project.id !== projectId) return;
            const sessions = await product.terminals.list(project.id);
            if (current('terminals')) apply.terminals(project.id, sessions);
          }));
        }
      }),
      product.inbox.history({ limit: 100, ...(projectId ? { projectId } : {}) }).then(value => { if (current('inbox')) apply.inbox(value); }),
      product.suggestions.list(projectId).then(value => { if (current('suggestions')) apply.suggestions(value); }),
      product.saved.list().then(value => { if (current('saved')) apply.saved(value); })
    ]);
  });
  return () => { stopped = true; stopEvents(); stopReconnect(); };
}
