import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixtureModelProvider } from '../src/fixtures/model';
import { drainJobs } from '../src/server/ai/drain';
import { fixtureLlmConfig, loadFixtureWorkspace } from '../src/fixtures/load';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// A long chat yields more discussion units than one taxonomy or assignment call
// can hold. The map must still be built, through several smaller calls, instead
// of one oversized prompt that the router refuses ("caller must split input").
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t?.close());

describe('map building for chats larger than one model call', () => {
  it('places every unit when the input limit only fits a few units per call', async () => {
    const ws = (await ensurePrivateWorkspace(t.db, await createUser(t.db))).id;
    const { chatIdByKey, bundle } = await loadFixtureWorkspace(t.db, ws, { analyze: false });
    const calls: string[] = [];
    const cfg = { ...fixtureLlmConfig(), LLM_MAX_INPUT_TOKENS_PER_CALL: 2500 };
    const ran = await drainJobs(
      { db: t.db, provider: new FixtureModelProvider(bundle.manifest), cfg, sleep: async () => undefined, onCall: (_r, op) => calls.push(op) },
      { chatIds: [chatIdByKey.builders] },
    );
    expect(ran.filter((j) => j.status !== 'completed')).toEqual([]);
    const left = await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM analysis_units WHERE chat_id = ${chatIdByKey.builders}::uuid AND assigned_topic_id IS NULL`);
    expect(left.rows[0].n).toBe(0);
    const placed = await t.db.execute<{ n: number }>(sql`SELECT count(DISTINCT message_id)::int AS n FROM placements WHERE chat_id = ${chatIdByKey.builders}::uuid`);
    expect(placed.rows[0].n).toBeGreaterThan(100);
    // The initial taxonomy no longer fits one call, so placement continues in batches.
    expect(calls.filter((op) => op === 'taxonomy' || op.startsWith('assign')).length).toBeGreaterThan(1);
  });

  it('still builds when the existing topic list alone would overflow one call', async () => {
    const ws = (await ensurePrivateWorkspace(t.db, await createUser(t.db))).id;
    const { chatIdByKey, bundle } = await loadFixtureWorkspace(t.db, ws, { analyze: false });
    const chatId = chatIdByKey.builders;
    // A long chat's map: hundreds of topics with long paths.
    const [knowledge] = (await t.db.execute<{ id: string; workspace_id: string }>(sql`SELECT id, workspace_id FROM topics WHERE chat_id = ${chatId}::uuid AND kind = 'CATEGORY' AND root = 'KNOWLEDGE'`)).rows;
    for (let i = 0; i < 400; i++) {
      await t.db.execute(sql`INSERT INTO topics (workspace_id, chat_id, root, kind, parent_id, title, provenance) VALUES (${ws}::uuid, ${chatId}::uuid, 'KNOWLEDGE', 'TOPIC', ${knowledge.id}::uuid, ${`Existing subject number ${i} about a fairly long descriptive title`}, 'model')`);
    }
    const cfg = { ...fixtureLlmConfig(), LLM_MAX_INPUT_TOKENS_PER_CALL: 2500 };
    const ran = await drainJobs({ db: t.db, provider: new FixtureModelProvider(bundle.manifest), cfg, sleep: async () => undefined }, { chatIds: [chatId] });
    expect(ran.filter((j) => j.status !== 'completed')).toEqual([]);
    const left = await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM analysis_units WHERE chat_id = ${chatId}::uuid AND assigned_topic_id IS NULL`);
    expect(left.rows[0].n).toBe(0);
  });
});
