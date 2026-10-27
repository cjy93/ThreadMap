import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { fixtureLlmConfig, loadFixtureWorkspace } from '../src/fixtures/load';
import { splitCompoundTopics } from '../src/server/ai/pipeline';
import type { CompletionRequest, ModelProvider } from '../src/server/ai/provider';
import { ensureLedger } from '../src/server/ai/router';
import { PIPELINE_VERSION } from '../src/server/ai/schemas';
import { loadTree } from '../src/server/graph/tree';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// A topic should name one subject: "Academic and Career Guidance" becomes
// "Academic" and "Career", each holding its share of the discussions.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t?.close());

async function setup(title: string) {
  const ws = (await ensurePrivateWorkspace(t.db, await createUser(t.db))).id;
  const { chatIdByKey } = await loadFixtureWorkspace(t.db, ws, { analyze: true });
  const chatId = chatIdByKey.builders;
  // The topic holding the most discussions directly is renamed to a compound title.
  const top = await t.db.execute<{ id: string }>(sql`SELECT assigned_topic_id AS id FROM analysis_units WHERE chat_id = ${chatId}::uuid GROUP BY 1 HAVING count(*) >= 2 ORDER BY count(*) DESC LIMIT 1`);
  const topicId = top.rows[0].id;
  await t.db.update(s.topics).set({ title }).where(eq(s.topics.id, topicId));
  const [chat] = await t.db.select().from(s.chats).where(eq(s.chats.id, chatId));
  const logicalJobId = crypto.randomUUID();
  const cfg = fixtureLlmConfig();
  await ensureLedger(t.db, ws, logicalJobId, cfg);
  const [job] = await t.db
    .insert(s.analysisJobs)
    .values({ workspaceId: ws, chatId, kind: 'rebuild', logicalJobId, inputFingerprint: `split-test-${logicalJobId}`, inputMessages: [], pipelineVersion: PIPELINE_VERSION, deletionGeneration: chat.deletionGeneration, selectionEpoch: chat.selectionEpoch })
    .returning();
  return { chatId, topicId, chat, job, cfg };
}

/** Stands in for Nemotron Super: first half of the discussions are academic, the rest career. */
function splitter(answer: 'split' | 'keep'): ModelProvider {
  return {
    kind: 'nebius',
    modelIdFor: () => 'stub-balanced',
    complete: async (req: CompletionRequest) => {
      const input = JSON.parse(req.user) as { subtopics: { key: string }[]; discussions: { key: string }[] };
      const half = Math.ceil(input.discussions.length / 2);
      const parts =
        answer === 'keep'
          ? []
          : [
              { title: 'Academic', unit_subtopic: 'Academic guidance', children: input.subtopics.map((c) => c.key), units: input.discussions.slice(0, half).map((d) => d.key) },
              { title: 'Career', unit_subtopic: 'Career guidance', children: [], units: input.discussions.slice(half).map((d) => d.key) },
            ];
      return { text: JSON.stringify({ parts }), modelId: 'stub-balanced', fallback: false, usage: { input: 100, output: 50, reasoning: null } };
    },
  };
}

const placedUnder = async (chatId: string) =>
  (await t.db.execute<{ n: number }>(sql`SELECT count(DISTINCT message_id)::int AS n FROM placements WHERE chat_id = ${chatId}::uuid`)).rows[0].n;

describe('splitting topics that join several subjects', () => {
  it('turns "Academic and Career Guidance" into Academic > Academic guidance and Career > Career guidance', async () => {
    const { chatId, topicId, chat, job, cfg } = await setup('Academic and Career Guidance');
    const before = await placedUnder(chatId);
    const oldParent = (await loadTree(t.db, chatId)).nodes.get(topicId)!.parentId;
    const n = await splitCompoundTopics({ db: t.db, provider: splitter('split'), cfg, sleep: async () => undefined }, job, chat);
    expect(n).toBe(1);

    const tree = await loadTree(t.db, chatId);
    expect(tree.nodes.has(topicId)).toBe(false); // retired
    const byTitle = (title: string) => [...tree.nodes.values()].find((x) => x.title === title)!;
    for (const [part, sub] of [['Academic', 'Academic guidance'], ['Career', 'Career guidance']]) {
      expect(byTitle(part).parentId, part).toBe(oldParent);
      expect(byTitle(sub).parentId, sub).toBe(byTitle(part).id);
      const units = await t.db.select().from(s.analysisUnits).where(eq(s.analysisUnits.assignedTopicId, byTitle(sub).id));
      expect(units.length, sub).toBeGreaterThan(0);
    }
    // No message lost, none left on the retired topic.
    expect(await placedUnder(chatId)).toBe(before);
    const left = await t.db.select().from(s.placements).where(eq(s.placements.topicId, topicId));
    expect(left).toEqual([]);
  });

  it('leaves a title that names one subject ("Research and Development")', async () => {
    const { chatId, topicId, chat, job, cfg } = await setup('Research and Development');
    const n = await splitCompoundTopics({ db: t.db, provider: splitter('keep'), cfg, sleep: async () => undefined }, job, chat);
    expect(n).toBe(0);
    expect((await loadTree(t.db, chatId)).nodes.get(topicId)?.title).toBe('Research and Development');
  });
});
