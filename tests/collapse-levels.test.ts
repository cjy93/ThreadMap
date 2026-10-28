import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { loadFixtureWorkspace } from '../src/fixtures/load';
import { collapseRedundantLevels } from '../src/server/ai/pipeline';
import { overlappingSubject, sameSubject } from '../src/server/ai/taxonomy';
import { loadTree, pathOf } from '../src/server/graph/tree';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// Repeated grouping and refinement stacked chains like "Software Development >
// Development > Software Development Practices > Software Development > ...".
// Levels that repeat their parent's subject are merged away; real narrowings stay.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t?.close());

describe('redundant levels', () => {
  it('tells a repeat from a narrowing', () => {
    expect(sameSubject('Software Development', 'software developments')).toBe(true);
    expect(sameSubject('Knowledge Root', 'Knowledge')).toBe(true);
    expect(overlappingSubject('Software Development', 'Development')).toBe(true);
    expect(overlappingSubject('Development Tools & Practices', 'Testing & Development Tools')).toBe(true);
    expect(overlappingSubject('Books', 'Programming books')).toBe(false);
    expect(overlappingSubject('Tips', 'Algorithms')).toBe(false);
  });

  it('flattens a chain of near-duplicate levels and keeps every message', async () => {
    const ws = (await ensurePrivateWorkspace(t.db, await createUser(t.db))).id;
    const { chatIdByKey } = await loadFixtureWorkspace(t.db, ws, { analyze: true });
    const chatId = chatIdByKey.builders;
    const [knowledge] = await t.db.select().from(s.topics).where(eq(s.topics.chatId, chatId)).then((r) => r.filter((x) => x.root === 'KNOWLEDGE' && x.kind === 'CATEGORY'));
    // Knowledge > Software Development > Development > Software Development > Development Tools & Practices > Testing & Development Tools (holds the messages)
    const titles = ['Software Development', 'Development', 'Software Development', 'Development Tools & Practices', 'Testing & Development Tools'];
    let parent = knowledge.id;
    const ids: string[] = [];
    for (const title of titles) {
      const [row] = await t.db.insert(s.topics).values({ workspaceId: ws, chatId, root: 'KNOWLEDGE', kind: 'TOPIC', parentId: parent, title, provenance: 'model' }).returning({ id: s.topics.id });
      ids.push(row.id);
      parent = row.id;
    }
    // Move one existing topic's messages and discussions into the deepest level.
    const donor = (await t.db.execute<{ id: string }>(sql`SELECT topic_id AS id FROM discussions WHERE chat_id = ${chatId}::uuid AND topic_id IS NOT NULL LIMIT 1`)).rows[0].id;
    await t.db.update(s.placements).set({ topicId: parent }).where(eq(s.placements.topicId, donor));
    await t.db.update(s.discussions).set({ topicId: parent }).where(eq(s.discussions.topicId, donor));
    await t.db.update(s.analysisUnits).set({ assignedTopicId: parent }).where(eq(s.analysisUnits.assignedTopicId, donor));
    const before = (await t.db.execute<{ n: number }>(sql`SELECT count(DISTINCT message_id)::int AS n FROM placements WHERE chat_id = ${chatId}::uuid`)).rows[0].n;

    const [chat] = await t.db.select().from(s.chats).where(eq(s.chats.id, chatId));
    expect(await collapseRedundantLevels(t.db, chat)).toBeGreaterThan(0);

    const tree = await loadTree(t.db, chatId);
    const live = ids.filter((id) => tree.nodes.has(id));
    // The five near-duplicate levels collapse to a short path.
    const holder = (await t.db.execute<{ id: string }>(sql`SELECT assigned_topic_id AS id FROM analysis_units WHERE chat_id = ${chatId}::uuid AND assigned_topic_id = ANY(ARRAY[${sql.join(live.map((id) => sql`${id}::uuid`), sql`, `)}]) LIMIT 1`)).rows[0]?.id;
    expect(holder).toBeDefined();
    const path = pathOf(tree, holder!).map((p) => p.title);
    expect(path.length).toBeLessThanOrEqual(3);
    expect(path[0]).toBe('Knowledge');
    // Nothing lost.
    expect((await t.db.execute<{ n: number }>(sql`SELECT count(DISTINCT message_id)::int AS n FROM placements WHERE chat_id = ${chatId}::uuid`)).rows[0].n).toBe(before);
    // The fixture's real narrowings are untouched.
    const titlesNow = [...tree.nodes.values()].map((n) => n.title);
    for (const kept of ['Hackathons', 'Solutions', 'Authentication', 'Tokens', 'Refresh flow']) expect(titlesNow, kept).toContain(kept);
  });
});
