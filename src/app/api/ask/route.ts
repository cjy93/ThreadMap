import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { ask } from '@/server/api/ask';

export const dynamic = 'force-dynamic';

export const GET = authed(async (ctx, req) => ask(getDb(), ctx, new URL(req.url).searchParams));
