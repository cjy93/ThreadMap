import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { getMessage } from '@/server/api/service';

export const dynamic = 'force-dynamic';

export const GET = authed<{ id: string }>(async (ctx, _req, p) => getMessage(getDb(), ctx, p.id));
