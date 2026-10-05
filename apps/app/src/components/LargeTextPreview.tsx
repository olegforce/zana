import { useState } from 'react';
import { copyText } from '../lib/copy-text.js';

export const TEXT_PREVIEW_CHARS = 64_000;
export const TEXT_PREVIEW_LINES = 1_000;

/** Stop scanning as soon as either budget is reached. */
export function boundedText(text: string, chars = TEXT_PREVIEW_CHARS, lines = TEXT_PREVIEW_LINES): string {
  const candidate = text.slice(0, chars);
  let end = candidate.length;
  let offset = 0;
  for (let line = 0; line < lines; line++) {
    const next = candidate.indexOf('\n', offset);
    if (next < 0 || next >= end) break;
    offset = next + 1;
    if (line === lines - 1) end = offset;
  }
  return candidate.slice(0, end);
}

export function LargeTextPreview({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const preview = boundedText(text);
  return <div>
    <p role="status">Showing a text preview{preview.length < text.length ? ' of a large document' : ''}.</p>
    <button type="button" className="btn" onClick={() => {
      void copyText(text).then(() => { setCopied(true); setFailed(false); }).catch(() => setFailed(true));
    }}>{copied ? 'Copied full text' : 'Copy full text'}</button>
    {failed && <p role="alert">Could not copy text.</p>}
    <pre className="inbox-doc-pre">{preview}</pre>
    {preview.length < text.length && <p>Preview shortened. Copy full text to read the complete content.</p>}
  </div>;
}
