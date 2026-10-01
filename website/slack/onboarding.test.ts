import { expect, it } from 'vitest';
import { domainLabel } from './onboarding.mjs';

it.each(['my-domain', 'MY-DOMAIN', 'my-domain.zana-ide.com', 'https://my-domain.zana-ide.com/', ' https://MY-DOMAIN.zana-ide.com '])('accepts a claimed-domain selector: %s', input => {
  expect(domainLabel(input, 'zana-ide.com')).toBe('my-domain');
});
it('keeps domain selection optional and uses the configured browser domain', () => {
  expect(domainLabel(undefined, 'zana-ide.com')).toBeNull();
  expect(domainLabel('alice.custom.example', 'custom.example')).toBe('alice');
});
it.each(['', ' ', null, 5, 'a'.repeat(254), 'www', 's-deadbeef', 'a--b', 'ab', 'my.domain.zana-ide.com', 'evil.example', 'https://my-domain.zana-ide.com.evil.example', 'https://evil.example/my-domain.zana-ide.com', 'http://my-domain.zana-ide.com', 'https://me@my-domain.zana-ide.com', 'https://me:secret@my-domain.zana-ide.com', 'https://my-domain.zana-ide.com:8443', 'https://my-domain.zana-ide.com/path', 'https://my-domain.zana-ide.com/?code=secret', 'https://my-domain.zana-ide.com/#fragment', 'https://my-domain.zana-ide.com\\evil', 'https://%6dy-domain.zana-ide.com', 'my-domain. zana-ide.com', 'https://[bad'])('rejects arbitrary URLs and malformed domains: %s', input => {
  expect(() => domainLabel(input, 'zana-ide.com')).toThrow('invalid_domain');
});
