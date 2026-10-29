import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixtureModelProvider } from '../src/fixtures/model';
import { fixtureLlmConfig, loadFixtureWorkspace } from '../src/fixtures/load';
import { drainJobs } from '../src/server/ai/drain';
import { rereadChatFromScratch } from '../src/server/ai/pipeline';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// "Re-read chat": unlike Rebuild map, the discussions are read again too (under the
// current reading rules), then the map is built fresh; every message ends up on it.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t?.close());

describe('re-reading a chat from scratch', () => {
  it('reads every message again, makes new discussions, and maps them all', async () => {
    const ws = (await ensurePrivateWorkspace(t.db, await createUser(t.db))).id;
    const { chatIdByKey, bundle } = await loadFixtureWorkspace(t.db, ws, { analyze: true });
    const chatId = chatIdByKey.builders;
    const count = async (q: ReturnType<typeof sql>) => (await t.db.execute<{ n: number }>(q)).rows[0].n;
    const placed = sql`SELECT count(DISTINCT message_id)::int AS n FROM placements WHERE chat_id = ${chatId}::uuid`;
    const before = await count(placed);
    const oldUnits = (await t.db.execute<{ id: string }>(sql`SELECT id FROM analysis_units WHERE chat_id = ${chatId}::uuid`)).rows.map((r) => r.id);
    expect(oldUnits.length).toBeGreaterThan(0);
    const readable = await count(sql`SELECT count(*)::int AS n FROM messages WHERE chat_id = ${chatId}::uuid AND state = 'active' AND kind IN ('text', 'media')`);

    expect(await rereadChatFromScratch(t.db, chatId)).toBe(true);
    // Nothing of the old map or reading is left; every message waits to be read again.
    expect(await count(sql`SELECT count(*)::int AS n FROM topics WHERE chat_id = ${chatId}::uuid AND kind = 'TOPIC'`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM analysis_units WHERE chat_id = ${chatId}::uuid`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM analysis_outbox WHERE chat_id = ${chatId}::uuid AND dispatched_job_id IS NULL`)).toBe(readable);

    const ran = await drainJobs({ db: t.db, provider: new FixtureModelProvider(bundle.manifest), cfg: fixtureLlmConfig(), sleep: async () => undefined }, { chatIds: [chatId] });
    expect(ran.filter((j) => j.status !== 'completed')).toEqual([]);
    expect(await count(placed)).toBe(before);
    // New discussions: none of the old ones survive.
    const survivors = await count(sql`SELECT count(*)::int AS n FROM analysis_units WHERE id IN (${sql.join(oldUnits.map((id) => sql`${id}::uuid`), sql`, `)})`);
    expect(survivors).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM analysis_units WHERE chat_id = ${chatId}::uuid`)).toBeGreaterThan(0);
  });
});
