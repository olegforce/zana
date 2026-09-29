import { NextResponse } from 'next/server';
import { requireSession } from '../../../../lib/auth';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie' };

export async function GET(req: Request) {
  try {
    const user = await requireSession(req);
    return NextResponse.json({ user: user ? { username: user.githubLogin } : null }, { headers });
  } catch {
    return NextResponse.json({ error: 'session_unavailable' }, { status: 503, headers });
  }
}
