import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureLlmConfig, loadFixtureWorkspace } from '../src/fixtures/load';
import type { CompletionRequest, ModelProvider } from '../src/server/ai/provider';
import { findTrail, inferTrail } from '../src/server/api/trail';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// A question answered hours later, after the topic drifted and without Reply:
// Nemotron reads forward from the opened message once and keeps the messages
// that continue it, up to the one that settled it.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t?.close());

type Later = { ref: string; text: string };

describe('following a discussion through the chat', () => {
  it('keeps the later messages that continue it, in order, and reads once', async () => {
    const userId = await createUser(t.db);
    const ws = (await ensurePrivateWorkspace(t.db, userId)).id;
    const { chatIdByKey } = await loadFixtureWorkspace(t.db, ws, { analyze: true });
    const chatId = chatIdByKey.builders;
    const ctx = { userId, workspaceId: ws, mode: 'private' as const };
    const [opened] = (await t.db.execute<{ id: string }>(sql`SELECT id FROM messages WHERE chat_id = ${chatId}::uuid AND sent_at IS NOT NULL ORDER BY sent_at, id LIMIT 1`)).rows;

    let calls = 0;
    let picked: string[] = [];
    const provider: ModelProvider = {
      kind: 'nebius',
      modelIdFor: () => 'stub-balanced',
      complete: async (req: CompletionRequest) => {
        calls++;
        const input = JSON.parse(req.user) as { thread: Later[]; later: Later[] };
        // The opened message is part of the thread it is followed from, never a later message.
        expect(input.thread.length).toBeGreaterThan(0);
        // First part only: two continuations, the second settles it; plus an invented ref (dropped).
        const out = calls === 1 ? { continues: [input.later[2].ref, 'l999'], resolved_by: input.later[4].ref } : { continues: [], resolved_by: null };
        if (calls === 1) picked = [input.later[2].text, input.later[4].text];
        return { text: JSON.stringify(out), modelId: 'stub-balanced', fallback: false, usage: { input: 50, output: 20, reasoning: null } };
      },
    };
    const run = (id: string) => inferTrail({ db: t.db, provider, cfg: fixtureLlmConfig() }, ws, id);

    // Nothing saved yet: looking costs no model call.
    expect(await findTrail(t.db, ctx, opened.id, { follow: false }, run)).toMatchObject({ checked: false });
    expect(calls).toBe(0);

    const r = await findTrail(t.db, ctx, opened.id, { follow: true }, run);
    expect(r.checked).toBe(true);
    expect(r.resolved).toBe(true);
    // Settled in the first part: no further reading.
    expect(calls).toBe(1);
    const msgs = r.messages!;
    expect(msgs.map((m) => m.snippet)).toEqual(picked.map((p) => p.slice(0, 500)));
    expect(msgs.map((m) => m.resolves)).toEqual([false, true]);

    // Saved: shown again without another model call.
    const again = await findTrail(t.db, ctx, opened.id, { follow: false }, run);
    expect(again).toMatchObject({ checked: true, resolved: true });
    await findTrail(t.db, ctx, opened.id, { follow: true }, run);
    expect(calls).toBe(1);
  });

  it('offers to follow again when an unsettled trail has newer messages', async () => {
    const userId = await createUser(t.db);
    const ws = (await ensurePrivateWorkspace(t.db, userId)).id;
    const { chatIdByKey } = await loadFixtureWorkspace(t.db, ws, { analyze: true });
    const chatId = chatIdByKey.builders;
    const ctx = { userId, workspaceId: ws, mode: 'private' as const };
    const [opened] = (await t.db.execute<{ id: string }>(sql`SELECT id FROM messages WHERE chat_id = ${chatId}::uuid AND sent_at IS NOT NULL ORDER BY sent_at, id LIMIT 1`)).rows;
    const provider: ModelProvider = {
      kind: 'nebius',
      modelIdFor: () => 'stub-balanced',
      complete: async () => ({ text: '{"continues":[],"resolved_by":null}', modelId: 'stub-balanced', fallback: false, usage: { input: 50, output: 20, reasoning: null } }),
    };
    const run = (id: string) => inferTrail({ db: t.db, provider, cfg: fixtureLlmConfig() }, ws, id);
    expect(await findTrail(t.db, ctx, opened.id, { follow: true }, run)).toMatchObject({ checked: true, resolved: false, messages: [] });

    // Saved before a later message in the reading window arrived.
    await t.db.execute(sql`UPDATE message_trails SET checked_at = (SELECT sent_at FROM messages WHERE id = ${opened.id}::uuid) WHERE message_id = ${opened.id}::uuid`);
    expect(await findTrail(t.db, ctx, opened.id, { follow: false }, run)).toMatchObject({ checked: false, stale: true });
  });
});
