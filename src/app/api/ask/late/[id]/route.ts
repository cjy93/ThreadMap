import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { lateReply } from '@/server/api/ask';

export const dynamic = 'force-dynamic';

// A slow Nemotron reply (an answer, or the reading of a question), once it has arrived.
export const GET = authed<{ id: string }>(async (ctx, _req, p) => lateReply(getDb(), ctx, p.id));
