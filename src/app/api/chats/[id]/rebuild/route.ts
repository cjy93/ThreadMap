import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { rebuildChat, rebuildChatFromScratch, rereadChat } from '@/server/api/connector';

export const dynamic = 'force-dynamic';

// ?fresh=1 discards the current map and builds a new one from the discussions already read;
// ?reread=1 also has every message read again (new discussions), then builds the map.
export const POST = authed<{ id: string }>(async (ctx, req, p) => {
  const q = new URL(req.url).searchParams;
  if (q.get('reread') === '1') return rereadChat(getDb(), ctx, p.id);
  return q.get('fresh') === '1' ? rebuildChatFromScratch(getDb(), ctx, p.id) : rebuildChat(getDb(), ctx, p.id);
});
