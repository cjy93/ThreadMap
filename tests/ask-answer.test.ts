import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { fixtureLlmConfig, loadFixtureWorkspace } from '../src/fixtures/load';
import { answer, answerQuestion, interpretRequest, withSources } from '../src/server/api/ask';
import type { CompletionRequest, ModelProvider } from '../src/server/ai/provider';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// Ask, second step: Nemotron answers from the matching messages and the chat's
// discussion summaries, and every point leads back to the messages it came from.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t?.close());

describe('answering an Ask question', () => {
  it('reads the matches and discussion summaries and cites real messages', async () => {
    const userId = await createUser(t.db);
    const ws = (await ensurePrivateWorkspace(t.db, userId)).id;
    const { chatIdByKey } = await loadFixtureWorkspace(t.db, ws, { analyze: true });
    const chatId = chatIdByKey.builders;
    const msgs = (await t.db.execute<{ id: string }>(sql`SELECT id FROM messages WHERE chat_id = ${chatId}::uuid AND body IS NOT NULL ORDER BY sent_at LIMIT 3`)).rows.map((r) => r.id);

    let seen: { messages: { ref: string; text: string }[]; discussions: { ref: string; title: string }[] } | null = null;
    const provider: ModelProvider = {
      kind: 'nebius',
      modelIdFor: () => 'stub-balanced',
      complete: async (req: CompletionRequest) => {
        seen = JSON.parse(req.user);
        const out = {
          answer: 'Two applications are mentioned.',
          enough: true,
          points: [
            { text: 'From a matching message', refs: ['m2', 'nonsense'] },
            { text: 'From a discussion summary', refs: ['d1'] },
          ],
        };
        return { text: JSON.stringify(out), modelId: 'stub-balanced', fallback: false, usage: { input: 100, output: 50, reasoning: null } };
      },
    };
    const r = await answerQuestion({ db: t.db, provider, cfg: fixtureLlmConfig() }, ws, [chatId], 'what applications are mentioned?', msgs);

    // The matches come first, in the order Ask ranked them, then the discussion summaries.
    expect(seen!.messages.map((m) => m.ref)).toEqual(['m1', 'm2', 'm3']);
    expect(seen!.discussions.length).toBeGreaterThan(0);
    expect(r.answer).toBe('Two applications are mentioned.');
    // m2 is the second match; an unknown ref is dropped; d1 stands for its discussion's first message.
    expect(r.points[0].message_ids).toEqual([msgs[1]]);
    const [unit] = await t.db.select().from(s.analysisUnits).where(eq(s.analysisUnits.chatId, chatId)).limit(1);
    expect(r.points[1].message_ids).toEqual([unit.messageRefs[0].m]);

    // The web side attaches who said it and a snippet to each source.
    const withSrc = await withSources(t.db, ws, r);
    expect(withSrc.points[0].sources[0]).toMatchObject({ message_id: msgs[1], chat_id: chatId });
    expect(withSrc.points[0].sources[0].sender.length).toBeGreaterThan(0);
  });

  it('never cites messages from another workspace', async () => {
    const ws = (await ensurePrivateWorkspace(t.db, await createUser(t.db))).id;
    const other = (await ensurePrivateWorkspace(t.db, await createUser(t.db))).id;
    const { chatIdByKey } = await loadFixtureWorkspace(t.db, other, { analyze: true });
    const foreign = (await t.db.execute<{ id: string }>(sql`SELECT id FROM messages WHERE chat_id = ${chatIdByKey.builders}::uuid LIMIT 1`)).rows[0].id;
    const r = await withSources(t.db, ws, { answer: 'x', enough: true, points: [{ text: 'p', message_ids: [foreign] }] });
    expect(r.points[0].sources).toEqual([]);
  });

  it('says so when Nemotron does not answer in time', async () => {
    const userId = await createUser(t.db);
    const ws = (await ensurePrivateWorkspace(t.db, userId)).id;
    const { chatIdByKey } = await loadFixtureWorkspace(t.db, ws, { analyze: false });
    const ctx = { userId, workspaceId: ws, mode: 'private' as const };
    const r = await answer(t.db, ctx, { q: 'anything', chat: chatIdByKey.builders, message_ids: [] }, async () => null);
    expect(r.answer).toBeNull();
    expect(r.note).toMatch(/did not answer in time/);
  });

  it('still reaches the model when the chat has hundreds of topics', async () => {
    const ws = (await ensurePrivateWorkspace(t.db, await createUser(t.db))).id;
    const { chatIdByKey } = await loadFixtureWorkspace(t.db, ws, { analyze: true });
    const chatId = chatIdByKey.builders;
    const [knowledge] = (await t.db.execute<{ id: string }>(sql`SELECT id FROM topics WHERE chat_id = ${chatId}::uuid AND kind = 'CATEGORY' AND root = 'KNOWLEDGE'`)).rows;
    for (let i = 0; i < 500; i++) {
      await t.db.execute(sql`INSERT INTO topics (workspace_id, chat_id, root, kind, parent_id, title, provenance) VALUES (${ws}::uuid, ${chatId}::uuid, 'KNOWLEDGE', 'TOPIC', ${knowledge.id}::uuid, ${`A fairly long descriptive topic title number ${i}`}, 'model')`);
    }
    let asked = false;
    const provider: ModelProvider = {
      kind: 'nebius',
      modelIdFor: () => 'stub-fast',
      complete: async () => {
        asked = true;
        return { text: JSON.stringify({ interpretation: 'Software names', terms: ['cloudflare'], topic_keys: [] }), modelId: 'stub-fast', fallback: false, usage: { input: 100, output: 20, reasoning: null } };
      },
    };
    const r = await interpretRequest({ db: t.db, provider, cfg: { ...fixtureLlmConfig(), LLM_MAX_INPUT_TOKENS_PER_CALL: 2500 } }, ws, [chatId], 'list the software he mentioned');
    expect(asked).toBe(true);
    expect(r.terms).toEqual(['cloudflare']);
  });
});
