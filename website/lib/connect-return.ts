/** OAuth may only return to the Connect screen, never an arbitrary URL. */
export function connectReturn(value: string | null): string {
  return value && /^\/connect\/(?:\?(?:code|slack|browser|phone|desktop)=[A-Za-z0-9_-]{22})?$/.test(value) ? value : '/dashboard';
}
export function connectReturnCookie(value: string, clear = false): string {
  return `oauth_return=${encodeURIComponent(connectReturn(value))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${clear ? 0 : 600}${process.env.PUBLIC_BASE_URL?.startsWith('http://localhost') ? '' : '; Secure'}`;
}
export function readConnectReturn(request: Request): string {
  try { return connectReturn(decodeURIComponent(request.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith('oauth_return='))?.slice(13) ?? '')); }
  catch { return '/dashboard'; }
}
