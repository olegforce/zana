import { SlackError } from './security.mjs';

/** Only bounded generated PNGs; never accept a caller URL, filename or channel share. */
export function diagramPng(value) {
  if (typeof value !== 'string' || value.length > 220_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new SlackError('invalid_diagram');
  const png = Buffer.from(value, 'base64');
  if (png.toString('base64') !== value || png.length < 24 || png.length > 160 * 1024 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.subarray(12, 16).toString() !== 'IHDR' || !png.readUInt32BE(16) || !png.readUInt32BE(20) || png.readUInt32BE(16) > 1600 || png.readUInt32BE(20) > 1600) throw new SlackError('invalid_diagram');
  return png;
}

export async function uploadDiagram(call, fetcher, input) {
  const png = diagramPng(input.png);
  const ticket = await call('files.getUploadURLExternal', { filename: 'diagram.png', length: png.length });
  if (!ticket.ok) return ticket;
  const url = new URL(ticket.upload_url);
  if (url.protocol !== 'https:' || url.hostname !== 'files.slack.com' || url.port || url.username || url.password || !url.pathname.startsWith('/upload/v1/') || !/^F[A-Z0-9]{5,30}$/.test(ticket.file_id || '')) throw new SlackError('invalid_upload_ticket');
  const response = await fetcher(url.href, { method: 'POST', body: png, headers: { 'content-type': 'image/png' }, redirect: 'error', signal: AbortSignal.timeout(8000) });
  await response.body?.cancel();
  if (!response.ok) return { ok: false, error: 'diagram_upload_failed' };
  // No channel_id: uploading must not create another thread notification.
  const done = await call('files.completeUploadExternal', { files: [{ id: ticket.file_id, title: 'Diagram' }] });
  if (!done.ok) return done;
  let file = done.files?.find(f => f.id === ticket.file_id);
  if (!file?.permalink) {
    try {
      const auth = await call('auth.test', {});
      const base = new URL(auth.url);
      if (auth.ok && base.protocol === 'https:' && base.hostname.endsWith('.slack.com') && !base.username && !base.password && !base.port && /^[UW][A-Z0-9]{5,30}$/.test(auth.user_id || '')) file = { permalink: new URL(`/files/${auth.user_id}/${ticket.file_id}/diagram.png`, base).href };
    } catch { /* The image can still be displayed by ID without Canvas metadata. */ }
  }
  let permalink;
  try {
    const p = new URL(file?.permalink);
    if (p.protocol === 'https:' && p.hostname.endsWith('.slack.com') && !p.username && !p.password && !p.port && p.pathname.split('/').includes(ticket.file_id)) permalink = p.href;
  } catch { /* Never return an unverified image reference. */ }
  return { ok: true, file_id: ticket.file_id, ...(permalink ? { permalink } : {}) };
}
