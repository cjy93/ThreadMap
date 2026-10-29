import { inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { loadFixtureWorkspace } from '../src/fixtures/load';
import { listSmallTalk, type AuthCtx } from '../src/server/api/service';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// Small talk stays off the map, but the owner can list it to check nothing important went.
let t: TestDb;
let auth: AuthCtx;
let chatId: string;
let filler: string[];
beforeAll(async () => {
  t = await createTestDb();
  const ws = await ensurePrivateWorkspace(t.db, await createUser(t.db));
  const r = await loadFixtureWorkspace(t.db, ws.id, { analyze: false });
  chatId = r.chatIdByKey.builders;
  auth = { userId: ws.ownerUserId, workspaceId: ws.id, mode: 'private' };
  await t.db.update(s.messages).set({ filler: false }).where(sql`chat_id = ${chatId}::uuid`);
  filler = (await t.db.execute<{ id: string }>(sql`SELECT id FROM messages WHERE chat_id = ${chatId}::uuid AND body IS NOT NULL AND state = 'active' ORDER BY sent_at DESC, id DESC LIMIT 3`)).rows.map((x) => x.id);
  await t.db.update(s.messages).set({ filler: true }).where(inArray(s.messages.id, filler));
});
afterAll(async () => t?.close());

describe('small talk left off the map', () => {
  it('lists exactly the small-talk messages, newest first', async () => {
    const r = await listSmallTalk(t.db, auth, chatId, new URLSearchParams());
    expect(r.total).toBe(3);
    expect(r.next_offset).toBeNull();
    expect(r.messages.map((m) => m.message_id)).toEqual(filler);
  });

  it("does not list another account's chat", async () => {
    const other = await ensurePrivateWorkspace(t.db, await createUser(t.db));
    const stranger: AuthCtx = { userId: other.ownerUserId, workspaceId: other.id, mode: 'private' };
    await expect(listSmallTalk(t.db, stranger, chatId, new URLSearchParams())).rejects.toThrow();
  });
});
