import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { fetchAttachment } from '@/server/api/connector';

export const dynamic = 'force-dynamic';

export const POST = authed<{ id: string }>(async (ctx, _req, p) => fetchAttachment(getDb(), ctx, p.id));
