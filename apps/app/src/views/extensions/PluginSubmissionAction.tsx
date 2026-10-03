import { Upload } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useUi } from '@/store';
import type { HubRow } from './installed-plugins.js';
import { canSubmitPlugin, pluginSubmissionNavigation } from './plugin-submission.js';

/** Opens a reviewable draft; the user sends it through the ordinary composer. */
export function PluginSubmissionAction({ row, onChoose }: { row: HubRow; onChoose: () => void }) {
  const navigate = useNavigate();
  const projectId = useUi((state) => state.selectedProjectId);
  if (!canSubmitPlugin(row)) return null;
  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        onChoose();
        const target = pluginSubmissionNavigation(row, projectId);
        void navigate(target.pathname, { state: target.state });
      }}
    >
      <Upload size={14} />
      Submit to marketplace
    </button>
  );
}
