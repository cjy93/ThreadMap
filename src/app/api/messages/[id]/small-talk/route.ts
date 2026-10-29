import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { setSmallTalk } from '@/server/api/service';

export const dynamic = 'force-dynamic';

// {small: true} moves the message to small talk (off the map); {small: false} back onto the map.
export const POST = authed<{ id: string }>(async (ctx, req, p) => setSmallTalk(getDb(), ctx, p.id, await req.json().catch(() => null)));
