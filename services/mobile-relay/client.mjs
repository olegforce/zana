import { request } from 'node:http';
import { WebSocket } from 'ws';
import { TUNNEL_PATH, LIMITS, headers, validPath, parseFrame, send, dataFrames, bytes, heartbeat, remoteOrigin, validToken } from './protocol.mjs';

/** Dials ONLY the supplied loopback mobile gateway, never the product server or a frame-supplied host. */
export function connectRelay({ publicUrl, token, gatewayPort, allowLocal = false, onState = () => {}, retryMs = 1000, heartbeatMs = 20_000, helloTimeoutMs = 10_000 }) {
  const origin = remoteOrigin(publicUrl, allowLocal);
  if (!validToken(token)) throw new Error('Invalid relay token');
  if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) throw new Error('Invalid gateway port');
  const target = new URL(TUNNEL_PATH, origin);
  target.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket;
  let retry;
  let stopped = false;
  let backoff = retryMs;
  let state = 'connecting';
  const streams = new Map();
  const update = value => { state = value; onState(value); };
  const dispose = key => {
    const stream = streams.get(key);
    if (!stream) return;
    streams.delete(key);
    stream.request?.destroy();
    stream.response?.destroy();
    stream.ws?.terminate();
  };
  const cleanup = () => { for (const key of streams.keys()) dispose(key); };
  const dial = () => {
    if (stopped) return;
    update('connecting');
    const ws = new WebSocket(target, { headers: { authorization: `Bearer ${token}` }, handshakeTimeout: 10_000, maxPayload: LIMITS.frame, perMessageDeflate: false, followRedirects: false });
    let ready = false;
    let helloTimer;
    socket = ws;
    ws.on('open', () => {
      heartbeat(ws, heartbeatMs);
      helloTimer = setTimeout(() => ws.terminate(), helloTimeoutMs);
      helloTimer.unref();
    });
    ws.on('error', () => { /* close owns cleanup/retry; never surface headers or secrets */ });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (socket !== ws) return;
      cleanup();
      if (stopped) return;
      update('reconnecting');
      retry = setTimeout(dial, backoff + Math.floor(Math.random() * Math.min(250, backoff)));
      retry.unref();
      backoff = Math.min(30_000, backoff * 2);
    });
    ws.on('message', raw => {
      try {
        const frame = parseFrame(raw);
        if (frame.type === 'hello' && frame.id === 0 && !ready) { clearTimeout(helloTimer); ready = true; backoff = retryMs; update('connected'); return; }
        if (!ready) throw new Error('Missing relay handshake');
        if (frame.id === 0) throw new Error('Invalid stream');
        if (frame.type === 'cancel') { dispose(frame.id); return; }
        if (frame.type === 'request' || frame.type === 'ws-open') {
          if (streams.has(frame.id) || streams.size >= LIMITS.streams) throw new Error('Too many streams');
          const incoming = { ...headers(frame.headers), host: origin.host };
          if (frame.type === 'request') {
            if (!validPath(frame.path) || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(frame.method)) throw new Error('Invalid request');
            const stream = { size: 0, ended: false };
            streams.set(frame.id, stream);
            const local = request({ hostname: '127.0.0.1', port: gatewayPort, path: frame.path, method: frame.method, headers: incoming, timeout: 120_000 }, response => {
              if (!streams.has(frame.id)) { response.destroy(); return; }
              stream.response = response;
              let size = 0;
              try { send(ws, { type: 'response', id: frame.id, status: response.statusCode, headers: headers(response.headers, true) }); }
              catch { send(ws, { type: 'error', id: frame.id }); dispose(frame.id); return; }
              response.on('data', chunk => {
                size += chunk.length;
                if (size > LIMITS.response || !dataFrames(ws, 'response-data', frame.id, chunk)) {
                  send(ws, { type: 'error', id: frame.id }); dispose(frame.id);
                }
              });
              response.on('end', () => { if (streams.delete(frame.id)) send(ws, { type: 'response-end', id: frame.id }); });
              response.on('error', () => { if (streams.has(frame.id)) { send(ws, { type: 'error', id: frame.id }); dispose(frame.id); } });
            });
            stream.request = local;
            local.on('timeout', () => local.destroy(new Error('Timeout')));
            local.on('error', () => { if (streams.has(frame.id)) { send(ws, { type: 'error', id: frame.id }); dispose(frame.id); } });
          } else {
            const local = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws`, { headers: incoming, handshakeTimeout: 10_000, maxPayload: 1024 * 1024, perMessageDeflate: false });
            const stream = { ws: local, queued: [], queuedBytes: 0 };
            streams.set(frame.id, stream);
            local.on('open', () => { for (const queued of stream.queued) local.send(queued.data, { binary: queued.binary }); stream.queued = []; stream.queuedBytes = 0; });
            local.on('message', (data, binary) => send(ws, { type: 'ws-data', id: frame.id, data: data.toString('base64'), binary }));
            local.on('error', () => { /* close reports failure */ });
            local.on('close', () => { if (streams.delete(frame.id)) send(ws, { type: 'ws-close', id: frame.id }); });
          }
          return;
        }
        const stream = streams.get(frame.id);
        // A cancellation can race in-flight response data; retired IDs are ignored.
        if (!stream) return;
        if (frame.type === 'request-data' && stream.request && !stream.ended) {
          const chunk = bytes(frame);
          stream.size += chunk.length;
          if (stream.size > LIMITS.request || stream.request.writableLength > LIMITS.buffer) { send(ws, { type: 'error', id: frame.id }); dispose(frame.id); }
          else stream.request.write(chunk);
        } else if (frame.type === 'request-end' && stream.request && !stream.ended) { stream.ended = true; stream.request.end(); }
        else if (frame.type === 'ws-data' && stream.ws) {
          const data = bytes(frame, 1024 * 1024);
          const binary = frame.binary === true;
          if (stream.ws.readyState === WebSocket.CONNECTING) {
            stream.queuedBytes += data.length;
            if (stream.queuedBytes > 64 * 1024) { send(ws, { type: 'error', id: frame.id }); dispose(frame.id); }
            else stream.queued.push({ data, binary });
          } else if (stream.ws.bufferedAmount > LIMITS.buffer) { send(ws, { type: 'error', id: frame.id }); dispose(frame.id); }
          else if (stream.ws.readyState === WebSocket.OPEN) stream.ws.send(data, { binary });
        } else throw new Error('Invalid frame sequence');
      } catch { ws.close(1008, 'Invalid tunnel frame'); }
    });
  };
  dial();
  return { state: () => state, close() { stopped = true; clearTimeout(retry); cleanup(); socket?.terminate(); update('stopped'); } };
}
