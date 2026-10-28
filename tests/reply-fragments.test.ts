import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { loadFixtureWorkspace } from '../src/fixtures/load';
import { joinReplyFragments } from '../src/server/ai/pipeline';
import { getMessage } from '../src/server/api/service';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// Nano split "October 24 at 5:00AM Sgt is latest time" (a WhatsApp reply to a
// message in "Hackathon platform links and deadlines") into a 2-message
// discussion of its own. A small discussion replying into another joins it, and
// opening any message shows what led up to its discussion and what it quotes.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t?.close());

describe('reply fragments', () => {
  it('joins a small discussion into the one its reply quotes, and shows the lead-up', async () => {
    const userId = await createUser(t.db);
    const ws = (await ensurePrivateWorkspace(t.db, userId)).id;
    const { chatIdByKey } = await loadFixtureWorkspace(t.db, ws, { analyze: true });
    const chatId = chatIdByKey.builders;
    const ctx = { userId, workspaceId: ws, mode: 'private' as const };
    // A host discussion and a later, separate one; the later one is cut down to two messages
    // and its first message is made a reply to the host's last message.
    const units = await t.db.select().from(s.analysisUnits).where(eq(s.analysisUnits.chatId, chatId)).orderBy(s.analysisUnits.createdAt);
    const host = units.find((u) => u.messageRefs.length >= 3)!;
    const frag = units.find((u) => u.id !== host.id && u.messageRefs.length >= 2)!;
    const fragRefs = frag.messageRefs.slice(0, 2);
    await t.db.update(s.analysisUnits).set({ messageRefs: fragRefs }).where(eq(s.analysisUnits.id, frag.id));
    await t.db.execute(sql`UPDATE analysis_units SET assigned_topic_id = NULL WHERE id IN (${host.id}::uuid, ${frag.id}::uuid)`);
    const quoted = host.messageRefs.at(-1)!.m;
    const [q] = await t.db.select({ nativeId: s.messages.nativeId }).from(s.messages).where(eq(s.messages.id, quoted));
    await t.db.update(s.messages).set({ replyToNativeId: q.nativeId }).where(eq(s.messages.id, fragRefs[0].m));

    expect(await joinReplyFragments(t.db, chatId)).toBeGreaterThan(0);
    const after = await t.db.select().from(s.analysisUnits).where(eq(s.analysisUnits.chatId, chatId));
    expect(after.find((u) => u.id === frag.id)).toBeUndefined();
    const joined = after.find((u) => u.id === host.id)!;
    for (const r of [...host.messageRefs, ...fragRefs]) expect(joined.messageRefs.map((x) => x.m)).toContain(r.m);

    // The reply shows the message it quotes, and the discussion shows what came before it.
    const opened = await getMessage(t.db, ctx, fragRefs[0].m);
    const self = opened.thread!.messages.find((x) => x.current)!;
    expect(self.reply_to?.message_id).toBe(quoted);
    const firstAt = opened.thread!.messages[0].sent_at!;
    // Up to six earlier messages of the chat, however many there are before the discussion starts.
    const [{ n }] = (await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM messages WHERE chat_id = ${chatId}::uuid AND sent_at < ${firstAt}::timestamptz`)).rows;
    expect(opened.thread!.before.length).toBe(Math.min(6, n));
    for (const b of opened.thread!.before) expect(b.sent_at! <= firstAt).toBe(true);
  });

  it('lines a fragment up with a discussion already on the map instead of merging into it', async () => {
    const ws = (await ensurePrivateWorkspace(t.db, await createUser(t.db))).id;
    const { chatIdByKey } = await loadFixtureWorkspace(t.db, ws, { analyze: true });
    const chatId = chatIdByKey.builders;
    const units = await t.db.select().from(s.analysisUnits).where(eq(s.analysisUnits.chatId, chatId)).orderBy(s.analysisUnits.createdAt);
    const host = units.find((u) => u.messageRefs.length >= 2 && u.assignedTopicId)!; // stays placed
    const frag = units.find((u) => u.id !== host.id && u.messageRefs.length >= 2)!;
    await t.db.update(s.analysisUnits).set({ messageRefs: frag.messageRefs.slice(0, 2), assignedTopicId: null }).where(eq(s.analysisUnits.id, frag.id));
    const [q] = await t.db.select({ nativeId: s.messages.nativeId }).from(s.messages).where(eq(s.messages.id, host.messageRefs[0].m));
    await t.db.update(s.messages).set({ replyToNativeId: q.nativeId }).where(eq(s.messages.id, frag.messageRefs[0].m));

    expect(await joinReplyFragments(t.db, chatId)).toBe(1);
    const [f] = await t.db.select().from(s.analysisUnits).where(eq(s.analysisUnits.id, frag.id));
    // Not merged into a placed discussion, but titled and rooted like it, so it lands beside it.
    expect(f).toBeDefined();
    expect((f.summaryBullets as { title: string }).title).toBe((host.summaryBullets as { title: string }).title);
    expect(f.primaryRoot).toBe(host.primaryRoot);
  });
});
