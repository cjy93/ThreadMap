import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureLlmConfig, loadFixtureWorkspace } from '../src/fixtures/load';
import type { CompletionRequest, ModelProvider } from '../src/server/ai/provider';
import { cleanQuery, type WebSearch } from '../src/server/ai/websearch';
import { buildStudyMap, getStudyMap, startStudyMap } from '../src/server/api/studymap';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// Concept map: Nemotron Ultra reads the opened message's branch (from everyone) up
// to the root, searches the web with cleaned queries, and every concept cites
// only real messages and pages.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t?.close());

const placedUnder = (chatId: string, root: string) =>
  t.db.execute<{ id: string }>(sql`
    SELECT m.id FROM messages m JOIN placements p ON p.message_id = m.id JOIN topics tp ON tp.id = p.topic_id
    WHERE m.chat_id = ${chatId}::uuid AND p.chat_id = ${chatId}::uuid AND tp.root = ${root} AND tp.kind = 'TOPIC' AND m.body IS NOT NULL
    ORDER BY m.sent_at LIMIT 1`);

describe('concept map', () => {
  it('cleans web queries of anything personal', () => {
    expect(cleanQuery('React useEffect cleanup jane@example.com +65 9123 4567 @bob', ['Jane Tan'])).toBe('React useEffect cleanup');
    expect(cleanQuery('Jane Tan', ['Jane Tan'])).toBe('');
  });

  it('reads the branch, searches the web and keeps only real refs', async () => {
    const userId = await createUser(t.db);
    const ws = (await ensurePrivateWorkspace(t.db, userId)).id;
    const { chatIdByKey } = await loadFixtureWorkspace(t.db, ws, { analyze: true });
    const chatId = Object.values(chatIdByKey)[0];
    const ctx = { userId, workspaceId: ws, mode: 'private' as const };
    const [opened] = (await placedUnder(chatId, 'KNOWLEDGE')).rows;
    expect(opened).toBeTruthy();

    // Every root has concept maps: other roots can hold knowledge too.
    const [chatty] = (await placedUnder(chatId, 'GENERAL_CHAT')).rows;
    if (chatty) expect((await startStudyMap(t.db, ctx, chatty.id, {})).state).toBe('pending');

    const started = await startStudyMap(t.db, ctx, opened.id, {});
    expect(started.state).toBe('pending');
    const id = (started as { id: string }).id;
    // Asking again while it builds does not start a second one.
    expect(((await startStudyMap(t.db, ctx, opened.id, {})) as { id: string }).id).toBe(id);

    const seen: Record<string, { system: string; user: unknown }> = {};
    const provider: ModelProvider = {
      kind: 'nebius',
      modelIdFor: (role) => `stub-${role}`,
      complete: async (req: CompletionRequest) => {
        seen[req.operation] = { system: req.system, user: JSON.parse(req.user) };
        const out =
          req.operation === 'study_plan'
            ? { subject: 'Testing', questions: [{ question: 'How?', asked_in: ['m1'], answered_in: ['m2'] }], searches: [{ query: 'vitest mocking guide alice@example.com', why: 'explain' }] }
            : {
                title: 'Testing basics',
                summary: 'What the group worked out.',
                concepts: [
                  { key: 'c1', label: 'Testing', kind: 'core', explanation: 'The subject.', refs: ['m1', 'w1', 'm999', 'w9'] },
                  { key: 'c2', label: 'Mocks', kind: 'core', explanation: 'A second core becomes a concept.', refs: ['w1'] },
                  { key: 'c3', label: 'How?', kind: 'question', explanation: 'Asked in m2, answered in m1 (m999 is not a message).', refs: ['m1'] },
                  { key: 'c3', label: 'Duplicate', kind: 'odd', explanation: '', refs: [] },
                ],
                relations: [
                  { from: 'c1', to: 'c2', label: 'uses' },
                  { from: 'c3', to: 'c1', label: 'answered by' },
                  { from: 'c1', to: 'c404', label: 'invented' },
                ],
                guide: [{ heading: 'Start here', text: 'Read this first.', refs: ['m2', 'w1'] }],
                gaps: ['Coverage'],
              };
        return { text: JSON.stringify(out), modelId: `stub-${req.role}`, fallback: false, usage: { input: 100, output: 50, reasoning: null } };
      },
    };
    const queries: string[] = [];
    const search: WebSearch = async (q) => {
      queries.push(q);
      return [
        { title: 'Vitest mocking', url: 'https://vitest.dev/guide/mocking', content: 'How to mock.' },
        { title: 'Vitest mocking', url: 'https://vitest.dev/guide/mocking', content: 'Duplicate page.' },
      ];
    };
    await buildStudyMap({ db: t.db, provider, cfg: fixtureLlmConfig() }, id, search);

    // Ultra read the opened message, marked, and both calls went to the reasoning model.
    const read = seen.study_plan.user as { messages: { ref: string; opened?: boolean }[] };
    expect(read.messages.filter((m) => m.opened)).toHaveLength(1);
    expect(seen.study_map).toBeTruthy();
    // The query left without the email address.
    expect(queries).toEqual(['vitest mocking guide']);

    const r = await getStudyMap(t.db, ctx, opened.id);
    expect(r.state).toBe('done');
    if (r.state !== 'done') return;
    const { map } = r;
    expect(map.concepts.map((c) => c.key)).toEqual(['c1', 'c2', 'c3']);
    expect(map.concepts.filter((c) => c.kind === 'core')).toHaveLength(1);
    // Refs: an unknown message and an unknown page are dropped; the duplicate page was kept once.
    expect(map.web.results).toEqual([{ title: 'Vitest mocking', url: 'https://vitest.dev/guide/mocking' }]);
    expect(map.concepts[0].web).toEqual([0]);
    expect(map.concepts[0].messages).toHaveLength(1);
    expect(r.sources[map.concepts[0].messages[0]]).toBeTruthy();
    // A link to a concept that does not exist is dropped.
    expect(map.relations.map((x) => x.label)).toEqual(['uses', 'answered by']);
    // Refs written in the text become message links, and count among the item's sources.
    const q = map.concepts[2];
    expect(q.explanation).toMatch(/^Asked in \[\[[0-9a-f-]{36}\]\], answered in \[\[[0-9a-f-]{36}\]\] \(m999 is not a message\)\.$/);
    expect(q.messages).toHaveLength(2);
    for (const id of q.messages) expect(r.sources[id]).toBeTruthy();
    expect(map.guide[0].web).toEqual([0]);

    // Saved: opening it again does not rebuild; rebuilding starts a new one.
    expect((await startStudyMap(t.db, ctx, opened.id, {})).state).toBe('done');
    expect((await startStudyMap(t.db, ctx, opened.id, { rebuild: true })).state).toBe('pending');

    // Another account cannot read it.
    const other = await ensurePrivateWorkspace(t.db, await createUser(t.db));
    await expect(getStudyMap(t.db, { userId: 'x', workspaceId: other.id, mode: 'private' }, opened.id)).rejects.toThrow(/not found/);
  });
});
