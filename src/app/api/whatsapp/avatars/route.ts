import { getDb } from '@/server/db';
import { authed, readJson } from '@/server/http';
import { requestAvatars } from '@/server/api/connector';

export const dynamic = 'force-dynamic';

export const POST = authed(async (ctx, req) => requestAvatars(getDb(), ctx, await readJson(req)));
