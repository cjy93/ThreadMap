import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { fixtureLlmConfig, loadFixtureWorkspace } from '../src/fixtures/load';
import { regroupTopics } from '../src/server/ai/pipeline';
import type { CompletionRequest, ModelProvider } from '../src/server/ai/provider';
import { ensureLedger } from '../src/server/ai/router';
import { PIPELINE_VERSION } from '../src/server/ai/schemas';
import { loadTree } from '../src/server/graph/tree';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// Projects built for one hackathon end up as separate siblings when a long chat
// is mapped in slices; the regroup pass moves them under their broader subject.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t?.close());

/** Stands in for Nemotron Super: groups the hackathon projects under the existing "Hackathon" topic. */
class GroupingProvider implements ModelProvider {
  readonly kind = 'nebius' as const;
  seen: { key: string; title: string }[] = [];
  modelIdFor() {
    return 'stub-balanced';
  }
  async complete(req: CompletionRequest) {
    const input = JSON.parse(req.user) as { topics: { key: string; title: string }[] };
    this.seen = input.topics;
    const key = (title: string) => input.topics.find((x) => x.title === title)!.key;
    const groups = [{ title: 'Hackathon', children: [key('Hackathon'), key('Uprabbit Tool'), key('Uprabbit and video features'), key('ThreadMap tool')] }];
    return { text: JSON.stringify({ groups }), modelId: 'stub-balanced', fallback: false, usage: { input: 100, output: 50, reasoning: null } };
  }
}

describe('regrouping related sibling topics', () => {
  it('moves projects under the existing broader topic and leaves unrelated ones', async () => {
    const ws = (await ensurePrivateWorkspace(t.db, await createUser(t.db))).id;
    const { chatIdByKey } = await loadFixtureWorkspace(t.db, ws, { analyze: false });
    const chatId = chatIdByKey.builders;
    const [knowledge] = await t.db.select().from(s.topics).where(eq(s.topics.chatId, chatId)).then((r) => r.filter((x) => x.root === 'KNOWLEDGE' && x.kind === 'CATEGORY'));
    const titles = ['Hackathon', 'Uprabbit Tool', 'Uprabbit and video features', 'ThreadMap tool', 'Cooking', 'Travel plans'];
    for (const title of titles) await t.db.insert(s.topics).values({ workspaceId: ws, chatId, root: 'KNOWLEDGE', kind: 'TOPIC', parentId: knowledge.id, title, provenance: 'model' });

    const [chat] = await t.db.select().from(s.chats).where(eq(s.chats.id, chatId));
    const logicalJobId = crypto.randomUUID();
    const cfg = fixtureLlmConfig();
    await ensureLedger(t.db, ws, logicalJobId, cfg);
    const [job] = await t.db
      .insert(s.analysisJobs)
      .values({ workspaceId: ws, chatId, kind: 'rebuild', logicalJobId, inputFingerprint: `regroup-test-${logicalJobId}`, inputMessages: [], pipelineVersion: PIPELINE_VERSION, deletionGeneration: chat.deletionGeneration, selectionEpoch: chat.selectionEpoch })
      .returning();
    const provider = new GroupingProvider();
    const moved = await regroupTopics({ db: t.db, provider, cfg, sleep: async () => undefined }, job, chat);

    expect(moved).toBe(3);
    expect(provider.seen.map((x) => x.title).sort()).toEqual([...titles].sort());
    const tree = await loadTree(t.db, chatId);
    const byTitle = (title: string) => [...tree.nodes.values()].find((n) => n.title === title)!;
    const hackathon = byTitle('Hackathon');
    expect(hackathon.parentId).toBe(knowledge.id);
    for (const p of ['Uprabbit Tool', 'Uprabbit and video features', 'ThreadMap tool']) expect(byTitle(p).parentId, p).toBe(hackathon.id);
    for (const p of ['Cooking', 'Travel plans']) expect(byTitle(p).parentId, p).toBe(knowledge.id);
  });

  it('brings a level of more than 6 topics back to at most 6, even when the model groups nothing', async () => {
    const ws = (await ensurePrivateWorkspace(t.db, await createUser(t.db))).id;
    const { chatIdByKey } = await loadFixtureWorkspace(t.db, ws, { analyze: false });
    const chatId = chatIdByKey.builders;
    const [knowledge] = await t.db.select().from(s.topics).where(eq(s.topics.chatId, chatId)).then((r) => r.filter((x) => x.root === 'KNOWLEDGE' && x.kind === 'CATEGORY'));
    for (let i = 1; i <= 14; i++) await t.db.insert(s.topics).values({ workspaceId: ws, chatId, root: 'KNOWLEDGE', kind: 'TOPIC', parentId: knowledge.id, title: `Subject ${i}`, provenance: 'model' });
    const [chat] = await t.db.select().from(s.chats).where(eq(s.chats.id, chatId));
    const logicalJobId = crypto.randomUUID();
    const cfg = fixtureLlmConfig();
    await ensureLedger(t.db, ws, logicalJobId, cfg);
    const [job] = await t.db
      .insert(s.analysisJobs)
      .values({ workspaceId: ws, chatId, kind: 'rebuild', logicalJobId, inputFingerprint: `cap-test-${logicalJobId}`, inputMessages: [], pipelineVersion: PIPELINE_VERSION, deletionGeneration: chat.deletionGeneration, selectionEpoch: chat.selectionEpoch })
      .returning();
    const prompts: string[] = [];
    const provider: ModelProvider = {
      kind: 'nebius',
      modelIdFor: () => 'stub-balanced',
      complete: async (req: CompletionRequest) => {
        prompts.push(req.system);
        return { text: JSON.stringify({ groups: [] }), modelId: 'stub-balanced', fallback: false, usage: { input: 100, output: 10, reasoning: null } };
      },
    };
    await regroupTopics({ db: t.db, provider, cfg, sleep: async () => undefined }, job, chat);

    // The model was told the level must shrink to 6.
    expect(prompts[0]).toContain('at most 6');
    const tree = await loadTree(t.db, chatId);
    const level = tree.nodes.get(knowledge.id)!.childIds.map((c) => tree.nodes.get(c)!);
    expect(level.length).toBeLessThanOrEqual(6);
    const other = level.find((n) => n.title === 'Other topics')!;
    expect(other.childIds.length).toBeGreaterThan(0);
    // Nothing lost: every subject is still in the tree.
    expect([...tree.nodes.values()].filter((n) => n.title.startsWith('Subject ')).length).toBe(14);
  });
});
