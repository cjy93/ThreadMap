import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadFixtureWorkspace } from '../src/fixtures/load';
import { ask } from '../src/server/api/ask';
import { chatroomPage, getMessage } from '../src/server/api/service';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

let t: TestDb;
let ctx: { userId: string; workspaceId: string; mode: 'private' };
let chatId: string;
beforeAll(async () => {
  t = await createTestDb();
  const userId = await createUser(t.db);
  const ws = (await ensurePrivateWorkspace(t.db, userId)).id;
  chatId = (await loadFixtureWorkspace(t.db, ws, { analyze: false })).chatIdByKey.builders;
  ctx = { userId, workspaceId: ws, mode: 'private' };
});
afterAll(async () => t?.close());

describe('Chatroom', () => {
  it('shows the chat in time order around a message and pages further either way', async () => {
    const all = (await t.db.execute<{ id: string }>(sql`SELECT id FROM messages WHERE chat_id = ${chatId}::uuid AND sent_at IS NOT NULL ORDER BY sent_at, id`)).rows.map((r) => r.id);
    const mid = all[Math.floor(all.length / 2)];
    const opened = await getMessage(t.db, ctx, mid);
    const ids = opened.context.map((c) => c.message_id);
    const at = all.indexOf(mid);
    // Fifteen each side, in chat order, with the opened message in its place.
    expect(ids).toEqual(all.slice(at - 15, at + 16));
    // Scrolling up from the first shown loads the fifteen before it; down from the last, the fifteen after.
    const up = await chatroomPage(t.db, ctx, ids[0], 'before');
    expect(up.messages.map((m) => m.message_id)).toEqual(all.slice(at - 30, at - 15));
    const down = await chatroomPage(t.db, ctx, ids[ids.length - 1], 'after');
    expect(down.messages.map((m) => m.message_id)).toEqual(all.slice(at + 16, at + 31));
    // At the end of the chat there is no more.
    const end = await chatroomPage(t.db, ctx, all[all.length - 1], 'after');
    expect(end).toEqual({ messages: [], more: false });
  });
});

describe('Ask when Nemotron is slow or out of allowance', () => {
  const params = (extra: Record<string, string> = {}) => new URLSearchParams({ q: 'refresh tokens', chat: chatId, status: 'all', ...extra });

  it('searches the plain words at once and says Nemotron is still reading', async () => {
    const r = await ask(t.db, ctx, params(), async () => ({ pending: 'req-9' }));
    expect(r.interpretation_pending).toBe('req-9');
    expect(r.note).toMatch(/still reading/);
    expect(r.results.length).toBeGreaterThan(0);
  });

  it('says plainly when the allowance is used up', async () => {
    const r = await ask(t.db, ctx, params(), async () => ({ failed: 'budget_user' }));
    expect(r.interpretation_pending).toBeNull();
    expect(r.note).toMatch(/allowance .* used up/);
  });
});
