// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { LIBRARY_IMPORT_MAX_BYTES } from '@zana-ai/zcc-contracts/library-documents';
import { readLibraryImportFile } from './library-import.js';
afterEach(() => vi.unstubAllGlobals());
it('preserves binary bytes and empty files in the browser file reader', async () => {
  const signal = new AbortController().signal;
  expect(await readLibraryImportFile(new File([new Uint8Array([0, 255, 128])], 'a.bin'), signal)).toBe('AP+A');
  expect(await readLibraryImportFile(new File([], 'empty.pdf'), signal)).toBe('');
});
it('rejects an oversized or already cancelled selection before reading it', async () => {
  const reader = vi.fn(); vi.stubGlobal('FileReader', reader);
  const controller = new AbortController();
  await expect(readLibraryImportFile({ size: LIBRARY_IMPORT_MAX_BYTES + 1 } as File, controller.signal)).rejects.toThrow('10 MB');
  controller.abort();
  await expect(readLibraryImportFile(new File([], 'a'), controller.signal)).rejects.toThrow('cancelled');
  expect(reader).not.toHaveBeenCalled();
});
it.each(['load-null', 'load-text', 'error', 'abort', 'throw'])('rejects %s and releases the cancellation listener', async mode => {
  let instance: any;
  vi.stubGlobal('FileReader', class {
    result: unknown = null;
    onload?: () => void; onerror?: () => void; onabort?: () => void;
    constructor() { instance = this; }
    abort() { this.onabort?.(); }
    readAsDataURL() { if (mode === 'throw') throw new Error('reader failure'); }
  });
  const controller = new AbortController(), removed = vi.spyOn(controller.signal, 'removeEventListener');
  const pending = readLibraryImportFile(new File([], 'a'), controller.signal);
  const assertion = expect(pending).rejects.toThrow(/read|cancelled/);
  if (mode === 'load-null' || mode === 'load-text') { instance.result = mode === 'load-null' ? null : 'data:text/plain,hello'; instance.onload(); }
  else if (mode === 'error') instance.onerror();
  else if (mode === 'abort') controller.abort();
  await assertion;
  expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
});
