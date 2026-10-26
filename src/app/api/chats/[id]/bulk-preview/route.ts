import { getDb } from '@/server/db';
import { authed, readJson } from '@/server/http';
import { bulkPreview } from '@/server/api/service';

export const dynamic = 'force-dynamic';

export const POST = authed<{ id: string }>(async (ctx, req, p) => bulkPreview(getDb(), ctx, p.id, await readJson(req)));
