import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { retryJob } from '@/server/api/connector';

export const dynamic = 'force-dynamic';

export const POST = authed<{ id: string }>(async (ctx, _req, p) => retryJob(getDb(), ctx, p.id));
