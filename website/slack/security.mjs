import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
export const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length <= 512 && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const linkKey = (secret, id) => createHmac('sha256', secret).update(`slack-link-v1:${id}`).digest('base64url');
export function envelope(link, key, body, now = Date.now()) {
  const value = { v: 1, linkId: link.id, timestamp: now, nonce: token(), body: JSON.stringify(body) };
  return { ...value, signature: createHmac('sha256', key).update(JSON.stringify(value)).digest('hex') };
}
export function verifiedSlack(raw, headers, secret, now = Date.now()) {
  const timestamp = headers.get('x-slack-request-timestamp');
  if (!/^\d{10}$/.test(timestamp ?? '') || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  return equal(headers.get('x-slack-signature'), `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:`).update(raw).digest('hex')}`);
}
export class SlackError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function rateLimiter(now = Date.now) {
  const buckets = new Map();
  return (key, max = 60) => {
    for (const [id, value] of buckets) if (value.until <= now()) buckets.delete(id);
    if (!buckets.has(key)) {
      if (buckets.size >= 2000) throw new SlackError('busy', 429);
      buckets.set(key, { until: now() + 60_000, count: 0 });
    }
    if (++buckets.get(key).count > max) throw new SlackError('too_many_requests', 429);
  };
}
export async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new SlackError('missing_body');
  let size = 0; const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 256 * 1024) { await reader.cancel(); throw new SlackError('body_too_large', 413); }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { reader.releaseLock(); }
}
