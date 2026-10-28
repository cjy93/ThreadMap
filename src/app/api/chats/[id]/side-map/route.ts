import { getDb } from '@/server/db';
import { authed, readJson } from '@/server/http';
import { startSideMap } from '@/server/api/connector';

export const dynamic = 'force-dynamic';

// Body {side: "mine" | "others"}: start or update the chat's map built from only that side's messages.
export const POST = authed<{ id: string }>(async (ctx, req, p) => startSideMap(getDb(), ctx, p.id, ((await readJson(req)) as { side?: unknown } | null)?.side));
