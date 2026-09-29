import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../../lib/auth', () => ({ requireSession: vi.fn() }));
import { requireSession } from '../../../../lib/auth';
import { GET } from './route';

afterEach(() => vi.resetAllMocks());

describe('private navigation session', () => {
  it('returns only the authenticated username and prevents shared caching', async () => {
    vi.mocked(requireSession).mockResolvedValue({ id: 'private-id', githubId: 123, githubLogin: 'grebmann1', avatarUrl: 'https://example.com/avatar', createdAt: 0 });
    const req = new Request('https://zana-ide.com/api/auth/session/', { headers: { Cookie: 'zcc_session=signed-cookie' } });
    const response = await GET(req);
    expect(requireSession).toHaveBeenCalledWith(req);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: { username: 'grebmann1' } });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
    expect(response.headers.get('Vary')).toBe('Cookie');
    expect(response.headers.get('Set-Cookie')).toBeNull();
  });

  it('returns signed-out state for missing or rejected sessions', async () => {
    vi.mocked(requireSession).mockResolvedValue(null);
    const response = await GET(new Request('https://zana-ide.com/api/auth/session/'));
    expect(await response.json()).toEqual({ user: null });
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });

  it('reports temporary session failures without exposing internals or caching them', async () => {
    vi.mocked(requireSession).mockRejectedValue(new Error('private database error'));
    const response = await GET(new Request('https://zana-ide.com/api/auth/session/'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'session_unavailable' });
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });
});
