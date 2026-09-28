import { describe, expect, it } from 'vitest';
import { browserPreviewIdentity, sameBrowserDocument } from './browser-preview.js';

describe('browserPreviewIdentity', () => {
  it('treats a local dev server as one preview', () => {
    const root = browserPreviewIdentity('http://localhost:5173');
    expect(root).toBe(browserPreviewIdentity('http://localhost:5173/'));
    expect(root).toBe(browserPreviewIdentity('http://127.0.0.1:5173/dashboard'));
    expect(root).toBe(browserPreviewIdentity('http://localhost:5173/settings#tab'));
    expect(root).not.toBe(browserPreviewIdentity('http://localhost:5174'));
    expect(root).not.toBe(browserPreviewIdentity('https://localhost:5173'));
  });

  it('keeps remote documents distinct and ignores slash and hash', () => {
    expect(browserPreviewIdentity('https://example.com')).toBe(browserPreviewIdentity('https://example.com/'));
    expect(browserPreviewIdentity('https://example.com/docs')).toBe(
      browserPreviewIdentity('https://Example.com/docs#section')
    );
    expect(browserPreviewIdentity('https://example.com/a')).not.toBe(browserPreviewIdentity('https://example.com/b'));
    expect(browserPreviewIdentity('')).toBeNull();
    expect(browserPreviewIdentity('about:blank')).toBeNull();
  });
});

describe('sameBrowserDocument', () => {
  it('ignores a trailing slash and does not collapse different routes', () => {
    expect(sameBrowserDocument('http://localhost:5173', 'http://localhost:5173/')).toBe(true);
    expect(sameBrowserDocument('http://localhost:5173/', 'http://127.0.0.1:5173')).toBe(true);
    expect(sameBrowserDocument('http://localhost:5173/', 'http://localhost:5173/dashboard')).toBe(false);
    expect(sameBrowserDocument('https://example.com/docs', 'https://example.com/docs/')).toBe(true);
    expect(sameBrowserDocument('about:blank', 'http://localhost:5173')).toBe(false);
  });
});
