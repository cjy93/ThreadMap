import { DEMO_VIEW_COOKIE, getAuth, getOrigin } from '@/server/auth';
import { startPairing } from '@/server/api/connector';
import { getDb } from '@/server/db';
import { errorResponse, json } from '@/server/http';
import { SafeError } from '@/server/util';
import { startWhatsAppLogin } from '@/server/workspace';

export const dynamic = 'force-dynamic';

// Sign in with WhatsApp: give this browser's session a pending private
// workspace and ask the companion for a QR. Scanning it claims the account.
export async function POST(req: Request) {
  try {
    const auth = await getAuth();
    if (!auth) throw new SafeError('service is not configured yet', 503, 'not_ready');
    if (req.headers.get('origin') !== (await getOrigin())) throw new SafeError('cross-origin request rejected', 403, 'bad_origin');
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session) throw new SafeError('sign in required', 401, 'unauthenticated');
    const u = session.user as { id: string; isAnonymous?: boolean | null };
    const db = getDb();
    const ws = await startWhatsAppLogin(db, { id: u.id, isAnonymous: Boolean(u.isAnonymous) });
    await startPairing(db, { userId: u.id, workspaceId: ws.id, mode: 'private' });
    // A new link opens your own chats, not a demo viewed earlier in this browser.
    const res = json({ ok: true });
    res.headers.append('set-cookie', `${DEMO_VIEW_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
