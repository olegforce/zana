import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Keep in lockstep with packages/agent-runtime/src/shared/bridge-path.ts */
export const PACKED_BRIDGE_WORKER_FILE = 'zcc-provider-bridge-worker.mjs';

// Recognize older installed bundles while new builds emit the canonical name.
function hasBridgeWorker(dir: string): boolean {
  return existsSync(join(dir, PACKED_BRIDGE_WORKER_FILE)) || existsSync(join(dir, 'bb-provider-bridge-worker.mjs'));
}

/**
 * Directory that holds the packed join artifact's provider-bridge files.
 * Present next to `join.mjs` on a remote; in the Mac app they are copied to
 * `process.resourcesPath/host-bridge` so the daemon does not spawn `tsx`
 * against TypeScript inside `app.asar`.
 */
export function packedBridgeBundleDir(fromUrl: string = import.meta.url): string | undefined {
  const dir = dirname(fileURLToPath(fromUrl));
  if (hasBridgeWorker(dir)) return dir;
  const resources =
    typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0
      ? process.resourcesPath
      : null;
  if (resources) {
    const bundled = join(resources, 'host-bridge');
    if (hasBridgeWorker(bundled)) return bundled;
  }
  const checkoutDist = join(process.cwd(), 'apps', 'host-daemon', 'dist');
  if (hasBridgeWorker(checkoutDist)) return checkoutDist;
  return undefined;
}
