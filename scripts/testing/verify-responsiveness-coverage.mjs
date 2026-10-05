import { spawn } from 'node:child_process';

const modules = [
  'apps/app/src/components/LargeTextPreview.tsx',
  'apps/app/src/components/DiffViewerInner.tsx',
  'apps/app/src/components/markdown-code-highlight.ts',
  'apps/app/src/components/execution-event-tail.ts',
  'apps/app/src/components/search-hit-highlight.tsx',
  'apps/app/src/lib/highlightCode.ts',
  'apps/app/src/lib/serial-poll.ts',
  'apps/desktop/src/extensions/storage-proxy.ts',
  'apps/server/src/plugins/isolated-plugin-runtime.ts',
  'apps/server/src/plugins/plugin-database-migrations.ts',
  'apps/server/src/plugins/plugin-file-scan.ts',
  'apps/server/src/plugins/plugin-worker-bridge.ts',
  'apps/server/src/plugins/plugin-server-worker.ts',
  'apps/server/src/services/projects/async-fs.ts',
  'apps/server/src/services/storage/async-json-store.ts',
  'apps/server/src/services/threads/history-query-worker.ts',
  'apps/server/src/services/threads/thread-reads.ts',
  'packages/db/src/contention.ts',
  'packages/plugin-sdk/src/plugin-services.ts'
];
const tests = [
  'apps/app/src/components/LargeTextPreview.test.tsx',
  'apps/app/src/components/markdown-code-highlight.test.ts',
  'apps/app/src/components/execution-event-tail.test.ts',
  'apps/app/src/components/search-hit-highlight.test.tsx',
  'apps/app/src/components/SearchPanel.requests.test.tsx',
  'apps/app/src/lib/__tests__/highlightCode.test.ts',
  'apps/app/src/lib/serial-poll.test.ts',
  'apps/desktop/src/extensions/__tests__/storage-proxy.test.ts',
  'apps/server/src/plugins/isolated-plugin-runtime.test.ts',
  'apps/server/src/plugins/plugin-api.test.ts',
  'apps/server/src/plugins/plugin-service.test.ts',
  'apps/server/src/plugins/plugin-worker-bridge.test.ts',
  'apps/server/src/plugins/plugin-server-worker.test.ts',
  'apps/server/src/services/projects/__tests__/fs-scan.test.ts',
  'apps/server/src/services/projects/async-fs.test.ts',
  'apps/server/src/services/storage/async-json-store.test.ts',
  'apps/server/src/services/threads/history-query-worker.test.ts',
  'apps/server/src/services/threads/history-query-worker.failure.test.ts',
  'apps/server/src/services/threads/conversation-history.test.ts',
  'apps/server/src/services/threads/thread-reads.test.ts',
  'packages/db/src/contention.test.ts',
  'packages/plugin-sdk/src/plugin-services.test.ts'
];
const args = ['exec', 'vitest', 'run', '--maxWorkers=2', ...tests,
  '--coverage', '--coverage.reporter=text', '--coverage.reporter=json',
  '--coverage.thresholds.perFile=true', '--coverage.thresholds.statements=80',
  '--coverage.thresholds.branches=80', '--coverage.thresholds.functions=80',
  '--coverage.thresholds.lines=80',
  '--coverage.reportsDirectory=output/app-freeze-fixes/coverage',
  ...modules.map(file => `--coverage.include=${file}`)];
const child = spawn('pnpm', args, { stdio: 'inherit' });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
