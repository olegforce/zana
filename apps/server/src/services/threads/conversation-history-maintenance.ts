import { maintainConversationHistory, maintainConversationEventHistory, type ZccDatabase } from '@zana-ai/zcc-db';

export function startConversationHistoryMaintenance(db: ZccDatabase): () => void {
  const timer = setInterval(() => {
    try { maintainConversationHistory(db); maintainConversationEventHistory(db); }
    catch (error) { console.warn('[history] maintenance deferred:', error instanceof Error ? error.message : 'database unavailable'); }
  }, 30_000);
  timer.unref();
  return () => clearInterval(timer);
}
