import { useState } from 'react';
import type { FsReadResult } from '@zana-ai/zcc-domain/product';
import { product } from '../lib/product-client.js';
import { imageContentTypeFromPath } from './thread/timeline/work-row-helpers.js';
import { DocContent } from './MarkdownContent.js';
import './inbox-doc-content.css';

/** Use the bounded, project-confined image reader before the text/binary gate. */
export async function readInboxDocPreview(path: string): Promise<FsReadResult> {
  try {
    if (!imageContentTypeFromPath(path)) return await product.fs.readFile(path);
    const result = await product.fs.readDataUrl(path);
    if (result.ok && result.dataUrl?.startsWith('data:image/')) {
      return { ok: true, content: result.dataUrl };
    }
    return { ok: false, message: result.message ?? 'Image preview unavailable' };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'File could not be read.' };
  }
}

/** Shared by the Inbox and its compact report viewers. SVG stays in an img. */
export function InboxDocContent({ path, content }: { path: string; content: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!imageContentTypeFromPath(path) || !content.startsWith('data:image/')) {
    return <DocContent path={path} content={content} exportable />;
  }
  if (failedSrc === content) {
    return <p role="status">Could not display this image. The file may be damaged or unsupported.</p>;
  }
  return <img className="inbox-doc-image" src={content} alt={path} onError={() => setFailedSrc(content)} />;
}
