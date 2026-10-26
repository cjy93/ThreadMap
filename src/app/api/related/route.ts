import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { related } from '@/server/api/service';

export const dynamic = 'force-dynamic';

export const GET = authed(async (ctx, req) => related(getDb(), ctx, new URL(req.url).searchParams.get('topic') ?? ''));
