import { createRelay } from './mobile/server.mjs';
import { remoteOrigin } from './mobile/protocol.mjs';

/** Pairing authenticates in the mobile gateway; cookies here select a route only. */
export function createMobileRouting(env) {
  const token = env.MOBILE_RELAY_TOKEN;
  const publicUrl = env.MOBILE_RELAY_PUBLIC_URL;
  if (!token && !publicUrl) return null;
  if (!token || !publicUrl) throw new Error('Set both MOBILE_RELAY_TOKEN and MOBILE_RELAY_PUBLIC_URL');
  const origin = remoteOrigin(publicUrl);
  const relay = createRelay({ token, publicUrl });
  return {
    ...relay,
    matches(request) {
      if (request.headers.host !== origin.host) return false;
      const path = (request.url ?? '/').split('?')[0];
      return /^\/(?:_mobile|_relay|api\/v1|ws)(?:\/|$)/.test(path) ||
        /(?:^|;\s*)zcc_mobile_session=/.test(request.headers.cookie ?? '');
    }
  };
}
