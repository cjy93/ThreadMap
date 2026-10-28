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

    let seen: { messages: { ref: string; text: string }[]; discussions: { title: string; points: { ref: string; text: string }[] }[] } | null = null;
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
            { text: 'From a summary point', refs: ['p1'] },
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
    // m2 is the second match; an unknown ref is dropped; p1 (a summary point) cites the messages it was drawn from.
    expect(r.points[0].message_ids).toEqual([msgs[1]]);
    const [unit] = await t.db.select().from(s.analysisUnits).where(eq(s.analysisUnits.chatId, chatId)).orderBy(s.analysisUnits.createdAt, s.analysisUnits.id).limit(1);
    const bullets = (unit.summaryBullets as { bullets?: { evidence?: { m: string }[] }[] }).bullets ?? [];
    const expected = bullets.length && bullets[0].evidence?.length ? bullets[0].evidence.map((e) => e.m).slice(0, 3) : [unit.messageRefs[0].m];
    expect(r.points[1].message_ids).toEqual(expected);
    // Every discussion in the chat was read.
    const units = await t.db.select().from(s.analysisUnits).where(eq(s.analysisUnits.chatId, chatId));
    expect(r.read?.discussions).toBe(units.length);

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

  it('says why there is no answer yet: still working, allowance used up, or no reply', async () => {
    const userId = await createUser(t.db);
    const ws = (await ensurePrivateWorkspace(t.db, userId)).id;
    const { chatIdByKey } = await loadFixtureWorkspace(t.db, ws, { analyze: false });
    const ctx = { userId, workspaceId: ws, mode: 'private' as const };
    const body = { q: 'anything', chat: chatIdByKey.builders, message_ids: [] };
    // Slow: the page is given an id to collect the answer with when it is ready.
    const slow = await answer(t.db, ctx, body, async () => ({ pending: 'req-1' }));
    expect(slow).toMatchObject({ answer: null, pending: 'req-1' });
    expect(slow.note).toMatch(/still working/);
    // Out of allowance: said plainly, not passed off as slowness.
    const spent = await answer(t.db, ctx, body, async () => ({ failed: 'budget_user' }));
    expect(spent.answer).toBeNull();
    expect(spent.note).toMatch(/allowance .* used up/);
    expect(spent.note).not.toMatch(/in time/);
    const none = await answer(t.db, ctx, body, async () => null);
    expect(none.answer).toBeNull();
    expect(none.note).toMatch(/did not answer/);
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

  it('reads a long chat in parts and merges what each part found', async () => {
    const ws = (await ensurePrivateWorkspace(t.db, await createUser(t.db))).id;
    const { chatIdByKey } = await loadFixtureWorkspace(t.db, ws, { analyze: true });
    const chatId = chatIdByKey.builders;
    const ops: string[] = [];
    let parts = 0;
    const provider: ModelProvider = {
      kind: 'nebius',
      modelIdFor: () => 'stub-balanced',
      complete: async (req: CompletionRequest) => {
        ops.push(req.operation);
        const input = JSON.parse(req.user);
        let out;
        if (req.operation === 'answer') {
          // Each part reports one finding, citing its first summary point.
          const ref = input.discussions[0].points[0].ref as string;
          out = { answer: `part ${++parts}`, enough: true, points: [{ text: `Item from part ${parts}`, refs: [ref] }] };
        } else {
          // The merge keeps every finding as its own point.
          out = { answer: 'Merged', enough: true, points: (input.findings as { ref: string; text: string }[]).map((f) => ({ text: f.text, refs: [f.ref] })) };
        }
        return { text: JSON.stringify(out), modelId: 'stub-balanced', fallback: false, usage: { input: 100, output: 50, reasoning: null } };
      },
    };
    // A small per-call limit forces several parts.
    const cfg = { ...fixtureLlmConfig(), LLM_MAX_INPUT_TOKENS_PER_CALL: 1200 };
    const r = await answerQuestion({ db: t.db, provider, cfg }, ws, [chatId], 'what tools are mentioned?', []);
    expect(ops.filter((o) => o === 'answer').length).toBeGreaterThan(1);
    expect(ops.at(-1)).toBe('answer:merge');
    expect(r.answer).toBe('Merged');
    expect(r.points.length).toBe(Math.min(parts, 16));
    // Findings keep their original messages through the merge.
    for (const p of r.points) expect(p.message_ids.length).toBeGreaterThan(0);
  });
});
