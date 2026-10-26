import { getDb } from '@/server/db';
import { authed, readJson } from '@/server/http';
import { patchPlacement } from '@/server/api/service';

export const dynamic = 'force-dynamic';

export const PATCH = authed(async (ctx, req) => patchPlacement(getDb(), ctx, await readJson(req)));
