// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { highlightSearchHit } from './search-hit-highlight.js';
afterEach(cleanup);
describe('search hit highlighting', () => {
  it('uses worker offsets even when previews contain regex syntax', () => {
    const { container } = render(<div>{highlightSearchHit({ preview: 'prefix (a+)+$ suffix', column: 8, match: '(a+)+$' })}</div>);
    expect(container.querySelector('mark')?.textContent).toBe('(a+)+$');
    expect(container.textContent).toBe('prefix (a+)+$ suffix');
  });
  it.each([-1, 0, NaN, 1.5, 100])('ignores invalid/outside column %s', column => {
    expect(highlightSearchHit({ preview: 'text', column, match: 'x' })).toBe('text');
  });
  it('bounds a match to the truncated preview and escapes markup', () => {
    const { container } = render(<div>{highlightSearchHit({ preview: '<script', column: 1, match: '<script>full match' })}</div>);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('mark')?.textContent).toBe('<script');
  });
  it('leaves zero-length matches plain', () => {
    expect(highlightSearchHit({ preview: 'aaaa!', column: 1, match: '' })).toBe('aaaa!');
  });
});
