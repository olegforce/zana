#!/usr/bin/env node
const { createInterface } = require('node:readline');

if (process.argv.includes('--version')) {
  console.log('2.1.284 (Claude Code)');
  process.exit(0);
}

// Model discovery uses the real Agent SDK initialization protocol. Keep the
// response larger than 32 KiB to exercise complete capture in built Electron.
const description = 'Discovered Claude model catalog fixture. '.repeat(250);
const models = [
  { value: 'default', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet 5' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet 5' },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku 4.5' },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5' },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Opus 5.5 (1M)' }
].map(model => ({ ...model, description, supportedEffortLevels: ['low', 'medium', 'high'] }));

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.type !== 'control_request') return;
  process.stdout.write(JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: message.request_id,
      response: message.request.subtype === 'initialize'
        ? { models, commands: [], agents: [] }
        : {}
    }
  }) + '\n');
});
