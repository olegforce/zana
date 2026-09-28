/**
 * Identity of a side-panel browser preview.
 *
 * A loopback server is one preview: `http://localhost:5173`, a trailing slash,
 * `127.0.0.1` on the same port, and a client route are the same view. Opening
 * it again focuses that tab and must not load the URL a second time, so a dev
 * server's hot reload keeps updating the page that is already open.
 *
 * Other sites stay distinct by document (origin, path, and query). A trailing
 * slash and a hash do not make a second tab.
 */

const DECIMAL_OCTET_PATTERN = /^\d+$/u;

function isIpv4Loopback(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts[0] !== '127') return false;
  return parts.every((part) => {
    if (!DECIMAL_OCTET_PATTERN.test(part)) return false;
    const octet = Number(part);
    return octet >= 0 && octet <= 255 && String(octet) === part;
  });
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, '').replace(/^\[|\]$/gu, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || isIpv4Loopback(host);
}

function parseHttpUrl(url: string): URL | null {
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed === 'about:blank') return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed;
}

function originKey(parsed: URL): string {
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  const host = isLoopbackHost(parsed.hostname)
    ? 'loopback'
    : parsed.hostname.toLowerCase().replace(/\.$/u, '');
  return `${parsed.protocol}//${host}:${port}`;
}

/** Same local server, or the same remote document. Empty and about:blank never match. */
export function browserPreviewIdentity(url: string): string | null {
  const parsed = parseHttpUrl(url);
  if (!parsed) return null;
  if (isLoopbackHost(parsed.hostname)) return originKey(parsed);
  const path = parsed.pathname.replace(/\/+$/u, '');
  return `${originKey(parsed)}${path}${parsed.search}`;
}

/**
 * Same loaded document. Used to skip a redundant navigation so hot reload is
 * not replaced by a full page load. Unlike {@link browserPreviewIdentity}, a
 * different path on a local server is a different document.
 */
export function sameBrowserDocument(current: string, next: string): boolean {
  const left = parseHttpUrl(current);
  const right = parseHttpUrl(next);
  if (!left || !right) return false;
  const path = (parsed: URL) => parsed.pathname.replace(/\/+$/u, '');
  return originKey(left) === originKey(right) && path(left) === path(right) && left.search === right.search;
}
