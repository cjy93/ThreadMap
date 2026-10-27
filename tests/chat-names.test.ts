import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { ingestEvents, type IngestContext } from '../src/server/ingest/ingest';
import { nativeToNormalized } from '../src/server/ingest/native';
import type { MessageEvent, NormalizedEvent } from '../src/server/ingest/types';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

let t: TestDb;
let ctx: IngestContext;
beforeAll(async () => {
  t = await createTestDb();
  const ws = await ensurePrivateWorkspace(t.db, await createUser(t.db));
  ctx = { workspaceId: ws.id, linkedAccountId: null, sourceKind: 'whatsapp', historyCapPerChat: 1000 };
});
afterAll(async () => t?.close());

const title = async (jid: string) => (await t.db.select().from(s.chats).where(and(eq(s.chats.workspaceId, ctx.workspaceId), eq(s.chats.nativeJid, jid))))[0]?.title;
const meta = (jid: string): NormalizedEvent => ({ type: 'chat_meta', chatJid: jid, kind: jid.endsWith('@g.us') ? 'group' : 'direct', title: null });
const contact = (jid: string, name: string | null, pushName: string | null, altJid: string | null = null): NormalizedEvent => ({ type: 'contact', jid, altJid, name, pushName });
const msg = (jid: string, fromMe: boolean, senderName: string | null): MessageEvent => ({
  type: 'message', origin: 'history', chatJid: jid, chatKind: 'direct', nativeId: `n-${Math.random()}`, fromMe, participantJid: null, participantAltJid: null,
  senderJid: jid, senderName, sentAtSec: 1_700_000_000, kind: 'text', body: 'hi', attachments: [], replyToNativeId: null, ephemeralSec: null, marker: null,
});

describe('WhatsApp contacts are read', () => {
  it('maps contact events, skipping groups and nameless contacts', () => {
    const out = nativeToNormalized('contacts.upsert', [
      { id: '6511111111@s.whatsapp.net', name: 'Mum', notify: 'Mary' },
      { id: '123@lid', phoneNumber: '6522222222@s.whatsapp.net', notify: 'Ben' },
      { id: '999@g.us', name: 'A group' },
      { id: '6533333333@s.whatsapp.net' },
    ]);
    expect(out).toEqual([
      { type: 'contact', jid: '6511111111@s.whatsapp.net', altJid: null, name: 'Mum', pushName: 'Mary' },
      { type: 'contact', jid: '123@lid', altJid: '6522222222@s.whatsapp.net', name: null, pushName: 'Ben' },
    ]);
    const hist = nativeToNormalized('messaging-history.set', { chats: [], messages: [], contacts: [{ id: '6544444444@s.whatsapp.net', name: 'Dad' }] });
    expect(hist).toContainEqual({ type: 'contact', jid: '6544444444@s.whatsapp.net', altJid: null, name: 'Dad', pushName: null });
  });
});

describe('direct chats are named by person, not a placeholder', () => {
  it('falls back to the phone number, then upgrades to their WhatsApp name, then to the saved contact name', async () => {
    const jid = '6591234567@s.whatsapp.net';
    await ingestEvents(t.db, ctx, [meta(jid)]);
    expect(await title(jid)).toBe('+6591234567');
    await ingestEvents(t.db, ctx, [contact(jid, null, 'Ali')]);
    expect(await title(jid)).toBe('Ali');
    await ingestEvents(t.db, ctx, [contact(jid, 'Ali (school)', null)]);
    expect(await title(jid)).toBe('Ali (school)');
    // A self-chosen name never replaces a saved one.
    await ingestEvents(t.db, ctx, [contact(jid, null, 'Al')]);
    expect(await title(jid)).toBe('Ali (school)');
  });

  it('uses a contact name learned before the chat appeared', async () => {
    const jid = '6598765432@s.whatsapp.net';
    await ingestEvents(t.db, ctx, [contact(jid, 'Mum', null)]);
    await ingestEvents(t.db, ctx, [meta(jid)]);
    expect(await title(jid)).toBe('Mum');
  });

  it("names a chat from the other person's messages, never from your own", async () => {
    const jid = '6587654321@s.whatsapp.net';
    await ingestEvents(t.db, ctx, [msg(jid, true, 'You')]);
    expect(await title(jid)).toBe('+6587654321');
    await ingestEvents(t.db, ctx, [msg(jid, false, 'Ben')]);
    expect(await title(jid)).toBe('Ben');
  });

  it('lists chats like WhatsApp: latest message first, chats with no known time last', async () => {
    const ws = await ensurePrivateWorkspace(t.db, await createUser(t.db));
    const c2: IngestContext = { ...ctx, workspaceId: ws.id };
    const day = 86_400;
    const now = 1_760_000_000;
    const out = nativeToNormalized('messaging-history.set', {
      messages: [],
      chats: [
        { id: '1@g.us', name: 'Old group', conversationTimestamp: now - 30 * day },
        { id: '2@g.us', name: 'Recent group', conversationTimestamp: { toNumber: () => now - day } },
        { id: '6500000001@s.whatsapp.net', name: 'Zoe', conversationTimestamp: now },
        { id: '6500000002@s.whatsapp.net', conversationTimestamp: now + day }, // newest, but only a number
        { id: '6500000003@s.whatsapp.net', name: 'Amy' }, // no activity time
        { id: '6500000004@s.whatsapp.net', name: '+65∙∙∙∙∙∙04', conversationTimestamp: now + 2 * day }, // masked by WhatsApp
      ],
    });
    await ingestEvents(t.db, c2, out);
    const [amy] = await t.db.select().from(s.chats).where(and(eq(s.chats.workspaceId, ws.id), eq(s.chats.title, 'Amy')));
    await t.db.update(s.chats).set({ selected: true }).where(eq(s.chats.id, amy.id));
    const { discoveredChats } = await import('../src/server/api/connector');
    const list = await discoveredChats(t.db, { userId: 'x', workspaceId: ws.id, mode: 'private' });
    // Selecting a chat does not pin it: order is by latest message alone.
    expect(list.chats.map((c) => c.title)).toEqual(['+65∙∙∙∙∙∙04', '+6500000002', 'Zoe', 'Recent group', 'Old group', 'Amy']);
    expect(list.chats[2].last_message_at).toBe(new Date(now * 1000).toISOString());

    // A new message in an unticked chat moves it to the top; only its time is kept, never its content.
    await ingestEvents(t.db, c2, [{ ...msg('1@g.us', false, 'Kai'), chatKind: 'group', sentAtSec: now + 3 * day, participantJid: '6599990000@s.whatsapp.net' }]);
    const after = await discoveredChats(t.db, { userId: 'x', workspaceId: ws.id, mode: 'private' });
    expect(after.chats[0].title).toBe('Old group');
    const stored = await t.db.select().from(s.messages).where(eq(s.messages.chatId, after.chats[0].id));
    expect(stored).toEqual([]);
    // An older history message never moves a chat back in time.
    await ingestEvents(t.db, c2, [{ ...msg('1@g.us', false, 'Kai'), chatKind: 'group', sentAtSec: now - 99 * day, participantJid: '6599990000@s.whatsapp.net' }]);
    expect((await discoveredChats(t.db, { userId: 'x', workspaceId: ws.id, mode: 'private' })).chats[0].title).toBe('Old group');
  });

  it("treats WhatsApp's masked numbers as numbers: kept as-is, never over a name, replaced by a real one", async () => {
    const masked = '+65∙∙∙∙∙∙25';
    const named = '6512345601@s.whatsapp.net';
    await ingestEvents(t.db, ctx, [contact(named, 'Grace', null), { type: 'chat_meta', chatJid: named, kind: 'direct', title: masked }]);
    expect(await title(named)).toBe('Grace'); // a known name beats the mask
    await ingestEvents(t.db, ctx, [{ type: 'chat_meta', chatJid: named, kind: 'direct', title: masked }]);
    expect(await title(named)).toBe('Grace'); // and is not overwritten by it later

    const unknown = '6512345602@s.whatsapp.net';
    await ingestEvents(t.db, ctx, [{ type: 'chat_meta', chatJid: unknown, kind: 'direct', title: masked }]);
    expect(await title(unknown)).toBe(masked); // WhatsApp hid the number; ThreadMap does not reveal it
    await ingestEvents(t.db, ctx, [msg(unknown, false, 'Hana')]);
    expect(await title(unknown)).toBe('Hana');
  });

  it("learns a person's own name from their messages in any group, keeping none of the group's messages", async () => {
    const person = '6588880016@s.whatsapp.net';
    await ingestEvents(t.db, ctx, [meta(person), { type: 'chat_meta', chatJid: '4242@g.us', kind: 'group', title: 'Class group' }]);
    expect(await title(person)).toBe('+6588880016');
    await ingestEvents(t.db, ctx, [{ ...msg('4242@g.us', false, 'Siti'), chatKind: 'group', participantJid: person, senderJid: person }]);
    expect(await title(person)).toBe('Siti');
    const [group] = await t.db.select().from(s.chats).where(and(eq(s.chats.workspaceId, ctx.workspaceId), eq(s.chats.nativeJid, '4242@g.us')));
    expect(await t.db.select().from(s.messages).where(eq(s.messages.chatId, group.id))).toEqual([]);
    // A saved contact name still wins over the name they chose.
    await ingestEvents(t.db, ctx, [contact(person, 'Siti (lab partner)', null)]);
    await ingestEvents(t.db, ctx, [{ ...msg('4242@g.us', false, 'Siti'), chatKind: 'group', participantJid: person, senderJid: person }]);
    expect(await title(person)).toBe('Siti (lab partner)');
  });

  it('keeps group names and a neutral label when nothing is known', async () => {
    await ingestEvents(t.db, ctx, [{ type: 'chat_meta', chatJid: '1203@g.us', kind: 'group', title: 'Hackathon team' }]);
    expect(await title('1203@g.us')).toBe('Hackathon team');
    await ingestEvents(t.db, ctx, [meta('555@lid')]);
    expect(await title('555@lid')).toBe('Unknown contact');
  });

  it('names a hidden-ID chat once the number behind it is known: saved name first, else the number', async () => {
    await ingestEvents(t.db, ctx, [contact('6577770001@s.whatsapp.net', 'Wei Ling', null), meta('7001@lid'), meta('7002@lid')]);
    expect(await title('7001@lid')).toBe('Unknown contact');
    await ingestEvents(t.db, ctx, [
      { type: 'alias', pn: '6577770001@s.whatsapp.net', lid: '7001@lid' },
      { type: 'alias', pn: '6577770002@s.whatsapp.net', lid: '7002@lid' },
    ]);
    expect(await title('7001@lid')).toBe('Wei Ling');
    expect(await title('7002@lid')).toBe('+6577770002');
    // The number is offered for search, even where the title is a name.
    const { discoveredChats } = await import('../src/server/api/connector');
    const list = await discoveredChats(t.db, { userId: 'x', workspaceId: ctx.workspaceId, mode: 'private' });
    expect(list.chats.find((c) => c.title === 'Wei Ling')?.phone).toBe('+6577770001');
  });
});
