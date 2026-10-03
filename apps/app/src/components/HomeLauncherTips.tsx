import type { ReactNode } from 'react';
import { ContextualHelp } from './help/ContextualHelp.js';
import { HOME_LAUNCHER_TIPS } from './home-launcher-tips.js';

export function HomeLauncherTips({ children }: { children: ReactNode }) {
  return <ContextualHelp surfaceId="home-launcher" tips={HOME_LAUNCHER_TIPS}
    className="home-launcher-tips" regionLabel="Launcher tip">{children}</ContextualHelp>;
}
