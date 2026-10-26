import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { resourcesFor } from '@/server/api/service';

export const dynamic = 'force-dynamic';

export const GET = authed<{ id: string }>(async (ctx, req, p) => resourcesFor(getDb(), ctx, p.id, new URL(req.url).searchParams));
