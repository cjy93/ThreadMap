import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { loadFixtureWorkspace } from '../src/fixtures/load';
import { getMap, type AuthCtx } from '../src/server/api/service';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// A chat at the per-chat history limit: "Load older messages" becomes "Max limit reached".
let t: TestDb;
let auth: AuthCtx;
let chatId: string;
beforeAll(async () => {
  t = await createTestDb();
  const ws = await ensurePrivateWorkspace(t.db, await createUser(t.db));
  chatId = (await loadFixtureWorkspace(t.db, ws.id, { analyze: false })).chatIdByKey.builders;
  auth = { userId: ws.ownerUserId, workspaceId: ws.id, mode: 'private' };
});
afterAll(async () => t?.close());

describe('history limit on the map', () => {
  it('reports the limit only once the chat has reached it', async () => {
    const params = new URLSearchParams({ status: 'all' });
    await t.db.update(s.syncCoverage).set({ historyState: 'receiving' }).where(eq(s.syncCoverage.chatId, chatId));
    expect((await getMap(t.db, auth, chatId, params)).history_limited).toBeNull();
    await t.db.update(s.syncCoverage).set({ historyState: 'limited', historyCount: 3000 }).where(eq(s.syncCoverage.chatId, chatId));
    expect((await getMap(t.db, auth, chatId, params)).history_limited).toBe(3000);
  });
});
