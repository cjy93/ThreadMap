import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { listChats } from '@/server/api/service';

export const dynamic = 'force-dynamic';

export const GET = authed(async (ctx) => ({ chats: await listChats(getDb(), ctx) }));
