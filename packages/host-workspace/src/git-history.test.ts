import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readCheckoutHistory, parseCheckoutHistory } from './git-history.js';

it('preserves complete large subjects and reads only a bounded canonical checkout history', async () => {
  const fixturePath = await mkdtemp(join(tmpdir(), 'history-test-'));
  const root = await realpath(fixturePath);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }, timeout: 5_000, stdio: 'pipe' });
  try {
    expect(await readCheckoutHistory(root, 50)).toEqual([]);
    git('init'); expect(await readCheckoutHistory(root, 50)).toEqual([]);
    await writeFile(join(root, 'file.txt'), 'one'); git('add', '.');
    const subject = 'Original-owner ' + 'x'.repeat(25_000) + ' complete';
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', subject);
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'Second');
    const rows = await readCheckoutHistory(root, 50);
    expect(rows.map(row => row.subject)).toEqual(['Second', subject]);
    expect(await readCheckoutHistory(root, 1)).toHaveLength(1);
    expect(await readCheckoutHistory(fixturePath, 1)).toEqual(rows.slice(0, 1));
    await mkdir(join(root, 'nested')); await expect(readCheckoutHistory(join(root, 'nested'), 50)).rejects.toThrow('outside');
    await symlink(root, join(root, 'linked')); await expect(readCheckoutHistory(join(root, 'linked'), 50)).rejects.toThrow('changed');
    for (const limit of [0, 101, 1.5, NaN]) await expect(readCheckoutHistory(root, limit)).rejects.toThrow('Invalid');
    await expect(readCheckoutHistory('relative', 1)).rejects.toThrow('Invalid');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects malformed history records and preserves field delimiters in the subject', () => {
  const hash = 'a'.repeat(40);
  const row = `${hash}\x1faaaaaaa\x1fAuthor\x1f1700000000\x1fOne\x1fTwo\0`;
  expect(parseCheckoutHistory(`bad\0${hash}\x1faaa\x1fAuthor\x1fnot-time\x1fsubject\0${row}`)).toEqual([
    { hash, shortHash: 'aaaaaaa', author: 'Author', ts: 1700000000000, subject: 'One\x1fTwo' },
  ]);
  expect(parseCheckoutHistory('')).toEqual([]);
});
