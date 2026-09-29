import { useEffect, useState } from 'react';
import type { LibraryDoc, FsReadDataUrlResult } from '@zana-ai/zcc-domain/product';
import { product } from '../../../lib/product-client.js';

/** Original-owner asset bytes work in browsers and native clients alike. */
export function LibraryAssetPreview({ doc }: { doc: LibraryDoc }) {
  const [result, setResult] = useState<FsReadDataUrlResult | null>(null);
  useEffect(() => {
    let cancelled = false;
    setResult(null);
    void product.library.readAsset(doc.scope ?? 'global', doc.relPath, doc.projectId).then(value => {
      if (!cancelled) setResult(value);
    }, () => { if (!cancelled) setResult({ ok: false, message: 'Library preview is unavailable. Reconnect and try again.' }); });
    return () => { cancelled = true; };
  }, [doc.scope, doc.relPath, doc.projectId]);
  if (!result) return <div className="explorer-viewer-empty" role="status">Loading document…</div>;
  if (!result.ok || !result.dataUrl) return <div className="explorer-viewer-empty" role="status">{result.message ?? 'Library preview is unavailable'}</div>;
  return doc.kind === 'pdf'
    ? <iframe src={result.dataUrl} title={doc.title} className="library-pdf-preview" />
    : <div className="library-image-preview"><img src={result.dataUrl} alt={doc.title} /></div>;
}
