import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { fixtureLlmConfig, loadFixtureWorkspace } from '../src/fixtures/load';
import { findAnswers, inferAnswers } from '../src/server/api/answers';
import type { CompletionRequest, ModelProvider } from '../src/server/ai/provider';
import { discussionRows, getMessage } from '../src/server/api/service';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// Two questions asked, then both answered in turn without pressing Reply:
// WhatsApp links nothing. Nemotron reads the opened discussion once and links
// each answer to its question; the discussion and the reply chain show them.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t?.close());

describe('answers given without Reply', () => {
  it('links answers to the questions they answer, once per discussion', async () => {
    const userId = await createUser(t.db);
    const ws = (await ensurePrivateWorkspace(t.db, userId)).id;
    const { chatIdByKey } = await loadFixtureWorkspace(t.db, ws, { analyze: true });
    const chatId = chatIdByKey.builders;
    const ctx = { userId, workspaceId: ws, mode: 'private' as const };
    await t.db.execute(sql`UPDATE messages SET reply_to_native_id = NULL WHERE chat_id = ${chatId}::uuid`);
    // A discussion of at least four messages: Q1, Q2, A1 (answers Q1), A2 (answers Q2).
    const unit = (await t.db.execute<{ m: string }>(sql`SELECT (message_refs->0->>'m') AS m FROM analysis_units WHERE chat_id = ${chatId}::uuid AND jsonb_array_length(message_refs) >= 4 ORDER BY created_at, id LIMIT 1`)).rows[0];
    const rows = await discussionRows(t.db, chatId, unit.m);
    const [q1, q2, a1, a2] = rows;
    const bodies: [typeof q1, string][] = [
      [q1, 'What time is the demo?'],
      [q2, 'And who brings the projector?'],
      [a1, '3pm sharp'],
      [a2, 'Wei Ming will bring it'],
    ];
    for (const [r, body] of bodies) await t.db.update(s.messages).set({ body }).where(eq(s.messages.id, r.id));

    let calls = 0;
    const provider: ModelProvider = {
      kind: 'nebius',
      modelIdFor: () => 'stub-fast',
      complete: async (req: CompletionRequest) => {
        calls++;
        const input = JSON.parse(req.user) as { messages: { ref: string; text: string }[] };
        const ref = (text: string) => input.messages.find((m) => m.text === text)?.ref;
        const links = [
          { ref: ref('3pm sharp'), answers: ref('What time is the demo?') },
          { ref: ref('Wei Ming will bring it'), answers: ref('And who brings the projector?') },
          // A later message cannot be what an earlier one answers: dropped.
          { ref: ref('What time is the demo?'), answers: ref('3pm sharp') },
        ].filter((l) => l.ref && l.answers);
        return { text: JSON.stringify({ links }), modelId: 'stub-fast', fallback: false, usage: { input: 50, output: 20, reasoning: null } };
      },
    };
    const deps = { db: t.db, provider, cfg: fixtureLlmConfig() };
    const run = (id: string) => inferAnswers(deps, ws, id);

    const r = await findAnswers(t.db, ctx, a2.id, run);
    expect(r.checked).toBe(true);
    expect(calls).toBe(1);
    // Read once: opening another message of the discussion asks nothing more.
    await findAnswers(t.db, ctx, q1.id, run);
    expect(calls).toBe(1);

    const opened = await getMessage(t.db, ctx, a2.id);
    expect(opened.thread!.answers_checked).toBe(true);
    const shown = new Map(opened.thread!.messages.map((x) => [x.message_id, x.answers?.message_id ?? null]));
    expect(shown.get(a1.id)).toBe(q1.id);
    expect(shown.get(a2.id)).toBe(q2.id);
    expect(shown.get(q1.id)).toBeNull();

    // The reply chain follows them, marked as inferred.
    expect(opened.reply_chain.before.map((x) => [x.message_id, x.inferred])).toEqual([[q2.id, true]]);
    const fromQ1 = await getMessage(t.db, ctx, q1.id);
    expect(fromQ1.reply_chain.after.map((x) => [x.message_id, x.inferred])).toEqual([[a1.id, true]]);
  });
});
