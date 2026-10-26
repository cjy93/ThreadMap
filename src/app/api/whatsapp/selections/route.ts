import { getDb } from '@/server/db';
import { authed, readJson } from '@/server/http';
import { putSelections } from '@/server/api/connector';

export const dynamic = 'force-dynamic';

export const PUT = authed(async (ctx, req) => putSelections(getDb(), ctx, await readJson(req)));
