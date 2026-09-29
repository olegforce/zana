import { useEffect, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { product } from '../../../lib/product-client.js';
import { useUi } from '@/store';
import { readLibraryImportFile } from './library-import.js';

export function LibraryImportButton({ projectId }: { projectId?: string }) {
  const input = useRef<HTMLInputElement>(null), active = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const pushToast = useUi(state => state.pushToast);
  const target = projectId ? 'project Library' : 'Global Library';
  useEffect(() => () => { active.current?.abort(); }, []);
  async function importFile(file?: File) {
    if (!file || active.current) return;
    const controller = new AbortController(); active.current = controller; setBusy(true);
    try {
      const base64 = await readLibraryImportFile(file, controller.signal);
      if (controller.signal.aborted) return;
      await product.library.importFile({ scope: projectId ? 'project' : 'global', projectId, relPath: file.name, base64 });
      if (!controller.signal.aborted) pushToast(`Imported ${file.name}`);
    } catch (error) {
      if (!controller.signal.aborted) pushToast(error instanceof Error ? error.message : 'File import failed', 'error');
    } finally {
      if (active.current === controller) active.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return <>
    <input ref={input} type="file" hidden disabled={busy} aria-label={`Import file into ${target}`} onChange={event => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void importFile(file);
    }} />
    <button type="button" className="opener-btn" disabled={busy} title={`Import file into ${target} (up to 10 MB)`} aria-label={`Import file into ${target}`} onClick={() => input.current?.click()}>
      <Upload size={13} aria-hidden="true" /><span>{busy ? 'Importing…' : 'Import'}</span>
    </button>
  </>;
}
