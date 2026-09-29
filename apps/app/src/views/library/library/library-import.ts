import { LIBRARY_IMPORT_MAX_BYTES } from '@zana-ai/zcc-contracts/library-documents';

export function readLibraryImportFile(file: File, signal: AbortSignal): Promise<string> {
  if (file.size > LIBRARY_IMPORT_MAX_BYTES) return Promise.reject(new Error('Choose a file smaller than 10 MB.'));
  if (signal.aborted) return Promise.reject(new Error('Import cancelled'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => reader.abort();
    const finish = () => signal.removeEventListener('abort', abort);
    reader.onload = () => {
      finish();
      const value = reader.result;
      if (typeof value !== 'string' || !value.slice(0, value.indexOf(',')).endsWith(';base64')) reject(new Error('Could not read the selected file'));
      else resolve(value.slice(value.indexOf(',') + 1));
    };
    reader.onerror = () => { finish(); reject(new Error('Could not read the selected file')); };
    reader.onabort = () => { finish(); reject(new Error('Import cancelled')); };
    signal.addEventListener('abort', abort, { once: true });
    try { reader.readAsDataURL(file); }
    catch (error) { finish(); reject(error); }
  });
}
