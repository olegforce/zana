// The heavy half of DiffViewer, split into its own module so it can be
// React.lazy()'d. `react-diff-viewer-continued` drags in emotion + the `diff`
// library + js-yaml; keeping it here (behind a dynamic import in DiffViewer.tsx)
// stops it riding the first-paint chunk via the always-mounted AgentModalHost.
// It's only needed once the user actually opens a diff (agent inspector,
// explorer, library), so it loads on demand.
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';
import { boundedText, LargeTextPreview } from './LargeTextPreview.js';

export default function DiffViewerInner({
  original,
  modified,
  compactStyles,
  splitView = false,
  isDark
}: {
  original: string;
  modified: string;
  compactStyles: Record<string, unknown>;
  splitView?: boolean;
  isDark: boolean;
}) {
  // The dependency falls back to synchronous diffing when its worker fails.
  // Admission bounds both that fallback and the number of changed rows.
  if (boundedText(original, 32_000, 500).length < original.length ||
      boundedText(modified, 32_000, 500).length < modified.length) {
    return <section aria-label="Large diff">
      <p>This diff is large. Showing the original and modified text.</p>
      <h4>Original</h4><LargeTextPreview text={original} />
      <h4>Modified</h4><LargeTextPreview text={modified} />
    </section>;
  }
  return (
    <ReactDiffViewer
      oldValue={original}
      newValue={modified}
      splitView={splitView}
      showDiffOnly
      extraLinesSurroundingDiff={2}
      hideLineNumbers={false}
      // Faster for large files than word-level/char-heavy modes.
      compareMethod={DiffMethod.LINES}
      disableWordDiff
      infiniteLoading={{ containerHeight: '400px', pageSize: 80 }}
      hideSummary
      useDarkTheme={isDark}
      styles={compactStyles}
    />
  );
}
