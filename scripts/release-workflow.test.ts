import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const { load } = createRequire(import.meta.url)('js-yaml');
const workflow = load(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
const builder = load(readFileSync(new URL('../apps/desktop/electron-builder.yml', import.meta.url), 'utf8'));

describe('Windows release pipeline', () => {
  it('gates draft publication on both Mac and Windows builds', () => {
    expect(workflow.jobs.release.needs).toEqual(['build', 'build-windows']);
    expect(workflow.jobs.release.if).toBe("startsWith(github.ref, 'refs/tags/v')");
    const publish = workflow.jobs.release.steps.find((step: any) => step.uses?.startsWith('softprops/action-gh-release@'));
    expect(publish.with.draft).toBe(true);
    for (const asset of ['merged/*.exe', 'merged/*.blockmap', 'merged/latest.yml', 'merged/latest-mac.yml']) {
      expect(publish.with.files.split('\n')).toContain(asset);
    }
    expect(workflow.jobs.release.steps.find((step: any) => step.id === 'meta').run)
      .toContain('artifacts/release-windows-x64/latest.yml');
  });

  it('builds natively and tests the actual Windows package before uploading', () => {
    const windows = workflow.jobs['build-windows'];
    expect(windows['runs-on']).toBe('windows-2025');
    expect(windows.needs).toEqual(['verify', 'smoke']);
    const steps = windows.steps;
    const index = (name: string) => steps.findIndex((step: any) => step.name === name);
    expect(index('Stage Windows OpenCode binary')).toBeLessThan(index('Build app'));
    expect(index('Build app')).toBeLessThan(index('Package Windows installer'));
    expect(index('Package Windows installer')).toBeLessThan(index('Smoke test packaged Windows app'));
    expect(index('Smoke test packaged Windows app')).toBeLessThan(index('Upload Windows artifacts'));
    const smoke = steps[index('Smoke test packaged Windows app')];
    expect(smoke.run).toBe('pnpm run test:smoke:only');
    expect(smoke.env.ZCC_E2E_EXECUTABLE_PATH).toBe('${{ github.workspace }}\\dist\\win-unpacked\\Zana.exe');
    expect(smoke['continue-on-error']).toBeUndefined();
    const pack = steps[index('Package Windows installer')];
    expect(pack.run).toContain('electron-builder --win --x64 --publish never');
    expect(pack.run).toContain('if ($env:WIN_CSC_LINK_SECRET)');
    expect(Object.keys(pack.env)).toEqual(['WIN_CSC_LINK_SECRET', 'WIN_CSC_KEY_PASSWORD_SECRET']);
    const upload = steps[index('Upload Windows artifacts')];
    expect(upload.with.name).toBe('release-windows-x64');
    expect(upload.with.path.split('\n')).toEqual(expect.arrayContaining(['dist/*.exe', 'dist/*.blockmap', 'dist/latest.yml']));
  });

  it('keeps the Unix supervisor out of Windows and uses stable installer names', () => {
    const supervisor = { from: 'resources/scheduled-supervisor', to: 'scheduled-supervisor' };
    expect(builder.extraResources).not.toContainEqual(supervisor);
    expect(builder.mac.extraResources).toContainEqual(supervisor);
    expect(builder.linux.extraResources).toContainEqual(supervisor);
    expect(builder.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }]);
    expect(builder.win.artifactName).toBe('Zana-Command-Center-${version}-win-${arch}-Setup.${ext}');
    expect(builder.publish).toMatchObject({ provider: 'github', owner: 'salesforce', repo: 'zana' });
  });
});
