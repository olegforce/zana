import { useSyncExternalStore } from 'react';
import { RefreshCw } from 'lucide-react';
import { getModelRefreshState, refreshModels, subscribeModelRefresh } from '../../components/thread/pickers/model-refresh.js';

export function ModelRefreshControl() {
  const state = useSyncExternalStore(subscribeModelRefresh, getModelRefreshState, getModelRefreshState);
  return (
    <div>
      <button type="button" className="settings-btn primary" disabled={state.running}
        data-testid="harness-recalculate-models"
        onClick={() => { void refreshModels(); }}>
        <RefreshCw size={14} className={state.running ? 'harness-recheck-spin' : undefined} aria-hidden />
        {state.running ? 'Recalculating models…' : 'Recalculate models'}
      </button>
      <p className="settings-help" role="status" aria-live="polite">
        {state.message ?? 'Reload every available model list for Modern and CLI Agent pickers without restarting the app.'}
      </p>
    </div>
  );
}
