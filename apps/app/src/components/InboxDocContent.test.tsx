// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { readFile, readDataUrl } = vi.hoisted(() => ({ readFile: vi.fn(), readDataUrl: vi.fn() }));
vi.mock('../lib/product-client.js', () => ({ product: { fs: { readFile, readDataUrl } } }));
vi.mock('./MarkdownContent.js', () => ({
  DocContent: ({ content }: { content: string }) => <div data-testid="document">{content}</div>
}));
import { InboxDocContent, readInboxDocPreview } from './InboxDocContent.js';

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

it.each(['png', 'JPG', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'])('reads %s with the image reader', async (extension) => {
  const path = `/project/screenshot #1.${extension}`;
  readDataUrl.mockResolvedValue({ ok: true, dataUrl: 'data:image/png;base64,cGl4ZWxz' });
  await expect(readInboxDocPreview(path)).resolves.toEqual({ ok: true, content: 'data:image/png;base64,cGl4ZWxz' });
  expect(readDataUrl).toHaveBeenCalledExactlyOnceWith(path);
  expect(readFile).not.toHaveBeenCalled();
});

it.each([
  { ok: true, content: '# Report' },
  { ok: false, binary: true },
  { ok: false, truncated: true }
])('preserves text-reader results for other files: %j', async (result) => {
  readFile.mockResolvedValue(result);
  await expect(readInboxDocPreview('/project/report.md')).resolves.toEqual(result);
  expect(readDataUrl).not.toHaveBeenCalled();
});

it.each([
  [{ ok: false, message: 'File too large' }, 'File too large'],
  [{ ok: false }, 'Image preview unavailable'],
  [{ ok: true }, 'Image preview unavailable'],
  [{ ok: true, dataUrl: 'https://example.com/image.png' }, 'Image preview unavailable'],
  [{ ok: true, dataUrl: 'data:text/html;base64,eA==' }, 'Image preview unavailable']
])('rejects unavailable or non-image results: %j', async (result, message) => {
  readDataUrl.mockResolvedValue(result);
  await expect(readInboxDocPreview('/project/image.png')).resolves.toEqual({ ok: false, message });
});

it.each([['image.png', new Error('Host offline'), 'Host offline'], ['report.md', null, 'File could not be read.']])('handles read failures for %s', async (path, error, message) => {
  readDataUrl.mockRejectedValue(error);
  readFile.mockRejectedValue(error);
  await expect(readInboxDocPreview(`/project/${path}`)).resolves.toEqual({ ok: false, message });
});

it('renders images, reports decoding errors, and recovers when the source changes', () => {
  const { rerender } = render(<InboxDocContent path="image.png" content="data:image/png;base64,b2xk" />);
  const image = screen.getByRole('img', { name: 'image.png' });
  expect(image.getAttribute('src')).toBe('data:image/png;base64,b2xk');
  expect(screen.queryByTestId('document')).toBeNull();
  fireEvent.error(image);
  expect(screen.getByRole('status').textContent).toContain('Could not display this image');
  expect(screen.queryByRole('img')).toBeNull();
  rerender(<InboxDocContent path="image.png" content="data:image/png;base64,bmV3" />);
  expect(screen.getByRole('img').getAttribute('src')).toBe('data:image/png;base64,bmV3');
  expect(screen.queryByRole('status')).toBeNull();
});

it.each([['report.md', '# Report'], ['image.svg', '<svg />']])('keeps textual content in the document renderer: %s', (path, content) => {
  render(<InboxDocContent path={path} content={content} />);
  expect(screen.getByTestId('document').textContent).toBe(content);
});
