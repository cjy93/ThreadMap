import { getDb } from '@/server/db';
import { authed, readJson } from '@/server/http';
import { reviewOne } from '@/server/api/service';

export const dynamic = 'force-dynamic';

export const POST = authed(async (ctx, req) => reviewOne(getDb(), ctx, await readJson(req)));
