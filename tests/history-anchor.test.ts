import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { putSelections } from '../src/server/api/connector';
import type { AuthCtx } from '../src/server/api/service';
import { ingestEvents, type IngestContext } from '../src/server/ingest/ingest';
import { nativeToNormalized } from '../src/server/ingest/native';
import type { MessageEvent } from '../src/server/ingest/types';
import { ensureLinkedAccount, ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

let t: TestDb;
let ctx: IngestContext;
let auth: AuthCtx;
beforeAll(async () => {
  t = await createTestDb();
  const ws = await ensurePrivateWorkspace(t.db, await createUser(t.db));
  const la = await ensureLinkedAccount(t.db, ws.id);
  ctx = { workspaceId: ws.id, linkedAccountId: la.id, sourceKind: 'whatsapp', historyCapPerChat: 1000 };
  auth = { userId: ws.ownerUserId, workspaceId: ws.id, mode: 'private' };
});
afterAll(async () => t?.close());

const msg = (jid: string, id: string, sentAtSec: number, body = 'private words'): MessageEvent => ({
  type: 'message', origin: 'history', chatJid: jid, chatKind: 'direct', nativeId: id, fromMe: false, participantJid: null, participantAltJid: null,
  senderJid: jid, senderName: null, sentAtSec, kind: 'text', body, attachments: [], replyToNativeId: null, ephemeralSec: null, marker: null,
});
const chatOf = async (jid: string) => (await t.db.select().from(s.chats).where(and(eq(s.chats.workspaceId, ctx.workspaceId), eq(s.chats.nativeJid, jid))))[0];

describe('chats selected late can still get their history', () => {
  it('remembers the newest message key of an unselected chat, but none of its content', async () => {
    const jid = '6511110016@s.whatsapp.net';
    // The chat list arrives first with the same last-activity time as its newest message.
    await ingestEvents(t.db, ctx, [{ type: 'chat_meta', chatJid: jid, kind: 'direct', title: 'Friend', lastActivitySec: 1_760_000_200 }]);
    await ingestEvents(t.db, ctx, [msg(jid, 'OLD', 1_760_000_100), msg(jid, 'NEW', 1_760_000_200)]);
    const c = await chatOf(jid);
    expect(c.historyAnchor).toEqual({ remoteJid: jid, id: 'NEW', fromMe: false, participant: null, ts: 1_760_000_200 });
    expect(await t.db.select().from(s.messages).where(eq(s.messages.chatId, c.id))).toEqual([]);
    // An older message never replaces the anchor.
    await ingestEvents(t.db, ctx, [msg(jid, 'OLDER', 1_759_000_000)]);
    expect((await chatOf(jid)).historyAnchor?.id).toBe('NEW');
  });

  it('asks WhatsApp for history when an empty chat is ticked, but not for one that already has messages', async () => {
    const empty = await chatOf('6511110016@s.whatsapp.net');
    const full = '6511110025@s.whatsapp.net';
    await ingestEvents(t.db, ctx, [{ type: 'chat_meta', chatJid: full, kind: 'direct', title: 'Other' }]);
    const fullChat = await chatOf(full);
    await putSelections(t.db, auth, { selections: [{ chat_id: fullChat.id, selected: true }] });
    await ingestEvents(t.db, ctx, [msg(full, 'F1', 1_760_000_300)]);
    expect((await t.db.select().from(s.messages).where(eq(s.messages.chatId, fullChat.id))).length).toBe(1);

    await t.db.delete(s.connectorCommands);
    await putSelections(t.db, auth, { selections: [{ chat_id: empty.id, selected: true }, { chat_id: fullChat.id, selected: true }] });
    const cmds = await t.db.select().from(s.connectorCommands).where(eq(s.connectorCommands.type, 'request_history'));
    const perChat = cmds.map((c) => (c.payload as { chatId?: string }).chatId).filter(Boolean);
    expect(perChat).toEqual([empty.id]);
  });

  it('never treats a number WhatsApp sends as a contact "name" as a name', () => {
    const out = nativeToNormalized('contacts.upsert', [
      { id: '6511110016@s.whatsapp.net', name: '+65∙∙∙∙∙∙16', notify: '+65 9123 4516' },
      { id: '6511110017@s.whatsapp.net', name: '+65∙∙∙∙∙∙17', notify: 'Kai' },
    ]);
    expect(out).toEqual([{ type: 'contact', jid: '6511110017@s.whatsapp.net', altJid: null, name: null, pushName: 'Kai' }]);
  });
});
