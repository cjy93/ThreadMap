import { getDb } from '@/server/db';
import { authed, readJson } from '@/server/http';
import { patchTopic } from '@/server/api/service';

export const dynamic = 'force-dynamic';

export const PATCH = authed<{ id: string }>(async (ctx, req, p) => patchTopic(getDb(), ctx, p.id, await readJson(req)));
