import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadFixtureWorkspace } from '../src/fixtures/load';
import { listChatDays, type AuthCtx } from '../src/server/api/service';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// The date slider spans the days a chat has messages, with how many each day holds.
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

describe('messages per day for the date slider', () => {
  it('lists each day with messages once, oldest first, adding up to the chat', async () => {
    const r = await listChatDays(t.db, auth, chatId, new URLSearchParams({ tz: 'Asia/Singapore' }));
    expect(r.days.length).toBeGreaterThan(0);
    expect(r.days.map((d) => d.day)).toEqual([...r.days.map((d) => d.day)].sort());
    expect(new Set(r.days.map((d) => d.day)).size).toBe(r.days.length);
    const [{ n }] = (
      await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM messages WHERE chat_id = ${chatId}::uuid AND state = 'active' AND kind IN ('text', 'media') AND sent_at IS NOT NULL`)
    ).rows;
    expect(r.days.reduce((a, d) => a + d.n, 0)).toBe(n);
  });

  it('falls back to the default time zone for an unknown one', async () => {
    const r = await listChatDays(t.db, auth, chatId, new URLSearchParams({ tz: 'Not/AZone' }));
    expect(r.tz).not.toBe('Not/AZone');
  });
});
