import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { fixtureLlmConfig, loadFixtureWorkspace } from '../src/fixtures/load';
import { FixtureModelProvider } from '../src/fixtures/model';
import { drainJobs } from '../src/server/ai/drain';
import { rebuildMapFromScratch } from '../src/server/ai/pipeline';
import type { CompletionRequest, ModelProvider } from '../src/server/ai/provider';
import { loadTree, pathOf } from '../src/server/graph/tree';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// Technical talk in a chatty tone ("32 gb ram to test unity") was filed under
// General Chat. Rebuild map re-checks each discussion's root first, so it lands
// under Knowledge.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t?.close());

describe('root re-check on Rebuild map', () => {
  it('moves a misfiled discussion to its right root before the map is built', async () => {
    const ws = (await ensurePrivateWorkspace(t.db, await createUser(t.db))).id;
    const { chatIdByKey, bundle } = await loadFixtureWorkspace(t.db, ws, { analyze: true });
    const chatId = chatIdByKey.builders;
    // A Knowledge discussion as an older rubric might have filed it.
    const [unit] = await t.db.select().from(s.analysisUnits).where(eq(s.analysisUnits.chatId, chatId)).then((u) => u.filter((x) => x.primaryRoot === 'KNOWLEDGE' && x.messageRefs.length >= 2));
    await t.db.update(s.analysisUnits).set({ primaryRoot: 'GENERAL_CHAT', summaryBullets: { ...(unit.summaryBullets as object), title: 'GPU and RAM for agents' } }).where(eq(s.analysisUnits.id, unit.id));

    const inner = new FixtureModelProvider(bundle.manifest);
    const seen: string[] = [];
    const provider: ModelProvider = {
      kind: 'fixture',
      modelIdFor: (r) => inner.modelIdFor(r),
      complete: async (req: CompletionRequest) => {
        if (req.operation === 'roots') {
          const input = JSON.parse(req.user) as { discussions: { key: string; title: string; root: string }[] };
          seen.push(...input.discussions.map((d) => d.title));
          const roots = input.discussions.filter((d) => d.title === 'GPU and RAM for agents' && d.root === 'GENERAL_CHAT').map((d) => ({ key: d.key, root: 'KNOWLEDGE' }));
          return { text: JSON.stringify({ roots }), modelId: 'stub', fallback: false, usage: { input: 50, output: 10, reasoning: null } };
        }
        return inner.complete(req);
      },
    };
    await rebuildMapFromScratch(t.db, chatId);
    await drainJobs({ db: t.db, provider, cfg: fixtureLlmConfig(), sleep: async () => undefined }, { chatIds: [chatId] });

    expect(seen).toContain('GPU and RAM for agents');
    const [after] = await t.db.select().from(s.analysisUnits).where(eq(s.analysisUnits.id, unit.id));
    expect(after.primaryRoot).toBe('KNOWLEDGE');
    expect(after.assignedTopicId).not.toBeNull();
    const tree = await loadTree(t.db, chatId);
    expect(pathOf(tree, after.assignedTopicId!)[0].title).toBe('Knowledge');
    // No discussion is left unplaced.
    const left = await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM analysis_units WHERE chat_id = ${chatId}::uuid AND assigned_topic_id IS NULL`);
    expect(left.rows[0].n).toBe(0);
  });
});
