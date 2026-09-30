import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { SharePreviewLink, localPreviewPort } from './SharePreviewLink.js';
it('offers explicit sharing for loopback HTTP previews and never guesses a remote target', () => {
  expect(localPreviewPort('http://localhost:5173/page')).toBe(5173);
  expect(localPreviewPort('http://127.0.0.1:3000')).toBe(3000);
  for (const value of ['bad', 'https://localhost:5173', 'http://localhost:80', 'http://other.test:3000']) expect(localPreviewPort(value)).toBeNull();
  expect(renderToStaticMarkup(<MemoryRouter><SharePreviewLink url="http://localhost:5173" /></MemoryRouter>)).toContain('/settings/remote-access?previewPort=5173');
  expect(renderToStaticMarkup(<SharePreviewLink url="http://localhost:5173" />)).toBe('');
  expect(renderToStaticMarkup(<MemoryRouter><SharePreviewLink url="https://example.com" /></MemoryRouter>)).toBe('');
});
