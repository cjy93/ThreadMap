import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { ask } from '../src/server/api/ask';
import { loadFixtureWorkspace } from '../src/fixtures/load';
import type { AuthCtx } from '../src/server/api/service';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { normalizeSearch } from '../src/server/util';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// Asked "Clip", then picked "licecap" from the words found: "LiceClip" (one letter off)
// came back as a near spelling, labelled by the question as an exact match. Picked words
// now group the results: messages with the word first, near spellings after them.
let t: TestDb;
let auth: AuthCtx;
let chatId: string;
const ids: Record<string, string> = {};
beforeAll(async () => {
  t = await createTestDb();
  const ws = await ensurePrivateWorkspace(t.db, await createUser(t.db));
  chatId = (await loadFixtureWorkspace(t.db, ws.id, { analyze: false })).chatIdByKey.builders;
  auth = { userId: ws.ownerUserId, workspaceId: ws.id, mode: 'private' };
  const rows = (await t.db.execute<{ id: string }>(sql`SELECT id FROM messages WHERE chat_id = ${chatId}::uuid AND body IS NOT NULL ORDER BY sent_at, id LIMIT 3`)).rows;
  const set = async (k: string, i: number, body: string) => {
    ids[k] = rows[i].id;
    await t.db.update(s.messages).set({ body, searchText: normalizeSearch(body), filler: false }).where(eq(s.messages.id, rows[i].id));
  };
  await set('clip', 0, 'LiceClip');
  await set('licecap', 1, 'Licecap is gif');
  await set('tool', 2, 'The gif recording tool is licecap I say wrong');
});
afterAll(async () => t?.close());

const never = async () => {
  throw new Error('picking a word must not ask the model again');
};
const pick = (words: string[], only: boolean) =>
  ask(t.db, auth, new URLSearchParams({ q: 'Clip', chat: chatId, status: 'all', terms_json: JSON.stringify(words), ...(only ? { only: '1' } : {}) }), never);

describe('Ask: a word picked from the list', () => {
  it('shows messages with the word first, then near spellings', async () => {
    const r = await pick(['licecap'], true);
    const order = r.results.map((x) => x.message_id);
    expect(order.slice(0, 2).sort()).toEqual([ids.licecap, ids.tool].sort());
    expect(r.results.slice(0, 2).every((x) => x.match === 'exact')).toBe(true);
    // "LiceClip" is a near spelling: after them, in the last group.
    const clip = r.results.find((x) => x.message_id === ids.clip);
    expect(clip?.match).toBe('meaning');
    expect(order.indexOf(ids.clip)).toBeGreaterThan(1);
  });
});
