import { afterEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { resolveSourcePolicy, sourcePathRefusal } from '@zana-ai/zcc-server/services/execution/source-policy';
import { sensitiveRoots } from '../extensions/permission-broker.js';

afterEach(() => { vi.unstubAllEnvs(); });

describe('source policy and permission broker', () => {
  it('refuses, as a Squad source, every root the broker never lets a plugin write', async () => {
    vi.stubEnv('ZCC_DATA_DIR', '');
    const policy = await resolveSourcePolicy(realpath, { home: homedir() });
    for (const root of sensitiveRoots()) {
      expect(sourcePathRefusal(join(root, 'secret-file'), policy), root).toBe('sensitive');
    }
  });
});
