import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixtureModelProvider } from '../src/fixtures/model';
import { fixtureLlmConfig, loadFixtureWorkspace } from '../src/fixtures/load';
import { drainJobs } from '../src/server/ai/drain';
import { rebuildMapFromScratch } from '../src/server/ai/pipeline';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// "Rebuild map" throws the tree away and builds it again from the discussions
// already read; every message ends up on the new map.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t?.close());

describe('rebuilding a map from scratch', () => {
  it('replaces every topic and places all messages again', async () => {
    const ws = (await ensurePrivateWorkspace(t.db, await createUser(t.db))).id;
    const { chatIdByKey, bundle } = await loadFixtureWorkspace(t.db, ws, { analyze: true });
    const chatId = chatIdByKey.builders;
    const count = async (q: ReturnType<typeof sql>) => (await t.db.execute<{ n: number }>(q)).rows[0].n;
    const placed = sql`SELECT count(DISTINCT message_id)::int AS n FROM placements WHERE chat_id = ${chatId}::uuid`;
    const topicIds = sql`SELECT count(*)::int AS n FROM topics WHERE chat_id = ${chatId}::uuid AND kind = 'TOPIC'`;
    const before = await count(placed);
    const oldTopics = (await t.db.execute<{ id: string }>(sql`SELECT id FROM topics WHERE chat_id = ${chatId}::uuid AND kind = 'TOPIC'`)).rows.map((r) => r.id);
    expect(oldTopics.length).toBeGreaterThan(0);

    const job = await rebuildMapFromScratch(t.db, chatId);
    expect(job).toBeTruthy();
    expect(await count(topicIds)).toBe(0);
    expect(await count(placed)).toBe(0);

    const ran = await drainJobs({ db: t.db, provider: new FixtureModelProvider(bundle.manifest), cfg: fixtureLlmConfig(), sleep: async () => undefined }, { chatIds: [chatId] });
    expect(ran.filter((j) => j.status !== 'completed')).toEqual([]);
    expect(await count(placed)).toBe(before);
    expect(await count(sql`SELECT count(*)::int AS n FROM analysis_units WHERE chat_id = ${chatId}::uuid AND assigned_topic_id IS NULL`)).toBe(0);
    // A new tree: none of the old topic ids survive.
    const survivors = await count(sql`SELECT count(*)::int AS n FROM topics WHERE id IN (${sql.join(oldTopics.map((id) => sql`${id}::uuid`), sql`, `)})`);
    expect(survivors).toBe(0);
  });
});
