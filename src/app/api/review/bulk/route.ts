import { getDb } from '@/server/db';
import { authed, readJson } from '@/server/http';
import { bulkExecute } from '@/server/api/service';

export const dynamic = 'force-dynamic';

export const POST = authed(async (ctx, req) => bulkExecute(getDb(), ctx, await readJson(req)));
