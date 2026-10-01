import { Link, useInRouterContext } from 'react-router-dom';
import { isLoopbackHostname } from '../../../lib/loopback-hostname.js';

export function localPreviewPort(value: string): number | null {
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return url.protocol === 'http:' && isLoopbackHostname(url.hostname) && Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
  } catch { return null; }
}

/** Settings makes the machine and the explicit share action visible together. */
export function SharePreviewLink({ url }: { url: string }) {
  const routed = useInRouterContext();
  const port = localPreviewPort(url);
  if (!routed || port === null) return null;
  return <div className="thread-browser-share"><Link className="btn" to={`/settings/remote-access?previewPort=${port}`}>Share on phone…</Link></div>;
}
