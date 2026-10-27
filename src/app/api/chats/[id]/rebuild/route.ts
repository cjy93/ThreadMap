import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { rebuildChat, rebuildChatFromScratch } from '@/server/api/connector';

export const dynamic = 'force-dynamic';

// ?fresh=1 discards the current map and builds a new one from the discussions already read.
export const POST = authed<{ id: string }>(async (ctx, req, p) =>
  new URL(req.url).searchParams.get('fresh') === '1' ? rebuildChatFromScratch(getDb(), ctx, p.id) : rebuildChat(getDb(), ctx, p.id),
);
