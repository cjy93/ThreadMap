import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { jobStatus } from '@/server/api/service';

export const dynamic = 'force-dynamic';

export const GET = authed<{ id: string }>(async (ctx, _req, p) => jobStatus(getDb(), ctx, p.id));
