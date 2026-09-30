import { mkdirSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = dataDir => dataDir ? join(dataDir, 'preview-protected-ports') : join(tmpdir(), `zcc-preview-protected-${process.getuid?.() ?? 'user'}`);
const active = new Map();
export function protectPreviewPort(port, dataDir) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid protected port');
  const dir = directory(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${port}-${process.pid}`);
  writeFileSync(file, '', { mode: 0o600 });
  active.set(file, (active.get(file) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (active.get(file) ?? 1) - 1;
    if (remaining) { active.set(file, remaining); return; }
    active.delete(file);
    try { unlinkSync(file); } catch {}
  };
}
export function protectPreviewServer(server, dataDir) {
  let release = () => {};
  const register = () => {
    const address = server.address();
    if (address && typeof address !== 'string') release = protectPreviewPort(address.port, dataDir);
  };
  if (server.listening) register(); else server.once('listening', register);
  const close = () => release();
  server.once('close', close);
  return close;
}

export function isProtectedPreviewPort(port, dataDir) {
  if ([8780, 8781, 8785, 9222, 9229].includes(port)) return true;
  try {
    const dir = directory(dataDir);
    const files = readdirSync(dir);
    const overloaded = files.length > 256;
    for (const file of files.slice(0, 256)) {
      const match = /^(\d+)-(\d+)$/.exec(file);
      if (!match) continue;
      try { process.kill(Number(match[2]), 0); }
      catch (error) { if (error.code === 'ESRCH') { try { unlinkSync(join(dir, file)); } catch {} continue; } }
      if (Number(match[1]) === port) return true;
    }
    if (overloaded) return true;
  } catch (error) { if (error.code !== 'ENOENT') return true; }
  return false;
}
