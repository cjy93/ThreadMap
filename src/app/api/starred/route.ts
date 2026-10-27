import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { listStarred } from '@/server/api/service';

export const dynamic = 'force-dynamic';

export const GET = authed(async (ctx, req) => listStarred(getDb(), ctx, new URL(req.url).searchParams));
