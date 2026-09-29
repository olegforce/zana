import type { ReactNode } from 'react';
import type { AgentState, TerminalSession } from '@zana-ai/zcc-domain/product';
import { ThreadDetailActions, ThreadDetailHeading } from './thread/timeline/ThreadBanners.js';
import { useMobileThreadControlsTarget, useMobileThreadTitleTarget } from './useMobileThreadTitleTarget.js';
import { mobileCliAgentStatus } from './mobile-agent-items.js';

/** Routed CLI agents share the phone's single-row header with threads. */
export function AgentSessionHeader({ session, state, projectName, useShellTitle, children }: {
  session: TerminalSession;
  state: AgentState;
  projectName: string;
  useShellTitle: boolean;
  children: ReactNode;
}) {
  const target = useMobileThreadTitleTarget(useShellTitle);
  const controls = useMobileThreadControlsTarget(useShellTitle);
  const status = mobileCliAgentStatus(session, state);
  return <header className="thread-detail-header" data-title-in-shell={Boolean(target) || undefined} data-controls-in-shell={Boolean(controls) || undefined}>
    <ThreadDetailHeading title={session.title} titleTarget={target} />
    <ThreadDetailActions target={controls}>
      {target && <span className="mobile-agent-status mobile-cli-status" data-status={status}
        role="img" aria-label={`${projectName} · ${status}`} title={`${projectName} · ${status}`}>{status}</span>}
      {children}
    </ThreadDetailActions>
  </header>;
}
