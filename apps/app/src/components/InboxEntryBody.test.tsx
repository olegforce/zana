/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { InboxEntry, Project } from '@zana-ai/zcc-domain/product';

const { pushToast, readFile, readDataUrl, exportPdf } = vi.hoisted(() => ({
  pushToast: vi.fn(),
  readFile: vi.fn(async () => ({ ok: true, content: '# Doc' })),
  readDataUrl: vi.fn(),
  exportPdf: vi.fn(async () => ({ ok: true, path: '/tmp/out.pdf' }))
}));

vi.mock('../lib/product-client.js', () => ({
  product: {
    fs: { readFile, readDataUrl },
    inbox: { exportPdf }
  }
}));

vi.mock('../store.js', () => ({
  useUi: (selector: (s: { pushToast: typeof pushToast }) => unknown) => selector({ pushToast })
}));

vi.mock('./MarkdownContent.js', () => ({
  MarkdownContent: ({ text }: { text: string }) => <div data-testid="md">{text}</div>,
  DocContent: ({ path, content }: { path: string; content: string }) => (
    <div data-testid="doc">{path}:{content}</div>
  )
}));

vi.mock('../lib/renderReportHtml.js', () => ({
  renderReportHtml: async () => '<html>report</html>'
}));

import { InboxEntryBody } from './InboxEntryBody.js';

const project: Project = { id: 'p1', name: 'Alpha', path: '/tmp/alpha' } as Project;

describe('InboxEntryBody', () => {
  afterEach(() => {
    cleanup();
    pushToast.mockClear();
    readFile.mockClear();
    readDataUrl.mockReset();
    exportPdf.mockClear();
  });

  it('displays image attachments in compact reports', async () => {
    readDataUrl.mockResolvedValue({ ok: true, dataUrl: 'data:image/png;base64,cGl4ZWxz' });
    render(<InboxEntryBody entry={{ id: 'image', ts: 1, projectId: 'p1', docs: [{ path: 'preview.png' }] }} project={project} />);
    const image = await screen.findByRole('img', { name: 'preview.png' });
    expect(image.getAttribute('src')).toBe('data:image/png;base64,cGl4ZWxz');
    expect(readDataUrl).toHaveBeenCalledWith('/tmp/alpha/preview.png');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('shows image read failures and deleted projects', async () => {
    readDataUrl.mockRejectedValue(new Error('Image unavailable'));
    const entry: InboxEntry = { id: 'image', ts: 1, projectId: 'p1', docs: [{ path: 'preview.png' }] };
    const { rerender } = render(<InboxEntryBody entry={entry} project={project} />);
    await screen.findByText('Image unavailable');
    rerender(<InboxEntryBody entry={entry} project={null} />);
    await screen.findByText('Project no longer exists');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('ignores an image load after the report is unmounted', async () => {
    let finish!: (result: unknown) => void;
    readDataUrl.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { unmount } = render(<InboxEntryBody entry={{ id: 'image', ts: 1, projectId: 'p1', docs: [{ path: 'preview.png' }] }} project={project} />);
    await waitFor(() => expect(readDataUrl).toHaveBeenCalled());
    unmount();
    finish({ ok: true, dataUrl: 'data:image/png;base64,cGl4ZWxz' });
    await waitFor(() => expect(screen.queryByRole('img')).toBeNull());
  });

  it('renders comments and export actions', () => {
    const html = renderToStaticMarkup(
      <InboxEntryBody
        entry={{ id: 'e1', ts: 1, projectId: 'p1', subject: 'Weekly', comments: 'all green' } as InboxEntry}
        project={project}
      />
    );
    expect(html).toContain('Weekly');
    expect(html).toContain('all green');
    expect(html).toContain('aria-label="Copy report to clipboard"');
    expect(html).toContain('aria-label="Download this report as PDF"');
  });

  it('hides export actions when there is nothing to export', () => {
    const html = renderToStaticMarkup(
      <InboxEntryBody
        entry={{ id: 'e1', ts: 1, projectId: 'p1', subject: 'Empty' } as InboxEntry}
        project={project}
      />
    );
    expect(html).toContain('Empty');
    expect(html).not.toContain('Copy report to clipboard');
  });

  it('loads a live doc and copies plus exports', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
    render(
      <InboxEntryBody
        entry={{
          id: 'e1',
          ts: 1,
          projectId: 'p1',
          subject: 'Weekly',
          comments: 'notes',
          docs: [{ path: 'REPORT.md' }]
        } as InboxEntry}
        project={project}
      />
    );
    await waitFor(() => expect(screen.getByTestId('doc').textContent).toBe('REPORT.md:# Doc'));
    fireEvent.click(screen.getByLabelText('Copy report to clipboard'));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(pushToast).toHaveBeenCalledWith('Report copied', 'info');
    fireEvent.click(screen.getByLabelText('Download this report as PDF'));
    await waitFor(() => expect(exportPdf).toHaveBeenCalled());
    expect(pushToast).toHaveBeenCalledWith('PDF saved to /tmp/out.pdf', 'info');
  });
});
