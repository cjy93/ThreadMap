import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { fixtureContext } from '../src/fixtures/load';
import { ingestEvents } from '../src/server/ingest/ingest';
import type { MessageEvent } from '../src/server/ingest/types';
import { applySelections, ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// One contact seen under their number and under their hidden ID became two
// chats ("Ming Ming" twice). Opening the hidden-ID one showed 0 messages: what
// WhatsApp sent under the number (history included) went to the unopened copy.
// Once WhatsApp maps the two, they become one chat.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t?.close());

const PN = '6591234567@s.whatsapp.net';
const LID = '123456789012345@lid';

describe('a contact split across their number and hidden ID', () => {
  it('folds the two chats into the opened one, so messages under either address arrive', async () => {
    const ws = (await ensurePrivateWorkspace(t.db, await createUser(t.db))).id;
    const ctx = { ...fixtureContext(ws), sourceKind: 'whatsapp' as const };
    await ingestEvents(t.db, ctx, [
      { type: 'chat_meta', chatJid: PN, kind: 'direct', title: 'Ming Ming', lastActivitySec: 1_800_000_000 },
      { type: 'chat_meta', chatJid: LID, kind: 'direct', title: 'Ming Ming', lastActivitySec: 1_800_000_100 },
    ]);
    const before = await t.db.select().from(s.chats).where(eq(s.chats.workspaceId, ws));
    expect(before).toHaveLength(2);
    const opened = before.find((c) => c.nativeJid === LID)!;
    await applySelections(t.db, ws, [{ chatId: opened.id, selected: true, historyMode: 'available_history' }]);

    await ingestEvents(t.db, ctx, [{ type: 'alias', pn: PN, lid: LID }]);
    const after = await t.db.select().from(s.chats).where(eq(s.chats.workspaceId, ws));
    expect(after.map((c) => c.id)).toEqual([opened.id]);
    expect(after[0].selected).toBe(true);
    const aliases = await t.db.select().from(s.chatAliases).where(eq(s.chatAliases.chatId, opened.id));
    expect(aliases.map((a) => a.aliasJid).sort()).toEqual([PN, LID].sort());

    // History the phone sends under the number now lands in the opened chat.
    const msg: MessageEvent = {
      type: 'message', origin: 'history', chatJid: PN, chatKind: 'direct', nativeId: 'H1', fromMe: false, participantJid: null, participantAltJid: null,
      senderJid: PN, senderName: 'Ming Ming', sentAtSec: 1_800_000_050, kind: 'text', body: 'see you at 7', attachments: [], replyToNativeId: null, ephemeralSec: null, marker: null,
    };
    await ingestEvents(t.db, ctx, [msg]);
    const stored = await t.db.select().from(s.messages).where(inArray(s.messages.chatId, [opened.id]));
    expect(stored.map((m) => m.body)).toEqual(['see you at 7']);
  });
});
