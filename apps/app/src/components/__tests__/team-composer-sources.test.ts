import { describe, expect, it } from 'vitest';
import { applyRenewedSources } from '../team-composer-sources.js';

const chip = (id: string, name = `${id}.md`) => ({ id, name, byteSize: 1, expiresAt: 1 });

describe('applyRenewedSources', () => {
  it('replaces renewed chips in place and keeps untouched ones', () => {
    const out = applyRenewedSources([chip('a'), chip('b'), chip('c')], {
      renewed: [{ previousId: 'b', source: chip('b2', 'b.md'), changed: false }], dropped: []
    });
    expect(out.sources.map(({ id }) => id)).toEqual(['a', 'b2', 'c']);
    expect(out.notices).toEqual([]);
  });

  it.each([
    ['moved', "Attach x.md again; it moved or can't be read."],
    ['unreadable', "Attach x.md again; it moved or can't be read."],
    ['too-large', 'x.md is now too large. Attach a smaller file.'],
    ['unknown', 'Attach x.md again; it is no longer available.']
  ] as const)('drops a named %s entry', (reason, notice) => {
    const out = applyRenewedSources([chip('a'), chip('b')], { renewed: [], dropped: [{ previousId: 'a', name: 'x.md', reason }] });
    expect(out.sources.map(({ id }) => id)).toEqual(['b']);
    expect(out.notices).toEqual([notice]);
  });

  it('uses the chip name when the dropped entry has none', () => {
    expect(applyRenewedSources([chip('a', 'chip.md')], { renewed: [], dropped: [{ previousId: 'a', reason: 'unknown' }] }).notices)
      .toEqual(['Attach chip.md again; it is no longer available.']);
  });

  it('has a generic notice when no name is known', () => {
    expect(applyRenewedSources([], { renewed: [], dropped: [{ previousId: 'a', reason: 'unknown' }] }).notices)
      .toEqual(['Attach a source again; it is no longer available.']);
    expect(applyRenewedSources([], { renewed: [], dropped: [{ previousId: 'a', reason: 'too-large' }] }).notices)
      .toEqual(['A source is now too large. Attach a smaller file.']);
  });

  it('notes a changed file', () => {
    const out = applyRenewedSources([chip('a')], { renewed: [{ previousId: 'a', source: chip('a2', 'a.md'), changed: true }], dropped: [] });
    expect(out.notices).toEqual(['a.md changed since you attached it. Launching again uses the current version.']);
  });

  it('ignores ids that are no longer present', () => {
    const out = applyRenewedSources([chip('a')], { renewed: [{ previousId: 'gone', source: chip('g2'), changed: false }], dropped: [{ previousId: 'gone2', name: 'q', reason: 'moved' }] });
    expect(out.sources.map(({ id }) => id)).toEqual(['a']);
  });
});
