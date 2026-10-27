import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { refreshChat } from '@/server/api/connector';

export const dynamic = 'force-dynamic';

export const POST = authed<{ id: string }>(async (ctx, _req, p) => refreshChat(getDb(), ctx, p.id));
