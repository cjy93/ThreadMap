import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { listSmallTalk } from '@/server/api/service';

export const dynamic = 'force-dynamic';

export const GET = authed<{ id: string }>(async (ctx, req, p) => listSmallTalk(getDb(), ctx, p.id, new URL(req.url).searchParams));
