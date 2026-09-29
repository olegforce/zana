import { useLayoutEffect, useState } from 'react';
import { useCompactLayout } from '../hooks/useCompactLayout.js';

export const MOBILE_THREAD_TITLE_ID = 'mobile-thread-title';
export const MOBILE_THREAD_ACTIONS_ID = 'mobile-thread-actions';
export const MOBILE_THREAD_CONTROLS_ID = 'mobile-thread-controls';

/** Only the focused thread page lends its existing title to the mobile shell. */
export function useMobileThreadTitleTarget(enabled: boolean) {
  return useMobileHeaderTarget(enabled, MOBILE_THREAD_TITLE_ID);
}

export function useMobileThreadActionsTarget(enabled: boolean) {
  return useMobileHeaderTarget(enabled, MOBILE_THREAD_ACTIONS_ID);
}

export function useMobileThreadControlsTarget(enabled: boolean) {
  return useMobileHeaderTarget(enabled, MOBILE_THREAD_CONTROLS_ID);
}

function useMobileHeaderTarget(enabled: boolean, slotId: string) {
  const compact = useCompactLayout();
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setTarget(enabled && compact ? document.getElementById(slotId) : null);
  }, [enabled, compact, slotId]);
  return enabled && compact ? target : null;
}
