import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { putSelections, requestHistory } from '../src/server/api/connector';
import type { AuthCtx } from '../src/server/api/service';
import { ingestEvents, type IngestContext } from '../src/server/ingest/ingest';
import type { MessageEvent } from '../src/server/ingest/types';
import { ensureLinkedAccount, ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// Opening a chat sets how many of its newest older messages to import; Load older then
// goes on up to the deployment's cap (WHATSAPP_HISTORY_MAX_MESSAGES_PER_CHAT, 10,000 here).
let t: TestDb;
let ctx: IngestContext;
let auth: AuthCtx;
beforeAll(async () => {
  t = await createTestDb();
  const ws = await ensurePrivateWorkspace(t.db, await createUser(t.db));
  const la = await ensureLinkedAccount(t.db, ws.id);
  ctx = { workspaceId: ws.id, linkedAccountId: la.id, sourceKind: 'whatsapp', historyCapPerChat: 10_000 };
  auth = { userId: ws.ownerUserId, workspaceId: ws.id, mode: 'private' };
});
afterAll(async () => t?.close());

const msg = (jid: string, id: string, sec: number, origin: 'history' | 'live' = 'history'): MessageEvent => ({
  type: 'message', origin, chatJid: jid, chatKind: 'direct', nativeId: id, fromMe: false, participantJid: null, participantAltJid: null,
  senderJid: jid, senderName: null, sentAtSec: sec, kind: 'text', body: `message ${id}`, attachments: [], replyToNativeId: null, ephemeralSec: null, marker: null,
});
const chatOf = async (jid: string) => (await t.db.select().from(s.chats).where(and(eq(s.chats.workspaceId, ctx.workspaceId), eq(s.chats.nativeJid, jid))))[0];
const saved = async (chatId: string) => (await t.db.select().from(s.messages).where(eq(s.messages.chatId, chatId))).length;

describe('per-chat history limit chosen when opening', () => {
  it('imports only that many older messages; new ones still arrive; Load older goes on to the cap', async () => {
    const jid = '6511110099@s.whatsapp.net';
    await ingestEvents(t.db, ctx, [{ type: 'chat_meta', chatJid: jid, kind: 'direct', title: 'Friend', lastActivitySec: 1_760_000_900 }]);
    const c = await chatOf(jid);
    await putSelections(t.db, auth, { selections: [{ chat_id: c.id, selected: true, history_limit: 3 }] });
    expect((await chatOf(jid)).historyLimit).toBe(3);

    await ingestEvents(t.db, ctx, [1, 2, 3, 4, 5].map((i) => msg(jid, `H${i}`, 1_760_000_000 + i)));
    expect(await saved(c.id)).toBe(3);
    // A new message is not older history: it never counts toward the limit.
    await ingestEvents(t.db, ctx, [msg(jid, 'LIVE', 1_760_001_000, 'live')]);
    expect(await saved(c.id)).toBe(4);

    // Load older lifts the chat's own limit; older pages are then kept, up to the cap.
    const r = await requestHistory(t.db, auth, c.id);
    expect('limited' in r).toBe(false);
    expect((await chatOf(jid)).historyLimit).toBeNull();
    await ingestEvents(t.db, ctx, [msg(jid, 'H0', 1_759_999_000), msg(jid, 'H-1', 1_759_998_000)]);
    expect(await saved(c.id)).toBe(6);
  });

  it('never sets a limit above the cap', async () => {
    const jid = '6511110098@s.whatsapp.net';
    await ingestEvents(t.db, ctx, [{ type: 'chat_meta', chatJid: jid, kind: 'direct', title: 'Other', lastActivitySec: 1_760_000_900 }]);
    const c = await chatOf(jid);
    await putSelections(t.db, auth, { selections: [{ chat_id: c.id, selected: true, history_limit: 999_999 }] });
    expect((await chatOf(jid)).historyLimit).toBe(10_000);
    await expect(putSelections(t.db, auth, { selections: [{ chat_id: c.id, selected: true, history_limit: 0 }] })).rejects.toThrow();
  });
});
