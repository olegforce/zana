import { expect, it } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { request, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { openConnectDatabase } from './database.mjs';

// Opt-in: targets a locally published website/Docker app and its private test DB.
// Never set these to a production service or database.
it.skipIf(!process.env.ZCC_CONNECT_TEST_HTTP_ORIGIN || !process.env.ZCC_CONNECT_TEST_DATABASE_URL)('the website Docker image serves Next plus isolated account/laptop tunnels using persistent Postgres', async () => {
  const edge = process.env.ZCC_CONNECT_TEST_HTTP_ORIGIN!;
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(edge)) throw new Error('Docker test requires a loopback origin');
  const db = await openConnectDatabase(process.env.ZCC_CONNECT_TEST_DATABASE_URL!, { production: true });
  const browserDomain = process.env.ZCC_CONNECT_TEST_BROWSER_DOMAIN || 'connect.example.com';
  const owners = [randomUUID(), randomUUID()]; const sockets: WebSocket[] = [];
  function call(host: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const req = request(edge + path, { method: body === undefined ? 'GET' : 'POST', headers: { host, 'x-forwarded-proto': 'https', 'content-type': 'application/json', ...extra } }, res => {
        let text = ''; res.on('data', data => text += data); res.on('end', () => resolve({ status: res.statusCode!, body: text, headers: res.headers }));
      }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  try {
    // Runtime startup, not the test, must have applied website and Connect migrations.
    const page = await call('example.com', '/connect/'); expect(page.status).toBe(200); expect(page.body).toContain('Your Zana');
    const anonymous = await call('example.com', '/api/auth/session/');
    expect(anonymous.status).toBe(200); expect(JSON.parse(anonymous.body)).toEqual({ user: null });
    expect(anonymous.headers['cache-control']).toContain('no-store');
    if (process.env.ZCC_CONNECT_TEST_OAUTH === '1') {
      const returnTo = `/connect/?code=${'q'.repeat(22)}`;
      const login = await call('example.com', `/api/auth/github/login/?returnTo=${encodeURIComponent(returnTo)}`);
      expect(login.status).toBe(302);
      const state = new URL(login.headers.location!).searchParams.get('state');
      const callback = await call('example.com', `/api/auth/github/callback/?state=${state}&code=mock:connect-fixture:${Math.floor(Math.random() * 1e9)}`, undefined, { cookie: login.headers['set-cookie']!.map(c => c.split(';')[0]).join('; ') });
      expect(callback.status).toBe(302); expect(callback.headers.location).toBe(`https://example.com${returnTo}`);
      const cookie = callback.headers['set-cookie']!.map(c => c.split(';')[0]).join('; ');
      const account = await call('example.com', '/api/connect/account', undefined, { cookie });
      expect(account.status).toBe(200);
      const user = JSON.parse(account.body).user; expect(user.name).toBe('connect-fixture');
      if (process.env.ZCC_CONNECT_TEST_DROP_IDLE === '1') {
        // Only disconnect the explicitly tagged fixture app in its disposable DB.
        const clients = await db.query("SELECT a.pid,s.ssl FROM pg_stat_activity a JOIN pg_stat_ssl s ON s.pid=a.pid WHERE a.datname=current_database() AND a.application_name='zcc-connect-docker-fixture' AND a.state='idle'");
        expect(clients.length).toBeGreaterThanOrEqual(2); // Next auth and the front door
        if (process.env.ZCC_CONNECT_TEST_REQUIRE_TLS === '1') expect(clients.every(c => c.ssl)).toBe(true);
        for (const client of clients) await db.query('SELECT pg_terminate_backend($1)', [client.pid]);
        await expect.poll(async () => { try { return (await call('example.com', '/api/connect/account', undefined, { cookie })).status; } catch { return 0; } }).toBe(200);
        const dashboard = await call('example.com', '/dashboard/', undefined, { cookie });
        expect(dashboard.status).toBe(200); expect(dashboard.body).toContain('connect-fixture');
      }
      const logout = await call('example.com', '/api/auth/logout/', {}, { cookie, origin: 'https://example.com' });
      expect(logout.status).toBe(302); expect(logout.headers.location).toBe('https://example.com/');
      expect((await call('example.com', '/api/connect/account', undefined, { cookie })).status).toBe(401);
      await db.query('DELETE FROM sessions WHERE user_id=$1', [user.id]); await db.query('DELETE FROM users WHERE id=$1', [user.id]);
    }
    const servers = [];
    for (const owner of owners) {
      await db.query('INSERT INTO users(id,github_id,github_login,created_at) VALUES($1,$2,$3,$4)', [owner, Math.floor(Math.random() * 1e9), `fixture-${owner}`, Date.now()]);
      await db.query('INSERT INTO sessions(id,user_id,created_at,expires_at) VALUES($1,$1,$2,$3)', [owner, Date.now(), Date.now() + 60_000]);
      const cookie = `zcc_session=${owner}.${createHmac('sha256', 'local-test-signature-secret').update(owner).digest('base64url')}`;
      const identity = await call('example.com', '/api/auth/session/', undefined, { cookie });
      expect(identity.status).toBe(200);
      expect(JSON.parse(identity.body)).toEqual({ user: { username: `fixture-${owner}` } });
      expect(identity.headers['cache-control']).toContain('private');
      expect(identity.headers['cache-control']).toContain('no-store');
      expect(identity.headers.vary).toContain('Cookie');
      expect(JSON.parse((await call('example.com', '/api/auth/session/', undefined, { cookie: `${cookie}tampered` })).body)).toEqual({ user: null });
      const desktop = JSON.parse((await call('example.com', '/api/connect/desktop/start', {})).body);
      // Compatibility with the installed desktop's strict, local-clock bounds.
      expect(desktop.expiresAt).toBeGreaterThan(Date.now());
      expect(desktop.expiresAt).toBeLessThanOrEqual(Date.now() + 600_000);
      expect(JSON.parse((await call('example.com', '/api/connect/desktop/poll', { deviceCode: desktop.deviceCode })).body)).toEqual({ pending: true });
      expect((await call('example.com', '/api/connect/desktop/approve', { code: desktop.userCode, approved: true }, { cookie, origin: 'https://example.com' })).status).toBe(200);
      const signedIn = JSON.parse((await call('example.com', '/api/connect/desktop/poll', { deviceCode: desktop.deviceCode })).body);
      expect(signedIn.expiresAt).toBeGreaterThan(Date.now());
      expect(signedIn.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * 86400_000);
      const desktopCookie = `zcc_session=${signedIn.cookieValue}`;
      expect(JSON.parse((await call('example.com', '/api/connect/account', undefined, { cookie: desktopCookie })).body).user.id).toBe(owner);
      expect((await call('example.com', '/api/connect/desktop/poll', { deviceCode: desktop.deviceCode })).status).toBe(410);
      expect((await call('example.com', '/api/auth/logout/', {}, { cookie: desktopCookie, origin: 'https://example.com' })).status).toBe(302);
      expect(JSON.parse((await call('example.com', '/api/auth/session/', undefined, { cookie: desktopCookie })).body)).toEqual({ user: null });
      const label = `browser-${owner.slice(0, 8)}`;
      const reservation = await call('example.com', '/api/connect/computer/reserve/', { label }, { cookie, origin: 'https://example.com' });
      expect(reservation.status).toBe(200);
      const reserved = JSON.parse(reservation.body);
      expect(reserved.browserUrl).toBe(`https://${label}.${browserDomain}`);
      const beforePairing = JSON.parse((await call('example.com', '/api/connect/account', undefined, { cookie })).body);
      expect(beforePairing.servers).toEqual([expect.objectContaining({ id: reserved.serverId, paired: false, live: false, browserUrl: reserved.browserUrl })]);
      const redeemed = await call('example.com', '/api/connect/computer/redeem', { code: reserved.code, name: owner });
      expect(redeemed.status).toBe(200);
      const enrolled = JSON.parse(redeemed.body);
      expect(enrolled.serverId).toBe(reserved.serverId);
      expect((await call('example.com', '/api/connect/computer/redeem', { code: reserved.code, name: owner })).status).toBe(409);
      const host = new URL(enrolled.serverUrl).host;
      const ws = new WebSocket(`${edge.replace('http:', 'ws:')}/_relay/connect`, { headers: { host, 'x-forwarded-proto': 'https', authorization: `Bearer ${enrolled.credential}` } });
      sockets.push(ws); const hello = once(ws, 'message'); await once(ws, 'open'); await hello;
      ws.on('message', raw => { const frame = JSON.parse(raw.toString()); if (frame.type === 'request-end') for (const part of [{ type: 'response', status: 200, headers: {} }, { type: 'response-data', data: Buffer.from(owner).toString('base64') }, { type: 'response-end' }]) ws.send(JSON.stringify({ ...part, id: frame.id })); });
      const qr = JSON.parse((await call('example.com', '/api/connect/machine-code', {}, { authorization: `Bearer ${enrolled.credential}` })).body);
      const paired = JSON.parse((await call(host, '/_mobile/pair', { code: qr.code, label: 'Test phone' })).body);
      const session = await call(host, '/_mobile/session', {}, { authorization: `Bearer ${paired.credential}` }); expect(session.status).toBe(200);
      const browserHost = `${label}.${browserDomain}`;
      const login = await call(browserHost, '/_connect/login?returnTo=%2Fthreads%2Ffixture');
      expect(login.status).toBe(303);
      const code = new URL(login.headers.location!).searchParams.get('browser');
      const approval = await call('example.com', '/api/connect/browser/approve', { code }, { cookie, origin: 'https://example.com' });
      expect(approval.status).toBe(200);
      const callback = await call(browserHost, `/_connect/callback?code=${code}`, undefined, { cookie: login.headers['set-cookie']![0].split(';')[0] });
      expect(callback.status).toBe(303); expect(callback.headers.location).toBe('/threads/fixture');
      const browserCookie = callback.headers['set-cookie']![0].split(';')[0];
      expect((await call(browserHost, '/', undefined, { cookie: browserCookie })).body).toBe(owner);
      expect((await call(host, '/', undefined, { cookie: browserCookie })).status).toBe(401);
      await db.query('DELETE FROM sessions WHERE id=$1', [owner]);
      expect(JSON.parse((await call('example.com', '/api/auth/session/', undefined, { cookie })).body)).toEqual({ user: null });
      expect((await call(browserHost, '/api/v1/projects', undefined, { cookie: browserCookie })).status).toBe(401);
      servers.push({ host, cookie: `zcc_mobile_session=${JSON.parse(session.body).cookie.value}`, owner, enrolled });
    }
    for (const server of servers) {
      expect((await call(server.host, '/api/v1/health', undefined, { cookie: server.cookie })).body).toBe(server.owner);
      expect((await call(server.host, '/', undefined, { cookie: servers.find(s => s !== server)!.cookie })).status).toBe(401);
      expect((await call('example.com', '/api/connect/disconnect', {}, { authorization: `Bearer ${server.enrolled.credential}` })).status).toBe(200);
      expect((await call(server.host, '/', undefined, { cookie: server.cookie })).status).toBe(404);
    }
  } finally {
    for (const ws of sockets) ws.terminate();
    for (const owner of owners) {
      await db.query('DELETE FROM connect_sessions WHERE server_id IN (SELECT id FROM connect_servers WHERE user_id=$1)', [owner]);
      await db.query('DELETE FROM connect_codes WHERE user_id=$1', [owner]);
      await db.query('DELETE FROM connect_servers WHERE user_id=$1', [owner]);
      await db.query('DELETE FROM connect_addresses WHERE user_id=$1', [owner]);
      await db.query('DELETE FROM connect_devices WHERE user_id=$1', [owner]);
      await db.query('DELETE FROM sessions WHERE user_id=$1', [owner]); await db.query('DELETE FROM users WHERE id=$1', [owner]);
    }
    await db.close();
  }
});
