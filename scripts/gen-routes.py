# Generates thin Next.js route wrappers around the service layer.
import os

R = 'src/app/api'


def w(path, body):
    p = os.path.join(R, path, 'route.ts')
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w', encoding='utf8') as f:
        f.write(body.strip() + '\n')


H = "import { getDb } from '@/server/db';\nimport { authed, readJson } from '@/server/http';\n"
HN = "import { getDb } from '@/server/db';\nimport { authed } from '@/server/http';\n"
S = "\nexport const dynamic = 'force-dynamic';\n\n"


def simple(path, imp, body, needs_json=False):
    w(path, (H if needs_json else HN) + imp + '\n' + S + body)


simple('chats', "import { listChats } from '@/server/api/service';", "export const GET = authed(async (ctx) => ({ chats: await listChats(getDb(), ctx) }));")
simple('chats/[id]', "import { deleteIndexedChat } from '@/server/api/connector';", "export const DELETE = authed<{ id: string }>(async (ctx, _req, p) => deleteIndexedChat(getDb(), ctx, p.id));")
simple('chats/[id]/map', "import { getMap } from '@/server/api/service';", "export const GET = authed<{ id: string }>(async (ctx, req, p) => getMap(getDb(), ctx, p.id, new URL(req.url).searchParams));")
simple('chats/[id]/nodes/[nodeId]/content', "import { getNodeContent } from '@/server/api/service';", "export const GET = authed<{ id: string; nodeId: string }>(async (ctx, req, p) => getNodeContent(getDb(), ctx, p.id, p.nodeId, new URL(req.url).searchParams));")
simple('chats/[id]/view-preferences', "import { getViewPreferences, putViewPreferences } from '@/server/api/service';", "export const GET = authed<{ id: string }>(async (ctx, _req, p) => getViewPreferences(getDb(), ctx, p.id));\nexport const PUT = authed<{ id: string }>(async (ctx, req, p) => putViewPreferences(getDb(), ctx, p.id, await readJson(req)));", True)
simple('chats/[id]/history', "import { requestHistory } from '@/server/api/connector';", "export const POST = authed<{ id: string }>(async (ctx, _req, p) => requestHistory(getDb(), ctx, p.id));")
simple('chats/[id]/rebuild', "import { rebuildChat } from '@/server/api/connector';", "export const POST = authed<{ id: string }>(async (ctx, _req, p) => rebuildChat(getDb(), ctx, p.id));")
simple('chats/[id]/resources', "import { resourcesFor } from '@/server/api/service';", "export const GET = authed<{ id: string }>(async (ctx, req, p) => resourcesFor(getDb(), ctx, p.id, new URL(req.url).searchParams));")
simple('chats/[id]/bulk-preview', "import { bulkPreview } from '@/server/api/service';", "export const POST = authed<{ id: string }>(async (ctx, req, p) => bulkPreview(getDb(), ctx, p.id, await readJson(req)));", True)
simple('messages/[id]', "import { getMessage } from '@/server/api/service';", "export const GET = authed<{ id: string }>(async (ctx, _req, p) => getMessage(getDb(), ctx, p.id));")
simple('attachments/[id]/fetch', "import { fetchAttachment } from '@/server/api/connector';", "export const POST = authed<{ id: string }>(async (ctx, _req, p) => fetchAttachment(getDb(), ctx, p.id));")
simple('review', "import { reviewOne } from '@/server/api/service';", "export const POST = authed(async (ctx, req) => reviewOne(getDb(), ctx, await readJson(req)));", True)
simple('review/bulk', "import { bulkExecute } from '@/server/api/service';", "export const POST = authed(async (ctx, req) => bulkExecute(getDb(), ctx, await readJson(req)));", True)
simple('topics/[id]', "import { patchTopic } from '@/server/api/service';", "export const PATCH = authed<{ id: string }>(async (ctx, req, p) => patchTopic(getDb(), ctx, p.id, await readJson(req)));", True)
simple('placements', "import { patchPlacement } from '@/server/api/service';", "export const PATCH = authed(async (ctx, req) => patchPlacement(getDb(), ctx, await readJson(req)));", True)
simple('search', "import { search } from '@/server/api/service';", "export const GET = authed(async (ctx, req) => search(getDb(), ctx, new URL(req.url).searchParams));")
simple('related', "import { related } from '@/server/api/service';", "export const GET = authed(async (ctx, req) => related(getDb(), ctx, new URL(req.url).searchParams.get('topic') ?? ''));")
simple('related/[id]/dismiss', "import { dismissLink } from '@/server/api/service';", "export const POST = authed<{ id: string }>(async (ctx, _req, p) => dismissLink(getDb(), ctx, p.id));")
simple('jobs/[id]', "import { jobStatus } from '@/server/api/service';", "export const GET = authed<{ id: string }>(async (ctx, _req, p) => jobStatus(getDb(), ctx, p.id));")
simple('jobs/[id]/retry', "import { retryJob } from '@/server/api/connector';", "export const POST = authed<{ id: string }>(async (ctx, _req, p) => retryJob(getDb(), ctx, p.id));")
simple('whatsapp/pair', "import { startPairing } from '@/server/api/connector';", "export const POST = authed(async (ctx) => startPairing(getDb(), ctx));")
simple('whatsapp/status', "import { connectionStatus } from '@/server/api/connector';", "export const GET = authed(async (ctx) => connectionStatus(getDb(), ctx));")
simple('whatsapp/chats', "import { discoveredChats } from '@/server/api/connector';", "export const GET = authed(async (ctx) => discoveredChats(getDb(), ctx));")
simple('whatsapp/selections', "import { putSelections } from '@/server/api/connector';", "export const PUT = authed(async (ctx, req) => putSelections(getDb(), ctx, await readJson(req)));", True)
simple('whatsapp/pause', "import { setDesired } from '@/server/api/connector';", "export const POST = authed(async (ctx) => setDesired(getDb(), ctx, 'paused'));")
simple('whatsapp/resume', "import { setDesired } from '@/server/api/connector';", "export const POST = authed(async (ctx) => setDesired(getDb(), ctx, 'active'));")
simple('whatsapp/disconnect', "import { disconnect } from '@/server/api/connector';", "export const POST = authed(async (ctx) => disconnect(getDb(), ctx));")
