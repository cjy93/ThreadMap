import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { getNodeContent } from '@/server/api/service';

export const dynamic = 'force-dynamic';

export const GET = authed<{ id: string; nodeId: string }>(async (ctx, req, p) => getNodeContent(getDb(), ctx, p.id, p.nodeId, new URL(req.url).searchParams));
