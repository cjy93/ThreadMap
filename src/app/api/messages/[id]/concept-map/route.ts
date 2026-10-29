import { getDb } from '@/server/db';
import { authed, readJson } from '@/server/http';
import { getStudyMap, startStudyMap } from '@/server/api/studymap';

export const dynamic = 'force-dynamic';

// The message's concept map (study guide): its state while Nemotron Ultra builds it, then the map.
export const GET = authed<{ id: string }>(async (ctx, _req, p) => getStudyMap(getDb(), ctx, p.id));
// Body {rebuild?: true}: start building it (again).
export const POST = authed<{ id: string }>(async (ctx, req, p) => startStudyMap(getDb(), ctx, p.id, await readJson(req)));
