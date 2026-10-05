// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { boundedText, LargeTextPreview } from './LargeTextPreview';
import DiffViewerInner from './DiffViewerInner';
import { DocContent, MarkdownContent } from './MarkdownContent';
const copy = vi.hoisted(() => vi.fn());
vi.mock('../lib/copy-text.js', () => ({ copyText: copy }));
vi.mock('react-diff-viewer-continued', () => ({ default: (props: any) => <div data-testid="diff">{JSON.stringify(props.infiniteLoading)}</div>, DiffMethod: { LINES: 'lines' } }));
afterEach(() => { cleanup(); copy.mockReset(); });
it('stops at both budgets and preserves small text', () => {
  expect(boundedText('abc')).toBe('abc'); expect(boundedText('abcdef', 3)).toBe('abc');
  expect(boundedText('a\nb\nc\n', 100, 2)).toBe('a\nb\n');
});
it('copies the complete source and reports copy failure', async () => {
  const text = 'x'.repeat(100_000); copy.mockRejectedValueOnce(new Error('denied')).mockResolvedValueOnce(undefined);
  const { container } = render(<LargeTextPreview text={text} />);
  expect(container.querySelector('pre')!.textContent).toHaveLength(64_000);
  fireEvent.click(screen.getByRole('button')); await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button')); await screen.findByText('Copied full text');
  expect(copy).toHaveBeenLastCalledWith(text); expect(screen.queryByRole('alert')).toBeNull();
});
it('bounds Markdown and code document rendering before parsing', () => {
  const text = '```javascript\n' + 'const x = 1;\n'.repeat(10_000) + '```';
  const a = render(<MarkdownContent text={text} />); expect(a.container.querySelector('pre')!.textContent!.length).toBeLessThanOrEqual(64_000); a.unmount();
  const b = render(<DocContent content={text} path="large.js" />); expect(b.container.querySelectorAll('.hljs-keyword')).toHaveLength(0);
});
it('admits small diffs to virtual rendering and bounds large or many-line diffs', () => {
  const props = { original: 'a', modified: 'b', compactStyles: {}, isDark: false };
  const view = render(<DiffViewerInner {...props} />); expect(screen.getByTestId('diff').textContent).toContain('80');
  view.rerender(<DiffViewerInner {...props} original={'x'.repeat(32_001)} />); expect(screen.getByRole('region', { name: 'Large diff' })).toBeTruthy();
  expect(screen.queryByTestId('diff')).toBeNull();
  view.rerender(<DiffViewerInner {...props} modified={'x\n'.repeat(501)} />); expect(screen.queryByTestId('diff')).toBeNull();
});
