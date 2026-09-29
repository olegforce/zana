import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { isMachinePath, machineIdentity } from './machine-routes.mjs';
import { TUNNEL_PATH, LIMITS, headers, validPath, parseFrame, send, dataFrames, bytes, heartbeat, remoteOrigin, validToken } from './protocol.mjs';

/** One authenticated computer per relay process. Pairing remains on that computer. */
export function createRelay({ token, publicUrl, allowLocal = false, heartbeatMs = 20_000, requestTimeoutMs = 25_000, queueTimeoutMs = 5000, onVisitor = () => {} }) {
  if (!validToken(token)) throw new Error('Relay token must be 43–128 URL-safe characters');
  const origin = remoteOrigin(publicUrl, allowLocal);
  const streams = new Map();
  const pendingReads = new Map();
  let desktop = null;
  let nextId = 0;
  const id = () => { do { nextId = nextId % 0xffffffff + 1; } while (streams.has(nextId)); return nextId; };
  const fail = (res, status, message) => {
    if (res.headersSent) res.destroy();
    else { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: message })); }
  };
  // On Heroku the router supplies this header after TLS termination. Never
  // serve phone credentials/content on the app's plain HTTP URL.
  const trusted = req => req.headers.host === origin.host && (!req.headers.origin || req.headers.origin === origin.origin) &&
    (origin.protocol !== 'https:' || req.headers['x-forwarded-proto'] === 'https');
  const available = () => desktop?.readyState === WebSocket.OPEN && streams.size < LIMITS.streams;
  const cancel = (key) => {
    const stream = streams.get(key);
    if (!stream) return;
    clearTimeout(stream.timer);
    streams.delete(key);
    if (desktop) send(desktop, { type: 'cancel', id: key });
    drainReads();
  };
  const disconnect = () => {
    for (const pending of pendingReads.values()) {
      pending.remove();
      fail(pending.res, 503, 'Computer disconnected. Retry when it reconnects.');
    }
    for (const [key, stream] of streams) {
      clearTimeout(stream.timer);
      if (stream.res) fail(stream.res, 503, 'Computer disconnected. Reconnect and check whether your last action completed.');
      else stream.ws.terminate();
      streams.delete(key);
    }
  };
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.frame, perMessageDeflate: false });
  const drainReads = () => {
    while (available() && pendingReads.size) {
      const pending = pendingReads.values().next().value;
      pending.remove();
      if (pending.res.destroyed || pending.req.destroyed) continue;
      forwardHttp(pending.req, pending.res, pending.incoming);
      pending.req.resume();
    }
  };
  const queueRead = (req, res, incoming) => {
    // Browser module preloads can exceed the installed desktop's 64-stream
    // limit. Hold only bodyless reads, with bounded count and wait time; never
    // replay a write or raise the peer's protocol limit.
    if (!['GET', 'HEAD'].includes(req.method) || incoming['content-length'] && Number(incoming['content-length']) !== 0 || req.headers['transfer-encoding'] || pendingReads.size >= 256) {
      return fail(res, 503, 'Computer is busy. Retry shortly.');
    }
    req.pause();
    const remove = () => {
      clearTimeout(pending.timer);
      pendingReads.delete(res);
      req.off('aborted', remove); req.off('error', remove); res.off('close', remove);
    };
    const pending = { req, res, incoming, remove, timer: null };
    pendingReads.set(res, pending);
    req.once('aborted', remove); req.once('error', remove); res.once('close', remove);
    pending.timer = setTimeout(() => { remove(); fail(res, 503, 'Computer is busy. Retry shortly.'); }, queueTimeoutMs);
    pending.timer.unref();
  };
  const forwardHttp = (req, res, incoming) => {
    const key = id();
    const stream = { res, bytes: 0, timer: null };
    const arm = () => {
      clearTimeout(stream.timer);
      stream.timer = setTimeout(() => { cancel(key); fail(res, 504, 'Computer response timed out'); }, requestTimeoutMs);
      stream.timer.unref();
    };
    stream.arm = arm;
    streams.set(key, stream);
    arm();
    send(desktop, { type: 'request', id: key, method: req.method, path: req.url, headers: incoming });
    let size = 0;
    req.on('data', chunk => {
      if (!streams.has(key)) return;
      size += chunk.length;
      if (size > LIMITS.request) { cancel(key); fail(res, 413, 'Body too large'); req.resume(); }
      else dataFrames(desktop, 'request-data', key, chunk);
    });
    req.on('end', () => { if (streams.has(key)) send(desktop, { type: 'request-end', id: key }); });
    req.on('error', () => cancel(key));
    res.on('close', () => cancel(key));
  };
  const handleHttp = (req, res) => {
    if (!trusted(req)) return fail(res, 403, 'Untrusted origin');
    if (req.url === '/_relay/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ relay: 1, connected: desktop?.readyState === WebSocket.OPEN }));
    }
    if (!validPath(req.url) || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return fail(res, 404, 'Not found');
    if (desktop?.readyState !== WebSocket.OPEN) return fail(res, 503, 'Computer is offline. Keep Zana running and retry.');
    let incoming;
    try { incoming = headers(req.headers); } catch { return fail(res, 400, 'Invalid headers'); }
    if (Number(incoming['content-length'] ?? 0) > LIMITS.request) return fail(res, 413, 'Body too large');
    if (!available()) return queueRead(req, res, incoming);
    forwardHttp(req, res, incoming);
  };
  const handleUpgrade = (req, socket, head) => {
    const reject = code => socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\n\r\n`);
    if (!trusted(req)) return reject(403);
    if (req.url === TUNNEL_PATH) {
      const supplied = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (!validToken(supplied) || supplied.length !== token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) return reject(401);
      if (desktop) return reject(409);
      wss.handleUpgrade(req, socket, head, ws => {
        desktop = ws;
        heartbeat(ws, heartbeatMs);
        send(ws, { type: 'hello', id: 0 });
        ws.on('error', () => ws.terminate());
        ws.on('close', () => { if (desktop === ws) { desktop = null; disconnect(); } });
        ws.on('message', raw => {
          try {
            const frame = parseFrame(raw);
            const stream = streams.get(frame.id);
            if (!stream) return;
            if (stream.res) {
              stream.arm();
              if (frame.type === 'response') {
                if (stream.res.headersSent || !Number.isInteger(frame.status) || frame.status < 200 || frame.status > 599) throw new Error('Invalid response');
                stream.res.writeHead(frame.status, headers(frame.headers, true));
              } else if (frame.type === 'response-data') {
                if (!stream.res.headersSent) throw new Error('Missing response');
                const chunk = bytes(frame);
                stream.bytes += chunk.length;
                if (stream.bytes > LIMITS.response || stream.res.writableLength > LIMITS.buffer) { cancel(frame.id); stream.res.destroy(); }
                else stream.res.write(chunk);
              } else if (frame.type === 'response-end') {
                if (!stream.res.headersSent) throw new Error('Missing response');
                clearTimeout(stream.timer); streams.delete(frame.id); stream.res.end(); drainReads();
              } else if (frame.type === 'error') { cancel(frame.id); fail(stream.res, 502, 'Computer request failed'); }
              else throw new Error('Unexpected response');
            } else if (frame.type === 'ws-data') {
              const chunk = bytes(frame, 1024 * 1024);
              if (stream.ws.bufferedAmount > LIMITS.buffer) { cancel(frame.id); stream.ws.terminate(); }
              else if (stream.ws.readyState === WebSocket.OPEN) stream.ws.send(chunk, { binary: frame.binary === true });
            } else if (frame.type === 'ws-close' || frame.type === 'error') { cancel(frame.id); stream.ws.close(1011, 'Computer connection closed'); }
            else throw new Error('Unexpected socket frame');
          } catch { ws.close(1008, 'Invalid tunnel frame'); }
        });
      });
    } else {
      if ((!['/ws', '/ws/'].includes(req.url) && !(machineIdentity(req.headers) && isMachinePath('GET', req.url, true))) || !available()) return reject(503);
      let incoming;
      try { incoming = headers(req.headers); } catch { return reject(400); }
      wss.handleUpgrade(req, socket, head, ws => {
        const key = id();
        streams.set(key, { ws });
        onVisitor(ws, req);
        heartbeat(ws, heartbeatMs);
        send(desktop, { type: 'ws-open', id: key, path: req.url, headers: incoming });
        ws.on('message', (data, binary) => {
          if (data.length > 1024 * 1024) { ws.close(1009); return; }
          if (desktop) send(desktop, { type: 'ws-data', id: key, data: data.toString('base64'), binary });
        });
        ws.on('close', () => cancel(key));
        ws.on('error', () => ws.terminate());
      });
    }
  };
  return {
    handleHttp,
    handleUpgrade,
    connected: () => desktop?.readyState === WebSocket.OPEN,
    close() {
      if (desktop) { const ws = desktop; desktop = null; ws.terminate(); }
      disconnect();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    }
  };
}

/** Standalone service, using the same handlers embedded by the website Docker app. */
export async function startRelay(options) {
  const relay = createRelay(options);
  const server = createServer(relay.handleHttp);
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  // Include idle edge-proxy keep-alives; active work remains bounded by the
  // per-desktop stream and pending-read limits above.
  server.maxConnections = 1024;
  server.on('upgrade', relay.handleUpgrade);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, options.host ?? '0.0.0.0', () => { server.off('error', reject); resolve(); });
    });
  } catch (error) { relay.close(); throw error; }
  return {
    port: server.address().port,
    connected: relay.connected,
    async close() {
      relay.close(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  };
}
