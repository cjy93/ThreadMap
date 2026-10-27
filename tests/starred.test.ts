import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { loadFixtureWorkspace } from '../src/fixtures/load';
import { loadFixtureBundle } from '../src/fixtures/source';
import { listStarred } from '../src/server/api/service';
import { ingestEvents } from '../src/server/ingest/ingest';
import { nativeToNormalized } from '../src/server/ingest/native';
import type { MessageEvent } from '../src/server/ingest/types';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// Stars come from the phone: history carries the flag on each message, and
// starring or unstarring later arrives as a messages.update. The Starred panel
// lists them, newest star first.
const bundle = loadFixtureBundle();
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t?.close());

describe('starred messages', () => {
  it('reads stars from WhatsApp updates', () => {
    const [e] = nativeToNormalized('messages.update', [{ key: { remoteJid: '123@g.us', id: 'ABC', fromMe: false }, update: { starred: true } }]);
    expect(e).toEqual({ type: 'star', chatJid: '123@g.us', targetNativeId: 'ABC', fromMe: false, starred: true });
    const [h] = nativeToNormalized('messaging-history.set', { messages: [{ key: { remoteJid: '123@g.us', id: 'H1', fromMe: false, participant: 'p@s.whatsapp.net' }, messageTimestamp: 1_700_000_000, starred: true, message: { conversation: 'keep this' } }] });
    expect((h as MessageEvent).starred).toBe(true);
  });

  it('keeps stars in step with the phone and lists them per chat and across chats', async () => {
    const userId = await createUser(t.db);
    const ws = (await ensurePrivateWorkspace(t.db, userId)).id;
    const { chatIdByKey, ctx } = await loadFixtureWorkspace(t.db, ws, { analyze: false });
    const chatId = chatIdByKey.builders;
    const jid = bundle.manifest.chats.builders.jid;
    const ev = (nativeId: string, body: string, starred: boolean, dt: number): MessageEvent => ({
      type: 'message', origin: 'history', chatJid: jid, chatKind: 'group', nativeId, fromMe: false, participantJid: 'p1@s.whatsapp.net', participantAltJid: null,
      senderJid: 'p1@s.whatsapp.net', senderName: 'Pat', sentAtSec: 1_800_000_000 + dt, kind: 'text', body, attachments: [], replyToNativeId: null, ephemeralSec: null, marker: null, starred,
    });
    await ingestEvents(t.db, ctx, [ev('STAR-1', 'Venue is Hall B', true, 0), ev('PLAIN-1', 'ok', false, 1), ev('STAR-2', 'Deadline Friday 6pm', false, 2)]);
    const starredIn = async () => (await t.db.execute<{ native_id: string }>(sql`SELECT native_id FROM messages WHERE chat_id = ${chatId}::uuid AND starred ORDER BY native_id`)).rows.map((r) => r.native_id);
    expect(await starredIn()).toEqual(['STAR-1']);

    // Starred later on the phone; and one unstarred.
    await ingestEvents(t.db, ctx, [{ type: 'star', chatJid: jid, targetNativeId: 'STAR-2', fromMe: false, starred: true }]);
    expect(await starredIn()).toEqual(['STAR-1', 'STAR-2']);
    await ingestEvents(t.db, ctx, [{ type: 'star', chatJid: jid, targetNativeId: 'STAR-1', fromMe: false, starred: false }]);
    expect(await starredIn()).toEqual(['STAR-2']);
    // A history re-sync that carries the star again restores it.
    await ingestEvents(t.db, ctx, [ev('STAR-1', 'Venue is Hall B', true, 0)]);
    expect(await starredIn()).toEqual(['STAR-1', 'STAR-2']);

    const auth = { userId, workspaceId: ws, mode: 'private' as const };
    const one = await listStarred(t.db, auth, new URLSearchParams({ chat: chatId }));
    // Newest star first: STAR-1 was re-starred last.
    expect(one.messages.map((m) => m.snippet)).toEqual(['Venue is Hall B', 'Deadline Friday 6pm']);
    expect(one.messages[0]).toMatchObject({ chat_id: chatId, sender: expect.any(String), review: 'missed' });
    const all = await listStarred(t.db, auth, new URLSearchParams());
    expect(all.messages.length).toBe(2);
    // A revoked message drops out of the list.
    await t.db.update(s.messages).set({ state: 'revoked', body: null }).where(eq(s.messages.nativeId, 'STAR-2'));
    expect((await listStarred(t.db, auth, new URLSearchParams({ chat: chatId }))).messages.length).toBe(1);
  });
});
