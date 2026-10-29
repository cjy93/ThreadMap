import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { listChatDays } from '@/server/api/service';

export const dynamic = 'force-dynamic';

// Messages per day for the chat's date slider.
export const GET = authed<{ id: string }>(async (ctx, req, p) => listChatDays(getDb(), ctx, p.id, new URL(req.url).searchParams));
