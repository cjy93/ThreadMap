import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { deleteIndexedChat } from '@/server/api/connector';

export const dynamic = 'force-dynamic';

export const DELETE = authed<{ id: string }>(async (ctx, _req, p) => deleteIndexedChat(getDb(), ctx, p.id));
