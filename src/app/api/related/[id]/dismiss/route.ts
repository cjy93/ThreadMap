import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { dismissLink } from '@/server/api/service';

export const dynamic = 'force-dynamic';

export const POST = authed<{ id: string }>(async (ctx, _req, p) => dismissLink(getDb(), ctx, p.id));
