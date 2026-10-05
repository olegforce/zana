import { describe, expect, it } from 'vitest';
import { bytesFromFileResponse, pdfBlobFromFileResponse, resolvePdfReadTarget } from '../pdf-source.js';

describe('pdf-preview source', () => {
  it('builds thread host and storage URLs', () => {
    expect(
      resolvePdfReadTarget('docs/spec.pdf', {
        kind: 'workspace',
        threadId: 'thr_1',
        environmentId: null,
        projectId: 'p1'
      })
    ).toBe('/api/v1/threads/thr_1/host-files/content?path=docs%2Fspec.pdf&projectId=p1');
    expect(
      resolvePdfReadTarget('inbox.pdf', {
        kind: 'thread-storage',
        threadId: 'thr_1',
        environmentId: null,
        projectId: null
      })
    ).toBe('/api/v1/threads/thr_1/thread-storage/content?path=inbox.pdf');
  });

  it('encodes host identifiers and paths and ignores project scope for storage', () => {
    expect(resolvePdfReadTarget('a & b.pdf', { kind: 'host', threadId: 'a/b', projectId: 'p & 1' }))
      .toBe('/api/v1/threads/a%2Fb/host-files/content?path=a+%26+b.pdf&projectId=p+%26+1');
    expect(resolvePdfReadTarget('a.pdf', { kind: 'host', threadId: 't' }))
      .toBe('/api/v1/threads/t/host-files/content?path=a.pdf');
    expect(resolvePdfReadTarget('a.pdf', { kind: 'thread-storage', threadId: 't', projectId: 'p' }))
      .toBe('/api/v1/threads/t/thread-storage/content?path=a.pdf');
    expect(resolvePdfReadTarget('a.pdf', { kind: 'unknown', threadId: 't' })).toBeNull();
  });

  it('falls back to the host preview when there is no thread', () => {
    expect(
      resolvePdfReadTarget('docs/spec.pdf', {
        kind: 'workspace',
        threadId: null,
        environmentId: null,
        projectId: 'p1'
      })
    ).toBeNull();
  });

  it('rejects non-PDF payloads', () => {
    expect(() => bytesFromFileResponse({ content: 'hello', encoding: 'utf8' })).toThrow(/not a PDF/);
    expect(() => bytesFromFileResponse(null)).toThrow(/not a PDF/);
    expect(() => bytesFromFileResponse({ content: '!!!', encoding: 'base64' })).toThrow();
    const pdf = `%PDF-1.4\n`;
    const utf8 = bytesFromFileResponse({ content: pdf, encoding: 'utf8' });
    expect(new TextDecoder().decode(utf8.slice(0, 4))).toBe('%PDF');
    const bytes = bytesFromFileResponse({ content: btoa(pdf), encoding: 'base64' });
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('%PDF');
    const blob = pdfBlobFromFileResponse({ content: btoa(pdf), encoding: 'base64' });
    expect(blob.type).toBe('application/pdf');
    expect(blob.size).toBeGreaterThan(4);
  });
});
