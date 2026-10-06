import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_NOTES_CHARS, checkReleaseNotes } from './check-release-notes.mjs';
import { MAX_UPDATE_NOTE_CHARS } from '../apps/desktop/src/update-release-notes.js';

const GOOD = '# What’s new in 1.2.3\n\n**Headline.** A sentence long enough to count as real release notes for this version.\n\n- Item with `<tag>` and `a | b` in code.';

describe('checkReleaseNotes', () => {
  it('accepts notes in the supported markdown subset', () => {
    expect(checkReleaseNotes({ version: '1.2.3', body: GOOD })).toEqual([]);
    expect(checkReleaseNotes({ version: '1.2.3', body: GOOD + '\n\n```\n<div>| x |</div>\n```', tag: 'v1.2.3' })).toEqual([]);
  });

  it('fails a missing or stub file', () => {
    expect(checkReleaseNotes({ version: '1.2.3', body: null })[0]).toMatch(/missing docs\/releases\/1\.2\.3\.md/);
    expect(checkReleaseNotes({ version: '1.2.3', body: '# 1.2.3' })[0]).toMatch(/too short/);
  });

  it('fails notes the update banner preview would truncate or drop', () => {
    expect(checkReleaseNotes({ version: '1.2.3', body: GOOD + 'x'.repeat(MAX_NOTES_CHARS) }).join()).toMatch(/truncates/);
    expect(checkReleaseNotes({ version: '1.2.3', body: GOOD + '\n\n![shot](https://x.test/a.png)' }).join()).toMatch(/an image/);
    expect(checkReleaseNotes({ version: '1.2.3', body: GOOD + '\n\n| a | b |\n|---|---|' }).join()).toMatch(/a table/);
    expect(checkReleaseNotes({ version: '1.2.3', body: GOOD + '\n\n<details>more</details>' }).join()).toMatch(/raw HTML \(near line 7\)/);
  });

  it('fails a release tag that does not match package.json, ignoring branch refs', () => {
    expect(checkReleaseNotes({ version: '1.2.3', body: GOOD, tag: 'v1.2.4' })[0]).toMatch(/does not match/);
    expect(checkReleaseNotes({ version: '1.2.3', body: GOOD, tag: 'main' })).toEqual([]);
    expect(checkReleaseNotes({ version: '1.2.3', body: GOOD, tag: 'version/2.1.1' })).toEqual([]);
  });

  it('keeps the size cap in lockstep with the app’s preview cap', () => {
    expect(MAX_NOTES_CHARS).toBe(MAX_UPDATE_NOTE_CHARS);
  });

  it('passes every shipped release note', () => {
    const dir = new URL('../docs/releases/', import.meta.url);
    for (const name of readdirSync(dir).filter((n) => /^\d+\.\d+\.\d+\.md$/.test(n))) {
      const version = name.replace(/\.md$/, '');
      expect(checkReleaseNotes({ version, body: readFileSync(new URL(name, dir), 'utf8') }), name).toEqual([]);
    }
  });
});
