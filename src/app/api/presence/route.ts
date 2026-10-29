import { getDb } from '@/server/db';
import { authed } from '@/server/http';
import { markSeen } from '@/server/presence';

export const dynamic = 'force-dynamic';

// An open ThreadMap page checks in every minute; with none open for a while the account is deleted.
export const POST = authed(async (ctx) => (ctx.mode === 'private' ? markSeen(getDb(), ctx.workspaceId) : markSeen(getDb(), ctx.workspaceId, ctx.userId)));
