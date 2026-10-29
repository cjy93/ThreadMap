import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { loadFixtureWorkspace } from '../src/fixtures/load';
import { courtesyOnlySql, isCourtesyOnly } from '../src/server/ai/smalltalk';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// "Done" and "Thank you" stayed on the map: the model kept "Done" as the answer to a request.
// Courtesy-only messages are now small talk by rule; anything with real content is not.
const SMALL = ['Done', 'Thank you!', 'thank u', 'ok noted 👍', 'Done ah', 'hahaha', '👍', 'Thanks so much!!', 'ok ok', 'Received, thanks', 'you know you are right', 'You are right!', 'same here', 'I agree 👍'];
const CONTENT = [
  'Mind adding dhui@nvidia.com too please thank you',
  'Can access now, thanks!',
  'yes',
  'no',
  'sure',
  'okay see you at 3',
  'Done: https://x.y/z',
  'Thanks, the slides are uploaded',
  '',
  // Agreement that goes on to say something is content.
  'you are right about desktop version. but then the hackathon requirement how',
  'I see the problem: the port is closed',
  'you know the venue?',
];

describe('courtesy-only messages are small talk', () => {
  it.each(SMALL)('%s', (body) => expect(isCourtesyOnly(body)).toBe(true));
  it.each(CONTENT)('not: %s', (body) => expect(isCourtesyOnly(body)).toBe(false));
});

let t: TestDb;
let chatId: string;
beforeAll(async () => {
  t = await createTestDb();
  const ws = await ensurePrivateWorkspace(t.db, await createUser(t.db));
  chatId = (await loadFixtureWorkspace(t.db, ws.id, { analyze: false })).chatIdByKey.builders;
});
afterAll(async () => t?.close());

describe('the same rule in the database', () => {
  it('SQL agrees with the code on every sample', async () => {
    for (const body of [...SMALL, ...CONTENT]) {
      const r = await t.db.execute<{ c: boolean }>(sql`SELECT ${courtesyOnlySql()} AS c FROM (SELECT 'text'::text AS kind, ${body}::text AS body) m`);
      expect([body, r.rows[0].c]).toEqual([body, isCourtesyOnly(body)]);
    }
  });

  it('migration 0015 flags courtesy-only messages already read, and nothing else', async () => {
    const rows = (await t.db.execute<{ id: string }>(sql`SELECT id FROM messages WHERE chat_id = ${chatId}::uuid AND kind = 'text' ORDER BY sent_at, id LIMIT 2`)).rows;
    await t.db.update(s.messages).set({ body: 'Done', filler: false }).where(eq(s.messages.id, rows[0].id));
    await t.db.update(s.messages).set({ body: 'Can access now, thanks!', filler: false }).where(eq(s.messages.id, rows[1].id));
    await t.db.execute(sql.raw(readFileSync('src/db/migrations/0015_courtesy_small_talk.sql', 'utf8')));
    const after = await t.db.select({ id: s.messages.id, filler: s.messages.filler }).from(s.messages).where(sql`${s.messages.id} IN (${rows[0].id}::uuid, ${rows[1].id}::uuid)`);
    const filler = new Map(after.map((m) => [m.id, m.filler]));
    expect(filler.get(rows[0].id)).toBe(true);
    expect(filler.get(rows[1].id)).toBe(false);
  });

  it('migration 0018 clears what the old rule flagged for a re-check, but keeps courtesy-only small talk', async () => {
    const rows = (await t.db.execute<{ id: string }>(sql`SELECT id FROM messages WHERE chat_id = ${chatId}::uuid AND kind = 'text' ORDER BY sent_at, id LIMIT 2`)).rows;
    await t.db.update(s.messages).set({ body: 'Done', filler: true }).where(eq(s.messages.id, rows[0].id));
    await t.db.update(s.messages).set({ body: 'ya he uses claude', filler: true }).where(eq(s.messages.id, rows[1].id));
    await t.db.execute(sql.raw(readFileSync('src/db/migrations/0018_rescreen_small_talk.sql', 'utf8')));
    const after = await t.db.select({ id: s.messages.id, filler: s.messages.filler }).from(s.messages).where(sql`${s.messages.id} IN (${rows[0].id}::uuid, ${rows[1].id}::uuid)`);
    const filler = new Map(after.map((m) => [m.id, m.filler]));
    expect(filler.get(rows[0].id)).toBe(true);
    // Screened again by the next build, under the new rule.
    expect(filler.get(rows[1].id)).toBeNull();
  });
});
