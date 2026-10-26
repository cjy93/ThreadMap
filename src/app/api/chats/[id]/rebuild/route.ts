import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { rebuildChat } from '@/server/api/connector';

export const dynamic = 'force-dynamic';

export const POST = authed<{ id: string }>(async (ctx, _req, p) => rebuildChat(getDb(), ctx, p.id));
