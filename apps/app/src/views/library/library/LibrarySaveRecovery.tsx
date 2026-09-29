import { useEffect, useRef, useState } from 'react';
import type { LibraryDoc } from '@zana-ai/zcc-domain/product';
import { product } from '../../../lib/product-client.js';

export function LibrarySaveRecovery({ doc, message, draft, saving, onSaveMerged, onUseLatest }: {
  doc: LibraryDoc; message: string; draft: string; saving: boolean;
  onSaveMerged(revision: string): Promise<void>;
  onUseLatest(content: string, revision: string): void;
}) {
  const [latest, setLatest] = useState<{ content: string; revision: string }>();
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    generation.current++; setLatest(undefined); setNotice(''); setLoading(false);
    return () => { generation.current++; };
  }, [doc.id, doc.scope, doc.projectId, doc.relPath, message]);
  async function review() {
    const epoch = ++generation.current; setLoading(true); setLatest(undefined); setNotice('');
    try {
      const result = await product.library.read(doc.scope ?? 'global', doc.relPath, doc.projectId);
      if (epoch !== generation.current) return;
      if (!result.ok || result.content === undefined || !result.sha256) throw new Error(result.message ?? 'The latest version is unavailable. Your draft is still here.');
      setLatest({ content: result.content, revision: result.sha256 });
    } catch (error) { if (epoch === generation.current) setNotice(error instanceof Error ? error.message : String(error)); }
    finally { if (epoch === generation.current) setLoading(false); }
  }
  async function copy() {
    const epoch = generation.current;
    try { await navigator.clipboard.writeText(draft); if (epoch === generation.current) setNotice('Draft copied.'); }
    catch { if (epoch === generation.current) setNotice('Could not copy. You can still select and copy your draft in the editor.'); }
  }
  return <section className="library-save-recovery" aria-label="Recover unsaved changes" data-testid="library-save-recovery">
    <p role="alert">{message} Your draft has been kept.</p>
    <div className="library-save-recovery-actions">
      <button type="button" className="library-edit-btn" disabled={saving || loading} onClick={() => void review()}>{loading ? 'Reading latest…' : 'Review latest version'}</button>
      <button type="button" className="library-edit-btn" onClick={() => void copy()}>Copy draft</button>
    </div>
    {notice && <p role="status">{notice}</p>}
    {latest && <>
      <p>Latest saved version</p>
      <pre tabIndex={0} aria-label="Latest saved version">{latest.content}</pre>
      <p>Merge the changes you want to keep into your draft below, then save. If the file changes again, saving will stop for another review.</p>
      <div className="library-save-recovery-actions">
        <button type="button" className="library-edit-btn primary" disabled={saving} onClick={() => void onSaveMerged(latest.revision)}>Save merged draft</button>
        <button type="button" className="library-edit-btn" disabled={saving} onClick={() => onUseLatest(latest.content, latest.revision)}>Discard draft and use latest</button>
      </div>
    </>}
  </section>;
}
