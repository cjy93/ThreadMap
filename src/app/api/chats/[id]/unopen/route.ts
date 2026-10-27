import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { unopenChat } from '@/server/api/connector';

export const dynamic = 'force-dynamic';

export const POST = authed<{ id: string }>(async (ctx, _req, p) => unopenChat(getDb(), ctx, p.id));
