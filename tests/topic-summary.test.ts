import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadFixtureWorkspace } from '../src/fixtures/load';
import { getNodeContent } from '../src/server/api/service';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// Grouping and refinement leave parent topics with no discussions of their own;
// their summary still shows what the discussions beneath them found.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t?.close());

describe('topic summaries', () => {
  it('a parent topic shows the summary points of the discussions beneath it', async () => {
    const userId = await createUser(t.db);
    const ws = (await ensurePrivateWorkspace(t.db, userId)).id;
    const { chatIdByKey } = await loadFixtureWorkspace(t.db, ws, { analyze: true });
    const chatId = chatIdByKey.builders;
    // A topic that holds no discussion itself but has some beneath it.
    const parent = (
      await t.db.execute<{ id: string }>(sql`
        SELECT t.id FROM topics t WHERE t.chat_id = ${chatId}::uuid AND t.kind = 'TOPIC'
          AND NOT EXISTS (SELECT 1 FROM discussions d WHERE d.topic_id = t.id)
          AND EXISTS (SELECT 1 FROM topics c JOIN discussions d ON d.topic_id = c.id JOIN summary_claims sc ON sc.discussion_id = d.id AND sc.valid WHERE c.parent_id = t.id)
        LIMIT 1`)
    ).rows[0];
    expect(parent, 'fixture has a parent topic without its own discussions').toBeDefined();
    const ctx = { userId, workspaceId: ws, mode: 'private' as const };
    const r = await getNodeContent(t.db, ctx, chatId, parent.id, new URLSearchParams({ status: 'all' }));
    expect(r.summary.available).toBe(true);
    expect(r.summary.claims.length).toBeGreaterThan(0);
  });
});
