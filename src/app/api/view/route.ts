import { DEMO_VIEW_COOKIE } from '@/server/auth';

export const dynamic = 'force-dynamic';

// Switch between the demo and your own chats without signing out (see viewsDemo).
// Only a view preference: what each view may read is still decided by requireUser.
export async function GET(req: Request) {
  const demo = new URL(req.url).searchParams.get('to') === 'demo';
  // Relative Location: behind a proxy req.url carries the bind address, not the public origin.
  const cookie = demo
    ? `${DEMO_VIEW_COOKIE}=demo; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax`
    : `${DEMO_VIEW_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
  return new Response(null, { status: 303, headers: { location: demo ? '/demo' : '/app', 'set-cookie': cookie, 'cache-control': 'no-store' } });
}
