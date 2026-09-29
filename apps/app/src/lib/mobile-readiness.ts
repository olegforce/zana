/** Send only from a mounted native shell, using its existing HttpOnly session.
 * No pairing codes or credentials enter this payload. Older gateways may 404. */
export function reportMobileReadiness(platform: 'ios' | 'android', appVersion: string): () => void {
  const instanceId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  let pending = false;
  let controller: AbortController | null = null;
  const report = async () => {
    if (pending || document.visibilityState === 'hidden') return;
    pending = true;
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 5000);
    try {
      await fetch('/_zcc/mobile-ready', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instanceId, platform, appVersion }), signal: controller.signal });
    } catch { /* Optional desktop setup feedback must never interrupt the phone. */ }
    finally { clearTimeout(timeout); pending = false; }
  };
  void report();
  const timer = setInterval(() => void report(), 10_000);
  return () => { clearInterval(timer); controller?.abort(); };
}
