import { getDb } from '@/server/db';
import { authed, readJson } from '@/server/http';
import { getViewPreferences, putViewPreferences } from '@/server/api/service';

export const dynamic = 'force-dynamic';

export const GET = authed<{ id: string }>(async (ctx, _req, p) => getViewPreferences(getDb(), ctx, p.id));
export const PUT = authed<{ id: string }>(async (ctx, req, p) => putViewPreferences(getDb(), ctx, p.id, await readJson(req)));
