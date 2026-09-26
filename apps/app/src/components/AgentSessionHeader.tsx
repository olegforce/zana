import type { ReactNode } from 'react';
import { Folder } from 'lucide-react';
import type { AgentState, TerminalSession } from '@zana-ai/zcc-domain/product';
import { ThreadDetailHeading } from './thread/timeline/ThreadBanners.js';
import { useMobileThreadTitleTarget } from './useMobileThreadTitleTarget.js';
import { mobileCliAgentStatus } from './mobile-agent-items.js';

/** Routed CLI agents share the phone's two-row header with threads. */
export function AgentSessionHeader({ session, state, projectName, useShellTitle, children }: {
  session: TerminalSession;
  state: AgentState;
  projectName: string;
  useShellTitle: boolean;
  children: ReactNode;
}) {
  const target = useMobileThreadTitleTarget(useShellTitle);
  const status = mobileCliAgentStatus(session, state);
  return <header className="thread-detail-header" data-title-in-shell={Boolean(target) || undefined}>
    <ThreadDetailHeading title={session.title} titleTarget={target} />
    <div className="thread-detail-actions">
      {target && <div className="mobile-cli-context">
        <span className="mobile-agent-status" data-status={status}>{status}</span>
        <span className="mobile-cli-project" title={projectName}><Folder size={14} aria-hidden="true" /><span>{projectName}</span></span>
      </div>}
      {children}
    </div>
  </header>;
}
