import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadFixtureWorkspace } from '../src/fixtures/load';
import { resumeStrandedBuilds } from '../src/server/ai/pipeline';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// A map build that failed partway (e.g. a provider error) leaves messages off
// the map. The worker resumes it on its own, a bounded number of times.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t?.close());

describe('resuming a failed map build', () => {
  it('queues one rebuild for unplaced units after a failure, then stops after repeated failures', async () => {
    const ws = (await ensurePrivateWorkspace(t.db, await createUser(t.db))).id;
    const { chatIdByKey } = await loadFixtureWorkspace(t.db, ws, { analyze: true });
    const chatId = chatIdByKey.builders;
    // Nothing to resume while everything is placed.
    expect(await resumeStrandedBuilds(t.db)).toEqual([]);

    await t.db.execute(sql`UPDATE analysis_units SET assigned_topic_id = NULL WHERE id IN (SELECT id FROM analysis_units WHERE chat_id = ${chatId}::uuid LIMIT 5)`);
    // The latest rebuild (and anything queued) failed; every job finished over two minutes ago.
    const fail = async () => {
      await t.db.execute(sql`UPDATE analysis_jobs SET status = 'failed'
        WHERE chat_id = ${chatId}::uuid AND (status IN ('pending', 'running') OR id = (SELECT id FROM analysis_jobs WHERE chat_id = ${chatId}::uuid AND kind = 'rebuild' ORDER BY created_at DESC LIMIT 1))`);
      await t.db.execute(sql`UPDATE analysis_jobs SET created_at = created_at - interval '3 minutes', started_at = started_at - interval '3 minutes', completed_at = coalesce(completed_at, now()) - interval '3 minutes' WHERE chat_id = ${chatId}::uuid`);
    };
    await fail();
    const first = await resumeStrandedBuilds(t.db);
    expect(first).toHaveLength(1);
    // Already queued: not queued again.
    expect(await resumeStrandedBuilds(t.db)).toEqual([]);

    // Keeps failing: retried up to the limit, then left for Refresh.
    let resumes = 1;
    for (let i = 0; i < 5; i++) {
      await fail();
      resumes += (await resumeStrandedBuilds(t.db)).length;
    }
    expect(resumes).toBeLessThanOrEqual(3);
    expect(await resumeStrandedBuilds(t.db)).toEqual([]);
  });
});
