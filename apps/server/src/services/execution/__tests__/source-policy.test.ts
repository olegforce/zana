import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  READABLE_DATA_DIRS,
  SENSITIVE_HOME_PATHS,
  SOURCE_POLICY_TEXT,
  displaySourcePath,
  isSensitiveSourcePath,
  resolveSourcePolicy,
  sourcePathRefusal
} from '../source-policy.js';

const home = '/Users/me';
const policy = { roots: ['/work/proj', home, '/clones'], home };

describe('sourcePathRefusal', () => {
  it.each([
    ['a project file', '/work/proj/docs/plan.md'],
    ['a HOME file outside the project', '/Users/me/vault/design.md'],
    ['a clone root file', '/clones/other/plan.md'],
    ['Zana\'s library', '/Users/me/.zcc/library/designs/x.md'],
    ['Zana\'s personas', '/Users/me/.zcc/personas/p.json']
  ])('allows %s', (_name, path) => {
    expect(sourcePathRefusal(path, policy)).toBeUndefined();
  });

  it.each([
    ['/etc/hosts'],
    ['/work/other/plan.md'],
    ['/work/proj'],
    ['/Users/me']
  ])('refuses %s as outside every base', (path) => {
    expect(sourcePathRefusal(path, policy)).toBe('outside');
  });

  it.each([
    ['/Users/me/.ssh/id_rsa'],
    ['/Users/me/.aws/credentials'],
    ['/Users/me/.gnupg/secring.gpg'],
    ['/Users/me/.config/gh/hosts.yml'],
    ['/Users/me/.netrc'],
    ['/Users/me/.docker/config.json'],
    ['/Users/me/.zcc/auth.json'],
    ['/Users/me/.zcc/runtime.sqlite'],
    ['/Users/me/.zcc/plugins/salesforce/settings.json'],
    ['/Users/me/.zcc/mcp/servers.json'],
    ['/Users/me/.zcc/inbox/entries.json'],
    ['/Users/me/.zcc/a-state-folder-added-later/x.json'],
    ['/Users/me/.zcc-dev/host-enroll.token'],
    ['/Users/me/.zcc-machines/m1/auth.json'],
    ['/Users/me/.codex/auth.json'],
    ['/Users/me/.claude/sessions/s.jsonl']
  ])('refuses %s as protected', (path) => {
    expect(sourcePathRefusal(path, policy)).toBe('sensitive');
  });

  it('protects a credential store even when the project sits in HOME', () => {
    expect(sourcePathRefusal('/Users/me/.ssh/config', { roots: [home], home })).toBe('sensitive');
  });

  it('protects every Zana data folder it is given, plus ~/.zcc', () => {
    const dev = { home, dataDirs: ['/Users/me/.zcc', '/Users/me/.zcc-dev'] };
    expect(isSensitiveSourcePath('/Users/me/.zcc-dev/host-enroll.token', dev)).toBe(true);
    expect(isSensitiveSourcePath('/Users/me/.zcc/control.token', dev)).toBe(true);
    expect(isSensitiveSourcePath('/Users/me/.zcc-dev/library/a.md', dev)).toBe(false);
  });

  it('protects extra roots it is given, such as the app\'s own data', () => {
    const appData = '/Users/me/Library/Application Support/Zana';
    expect(sourcePathRefusal(`${appData}/Partitions/zcc-browser/Cookies`, { ...policy, protectedRoots: [appData] })).toBe('sensitive');
  });

  it('names the protected locations and the readable folders for the agent', () => {
    for (const path of SENSITIVE_HOME_PATHS) expect(SOURCE_POLICY_TEXT).toContain(`~/${path}`);
    for (const name of READABLE_DATA_DIRS) expect(SOURCE_POLICY_TEXT).toContain(name);
  });
});

describe('resolveSourcePolicy', () => {
  it('realpaths the bases and drops the ones that do not resolve', async () => {
    const realHome = realpathSync(mkdtempSync(join(tmpdir(), 'zcc-policy-home-')));
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'zcc-policy-project-')));
    const resolved = await resolveSourcePolicy(realpath, {
      projectRoot: project, home: realHome, cloneRoot: join(realHome, 'missing'), dataDirs: [join(realHome, '.zcc-dev'), join(realHome, 'gone')]
    });
    expect(resolved.roots).toEqual([project, realHome]);
    expect(resolved.home).toBe(realHome);
    expect(resolved.dataDirs).toEqual([join(realHome, '.zcc'), join(realHome, '.zcc-dev'), join(realHome, '.zcc-machines'), join(realHome, 'gone')]);
  });

  it('falls back to HOME as given, and ignores a blank clone root', async () => {
    const resolved = await resolveSourcePolicy(realpath, { home: '/no/such/home', cloneRoot: '  ' });
    expect(resolved.roots).toEqual(['/no/such/home']);
  });

  it('keeps a symlinked credential store refused (a dotfiles setup)', async () => {
    const realHome = realpathSync(mkdtempSync(join(tmpdir(), 'zcc-policy-home-')));
    mkdirSync(join(realHome, 'dotfiles', 'ssh'), { recursive: true });
    writeFileSync(join(realHome, 'dotfiles', 'ssh', 'id_ed25519'), 'PRIVATE');
    symlinkSync(join(realHome, 'dotfiles', 'ssh'), join(realHome, '.ssh'));
    const resolved = await resolveSourcePolicy(realpath, { home: realHome });
    const real = await realpath(join(realHome, '.ssh', 'id_ed25519'));
    expect(real).toBe(join(realHome, 'dotfiles', 'ssh', 'id_ed25519'));
    expect(sourcePathRefusal(real, resolved)).toBe('sensitive');
  });

  it('drops a clone root that is a filesystem root or contains HOME', async () => {
    const realHome = realpathSync(mkdtempSync(join(tmpdir(), 'zcc-policy-home-')));
    const clones = realpathSync(mkdtempSync(join(tmpdir(), 'zcc-policy-clones-')));
    expect((await resolveSourcePolicy(realpath, { home: realHome, cloneRoot: '/' })).roots).toEqual([realHome]);
    expect((await resolveSourcePolicy(realpath, { home: realHome, cloneRoot: join(realHome, '..') })).roots).toEqual([realHome]);
    expect((await resolveSourcePolicy(realpath, { home: realHome, cloneRoot: clones })).roots).toEqual([realHome, clones]);
  });
});

describe('displaySourcePath', () => {
  it('abbreviates HOME and leaves other paths whole', () => {
    expect(displaySourcePath('/Users/me/vault/design.md', home)).toBe('~/vault/design.md');
    expect(displaySourcePath('/clones/x/plan.md', home)).toBe('/clones/x/plan.md');
  });
});
