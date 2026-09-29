/** Set only after the Zana beta group has an approved, installable build. */
const RELEASE_TESTFLIGHT_URL: string | null = null;

export function mobileDistribution(env = process.env) {
  const candidate = env.ZANA_MOBILE_TESTFLIGHT_URL ?? RELEASE_TESTFLIGHT_URL;
  // This is an installation invitation, never a pairing URL or arbitrary website.
  const testFlightUrl = typeof candidate === 'string' &&
    /^https:\/\/testflight\.apple\.com\/join\/[A-Za-z0-9]{8}$/.test(candidate)
    ? candidate : null;
  return { testFlightUrl };
}
