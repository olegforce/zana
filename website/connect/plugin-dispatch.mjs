import { Readable, Writable } from 'node:stream';

/** Server-side only. No public proxy endpoint and no phone session is minted. */
export function dispatchPluginRequest(relay, origin, pluginId, payload, timeoutMs = 2000) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(pluginId)) throw new Error('Invalid plugin');
  const body = Buffer.from(JSON.stringify(payload));
  if (body.length > 256 * 1024) throw new Error('Request too large');
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let status = 0; let settled = false;
    const request = Readable.from([body]);
    Object.assign(request, { method: 'POST', url: `/api/v1/plugins/${pluginId}/http/connect`, headers: {
      host: new URL(origin).host, 'x-forwarded-proto': 'https', 'content-type': 'application/json', 'content-length': String(body.length)
    } });
    const response = new Writable({ write(chunk, _encoding, done) {
      size += chunk.length;
      if (size > 256 * 1024) return done(new Error('Response too large'));
      chunks.push(Buffer.from(chunk)); done();
    } });
    response.headersSent = false;
    response.writeHead = code => { status = code; response.headersSent = true; return response; };
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      request.destroy(); response.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Computer response unconfirmed')), Math.min(10_000, Math.max(100, timeoutMs)));
    timer.unref();
    response.on('error', () => finish(new Error('Computer response interrupted')));
    request.on('error', () => finish(new Error('Computer request interrupted')));
    response.on('finish', () => {
      try { finish(null, { status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
      catch { finish(new Error('Invalid computer response')); }
    });
    try { relay.handleHttp(request, response); } catch { finish(new Error('Computer request failed')); }
  });
}
