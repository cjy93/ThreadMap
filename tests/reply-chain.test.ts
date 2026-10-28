import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { loadFixtureWorkspace } from '../src/fixtures/load';
import { getMessage } from '../src/server/api/service';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// Opening a message can show its WhatsApp reply chain: what it replies to (and
// what that replies to), and every reply to it (and replies to those).
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t?.close());

describe('reply chain', () => {
  it('follows replies up and down from the opened message', async () => {
    const userId = await createUser(t.db);
    const ws = (await ensurePrivateWorkspace(t.db, userId)).id;
    const { chatIdByKey } = await loadFixtureWorkspace(t.db, ws, { analyze: false });
    const chatId = chatIdByKey.builders;
    const ctx = { userId, workspaceId: ws, mode: 'private' as const };
    // Five messages far apart in the chat: B replies to A, C to B, D to C; E is unrelated.
    const rows = (await t.db.execute<{ id: string; native_id: string }>(sql`SELECT id, native_id FROM messages WHERE chat_id = ${chatId}::uuid AND kind = 'text' ORDER BY sent_at, id`)).rows;
    const [a, b, c, d, e] = [rows[0], rows[10], rows[20], rows[30], rows[40]];
    await t.db.execute(sql`UPDATE messages SET reply_to_native_id = NULL WHERE chat_id = ${chatId}::uuid`);
    const reply = (x: { id: string }, to: { native_id: string }) => t.db.update(s.messages).set({ replyToNativeId: to.native_id }).where(eq(s.messages.id, x.id));
    await reply(b, a);
    await reply(c, b);
    await reply(d, c);

    const opened = await getMessage(t.db, ctx, b.id);
    expect(opened.reply_chain.before.map((x) => x.message_id)).toEqual([a.id]);
    expect(opened.reply_chain.after.map((x) => [x.message_id, x.depth])).toEqual([
      [c.id, 1],
      [d.id, 2],
    ]);
    expect([...opened.reply_chain.before, ...opened.reply_chain.after].some((x) => x.message_id === e.id)).toBe(false);

    // From the end of the chain, everything is before it.
    const last = await getMessage(t.db, ctx, d.id);
    expect(last.reply_chain.before.map((x) => x.message_id)).toEqual([a.id, b.id, c.id]);
    expect(last.reply_chain.after).toEqual([]);
  });
});
