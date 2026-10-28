import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { chatroomPage } from '@/server/api/service';

export const dynamic = 'force-dynamic';

// ?dir=before|after: the next page of the chat, in time order, beyond this message.
export const GET = authed<{ id: string }>(async (ctx, req, p) => chatroomPage(getDb(), ctx, p.id, new URL(req.url).searchParams.get('dir')));
