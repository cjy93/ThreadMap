import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { answer } from '@/server/api/ask';

export const dynamic = 'force-dynamic';

export const POST = authed(async (ctx, req) => answer(getDb(), ctx, await req.json().catch(() => ({}))));
