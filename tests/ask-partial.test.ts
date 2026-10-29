import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { loadFixtureWorkspace } from '../src/fixtures/load';
import { ask } from '../src/server/api/ask';
import type { AuthCtx } from '../src/server/api/service';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { normalizeSearch } from '../src/server/util';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// Asked "Clip", Ask missed the message "LiceClip": Nemotron added many hackathon terms,
// messages matching several of them outranked it, and a bare "LiceClip" said nothing
// about what it was. A typed word now outweighs added terms, matches inside a word,
// and every result carries the messages around it.
let t: TestDb;
let auth: AuthCtx;
let chatId: string;
const ids: Record<string, string> = {};
beforeAll(async () => {
  t = await createTestDb();
  const ws = await ensurePrivateWorkspace(t.db, await createUser(t.db));
  const r = await loadFixtureWorkspace(t.db, ws.id, { analyze: false });
  chatId = r.chatIdByKey.builders;
  auth = { userId: ws.ownerUserId, workspaceId: ws.id, mode: 'private' };
  const rows = (await t.db.execute<{ id: string }>(sql`SELECT id FROM messages WHERE chat_id = ${chatId}::uuid AND body IS NOT NULL ORDER BY sent_at, id LIMIT 8`)).rows;
  const set = async (k: string, i: number, body: string) => {
    ids[k] = rows[i].id;
    await t.db.update(s.messages).set({ body, searchText: normalizeSearch(body), filler: false }).where(eq(s.messages.id, rows[i].id));
  };
  await set('tool', 0, 'LiceClip');
  await set('question', 1, 'What is this for? your animation or videorecording');
  for (let i = 2; i < 8; i++) await set(`noise${i}`, i, 'hackathon demo project showcase judges');
  // The question answers the tool message (as Nemotron's inferred replies record it).
  await t.db.update(s.messages).set({ inferredReplyTo: ids.tool }).where(eq(s.messages.id, ids.question));
});
afterAll(async () => t?.close());

const params = (q: string) => new URLSearchParams({ q, chat: chatId, status: 'all' });
const clipReading = async () => ({ interpretation: 'Clip, in the hackathon context', terms: ['clip', 'hackathon', 'demo', 'project', 'showcase'], topicIds: [] });

describe('Ask: part of a word, ranked by what was typed, with context', () => {
  it('finds "LiceClip" from "Clip" and ranks it above messages matching many added terms', async () => {
    const r = await ask(t.db, auth, params('Clip'), clipReading);
    expect(r.results[0].message_id).toBe(ids.tool);
  });

  it('gives each result the message around it, so a bare name says what it was about', async () => {
    const r = await ask(t.db, auth, params('Clip'), clipReading);
    const tool = r.results.find((x) => x.message_id === ids.tool)!;
    expect(tool.context.after).toMatchObject({ rel: 'reply', text: expect.stringContaining('What is this for') });
  });
});
