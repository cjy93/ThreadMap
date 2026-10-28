import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { fixtureLlmConfig, loadFixtureWorkspace } from '../src/fixtures/load';
import { mapNeedsTidy, screenFiller } from '../src/server/ai/pipeline';
import type { CompletionRequest, ModelProvider } from '../src/server/ai/provider';
import { ensureLedger } from '../src/server/ai/router';
import { PIPELINE_VERSION } from '../src/server/ai/schemas';
import { getMessage, getNodeContent } from '../src/server/api/service';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// Filler ("Is fake comment") leaves the map's counts and lists, but opening any
// message of its discussion lists the whole thread, filler included.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t?.close());

/** Stands in for Nemotron Nano: flags the one throwaway line. */
const screener: ModelProvider = {
  kind: 'nebius',
  modelIdFor: () => 'stub-fast',
  complete: async (req: CompletionRequest) => {
    const input = JSON.parse(req.user) as { messages: { ref: string; text: string }[] };
    const filler = input.messages.filter((m) => m.text === 'Is fake comment').map((m) => m.ref);
    return { text: JSON.stringify({ filler }), modelId: 'stub-fast', fallback: false, usage: { input: 100, output: 20, reasoning: null } };
  },
};

describe('filler and the discussion thread', () => {
  it('keeps filler off the map but in the thread of every message around it', async () => {
    const userId = await createUser(t.db);
    const ws = (await ensurePrivateWorkspace(t.db, userId)).id;
    const { chatIdByKey } = await loadFixtureWorkspace(t.db, ws, { analyze: true });
    const chatId = chatIdByKey.builders;
    const ctx = { userId, workspaceId: ws, mode: 'private' as const };
    // Extraction screens what it reads: nothing in a discussion is left unscreened.
    const unscreened = await t.db.execute(sql`SELECT 1 FROM messages WHERE chat_id = ${chatId}::uuid AND filler IS NULL
      AND id IN (SELECT (r->>'m')::uuid FROM analysis_units u, jsonb_array_elements(u.message_refs) r WHERE u.chat_id = ${chatId}::uuid)`);
    expect(unscreened.rows).toEqual([]);

    // A discussion with several messages; one of them becomes a throwaway line, and the chat
    // looks like one read before screening existed.
    const unit = (await t.db.execute<{ refs: { m: string }[]; topic: string }>(sql`SELECT message_refs AS refs, assigned_topic_id AS topic FROM analysis_units
      WHERE chat_id = ${chatId}::uuid AND assigned_topic_id IS NOT NULL AND jsonb_array_length(message_refs) >= 3 ORDER BY created_at, id LIMIT 1`)).rows[0];
    // The quip is a plain text message (files and links always count as content) and not a
    // summary's source (cited messages always stay on the map).
    const plain = (await t.db.execute<{ id: string }>(sql`SELECT m.id FROM messages m WHERE m.id IN (${sql.join(unit.refs.map((r) => sql`${r.m}::uuid`), sql`, `)})
      AND m.kind = 'text' AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id) AND NOT EXISTS (SELECT 1 FROM resources r WHERE r.message_id = m.id) ORDER BY m.sent_at LIMIT 1`)).rows[0].id;
    await t.db.execute(sql`UPDATE analysis_units SET summary_bullets = jsonb_set(summary_bullets, '{bullets}', '[]'::jsonb)
      WHERE chat_id = ${chatId}::uuid AND summary_bullets::text LIKE ${`%${plain}%`}`);
    const quip = plain;
    const other = unit.refs.map((r) => r.m).find((m) => m !== quip)!;
    await t.db.update(s.messages).set({ body: 'Is fake comment', searchText: 'is fake comment' }).where(eq(s.messages.id, quip));
    await t.db.execute(sql`UPDATE messages SET filler = NULL WHERE chat_id = ${chatId}::uuid`);
    expect(await mapNeedsTidy(t.db, chatId)).toBe(true);

    const listed = async () => {
      const r = await getNodeContent(t.db, ctx, chatId, unit.topic, new URLSearchParams({ status: 'all', page_size: '200' }));
      return (r.items as { message_id?: string }[]).map((m) => m.message_id);
    };
    expect(await listed()).toContain(quip);

    const [chat] = await t.db.select().from(s.chats).where(eq(s.chats.id, chatId));
    const cfg = fixtureLlmConfig();
    const logicalJobId = crypto.randomUUID();
    await ensureLedger(t.db, ws, logicalJobId, cfg);
    const [job] = await t.db
      .insert(s.analysisJobs)
      .values({ workspaceId: ws, chatId, kind: 'rebuild', logicalJobId, inputFingerprint: `filler-test-${logicalJobId}`, inputMessages: [], pipelineVersion: PIPELINE_VERSION, deletionGeneration: chat.deletionGeneration, selectionEpoch: chat.selectionEpoch })
      .returning();
    expect(await screenFiller({ db: t.db, provider: screener, cfg, sleep: async () => undefined }, job, chat)).toBeGreaterThan(0);

    const [q] = await t.db.select({ filler: s.messages.filler }).from(s.messages).where(eq(s.messages.id, quip));
    expect(q.filler).toBe(true);
    // Off the map's list; the rest of the discussion stays.
    const after = await listed();
    expect(after).not.toContain(quip);
    expect(after).toContain(other);

    // Opening a neighbour lists the whole discussion in order, the quip included.
    const opened = await getMessage(t.db, ctx, other);
    expect(opened.thread).not.toBeNull();
    const ids = opened.thread!.messages.map((m) => m.message_id);
    for (const r of unit.refs) expect(ids).toContain(r.m);
    expect(opened.thread!.messages.find((m) => m.message_id === quip)?.filler).toBe(true);
    expect(opened.thread!.messages.filter((m) => m.current).map((m) => m.message_id)).toEqual([other]);
    const times = opened.thread!.messages.map((m) => m.sent_at ?? '');
    expect([...times].sort()).toEqual(times);
  });

  it('keeps a message a summary cites on the map, even when flagged as filler', async () => {
    const userId = await createUser(t.db);
    const ws = (await ensurePrivateWorkspace(t.db, userId)).id;
    const { chatIdByKey } = await loadFixtureWorkspace(t.db, ws, { analyze: true });
    const chatId = chatIdByKey.builders;
    const ctx = { userId, workspaceId: ws, mode: 'private' as const };
    const row = (await t.db.execute<{ id: string; topic: string }>(sql`SELECT (e->>'m') AS id, u.assigned_topic_id AS topic FROM analysis_units u,
      jsonb_array_elements(u.summary_bullets->'bullets') b, jsonb_array_elements(b->'evidence') e
      WHERE u.chat_id = ${chatId}::uuid AND u.assigned_topic_id IS NOT NULL LIMIT 1`)).rows[0];
    await t.db.update(s.messages).set({ filler: true }).where(eq(s.messages.id, row.id));
    const r = await getNodeContent(t.db, ctx, chatId, row.topic, new URLSearchParams({ status: 'all', page_size: '200' }));
    expect((r.items as { message_id?: string }[]).map((m) => m.message_id)).toContain(row.id);
  });
});
