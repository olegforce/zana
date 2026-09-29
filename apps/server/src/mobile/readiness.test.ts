import { expect, it } from 'vitest';
import { MobileReadiness } from './readiness.js';
import { mobileDistribution } from './distribution.js';
const input = { instanceId: 'a'.repeat(32), platform: 'ios', appVersion: '2.3.0' };
it('accepts only an exact Apple invitation and never returns arbitrary configuration', () => {
  expect(mobileDistribution({})).toEqual({ testFlightUrl: null });
  expect(mobileDistribution({ ZANA_MOBILE_TESTFLIGHT_URL: 'https://testflight.apple.com/join/Abcd1234' }).testFlightUrl).toContain('Abcd1234');
  for (const value of ['http://testflight.apple.com/join/Abcd1234', 'https://testflight.apple.com.evil/join/Abcd1234', 'javascript:alert(1)', 'https://testflight.apple.com/join/Abcd1234?token=secret'])
    expect(mobileDistribution({ ZANA_MOBILE_TESTFLIGHT_URL: value }).testFlightUrl).toBeNull();
});
it('requires a valid app report and expires or revokes current evidence', () => {
  let now = 100;
  const state = new MobileReadiness(() => now);
  for (const patch of [{ instanceId: 'bad' }, { platform: 'desktop' }, { appVersion: 'secret https://test' }])
    expect(state.record('one', 'Phone', { ...input, ...patch })).toBe(false);
  expect(state.list(() => true)).toEqual([]);
  expect(state.record('one', 'Phone', input)).toBe(true);
  expect(state.list(() => true)).toEqual([{ id: `one:${input.instanceId}`, label: 'Phone', platform: 'ios', appVersion: '2.3.0', lastSeenAt: 100 }]);
  now += 29_999; expect(state.list(() => true)).toHaveLength(1);
  now++; expect(state.list(() => true)).toHaveLength(0);
  state.record('one', 'Phone', input);
  expect(state.list(() => false)).toHaveLength(0);
});
it('bounds reports, allows refresh at capacity and reclaims expired slots', () => {
  let now = 0;
  const state = new MobileReadiness(() => now);
  for (let n = 0; n < 40; n++) expect(state.record(`${n}`, 'Phone', input)).toBe(true);
  expect(state.record('extra', 'Phone', input)).toBe(false);
  expect(state.record('0', 'Phone', input)).toBe(true);
  now = 30_000;
  expect(state.record('extra', 'Phone', input)).toBe(true);
  expect(state.list(() => true)).toHaveLength(1);
});
