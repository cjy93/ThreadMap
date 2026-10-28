import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { fixtureLlmConfig, loadFixtureWorkspace } from '../src/fixtures/load';
import { FixtureModelProvider } from '../src/fixtures/model';
import { drainJobs } from '../src/server/ai/drain';
import { analyseSide, sideMapOf } from '../src/server/ai/pipeline';
import type { CompletionRequest, ModelProvider } from '../src/server/ai/provider';
import { getMap, getNodeContent, listChats } from '../src/server/api/service';
import { deleteChat, ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// "Map from: You / Others": a separate map built only from one side's messages,
// so what the others said never shapes the owner's map. Each message is still
// read in its conversation: the other side's messages and quoted replies come
// along as context, never as part of the map.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t?.close());

describe('one-sided maps', () => {
  it("builds a map from only the owner's messages, read with the other side as context", async () => {
    const userId = await createUser(t.db);
    const ws = (await ensurePrivateWorkspace(t.db, userId)).id;
    const { chatIdByKey, bundle } = await loadFixtureWorkspace(t.db, ws, { analyze: true });
    const chatId = chatIdByKey.builders;
    const ctx = { userId, workspaceId: ws, mode: 'private' as const };
    // Every third message is the owner's.
    await t.db.execute(sql`UPDATE messages SET direction = 'outgoing', from_me = true
      WHERE id IN (SELECT id FROM (SELECT id, row_number() OVER (ORDER BY sent_at, id) AS n FROM messages WHERE chat_id = ${chatId}::uuid) x WHERE n % 3 = 0)`);
    const mine = new Set((await t.db.execute<{ id: string }>(sql`SELECT id FROM messages WHERE chat_id = ${chatId}::uuid AND direction = 'outgoing'`)).rows.map((r) => r.id));
    const ownBefore = await getMap(t.db, ctx, chatId, new URLSearchParams({ status: 'all' }));

    const { mapChatId, jobs } = await analyseSide(t.db, chatId, 'mine', 1000);
    expect(jobs.length).toBeGreaterThan(0);
    // Look at what Nano is given to read.
    const inner = new FixtureModelProvider(bundle.manifest);
    // Each read, as message ids: what is to be mapped, and what is context.
    const idOfNative = new Map((await t.db.execute<{ id: string; native_id: string }>(sql`SELECT id, native_id FROM messages WHERE chat_id = ${chatId}::uuid`)).rows.map((r) => [r.native_id, r.id]));
    const reads: { messages: string[]; context: string[] }[] = [];
    const provider: ModelProvider = {
      kind: 'fixture',
      modelIdFor: (r) => inner.modelIdFor(r),
      complete: async (req: CompletionRequest) => {
        if (req.operation.startsWith('extract')) {
          const input = JSON.parse(req.user.split('\n\nPREVIOUS_OUTPUT:')[0]) as { messages: { ref: string }[]; context: { ref: string }[] };
          const id = (ref: string) => idOfNative.get(req.fixtureHints?.refs?.[ref] ?? '') ?? '';
          reads.push({ messages: input.messages.map((m) => id(m.ref)), context: input.context.map((c) => id(c.ref)) });
        }
        return inner.complete(req);
      },
    };
    await drainJobs({ db: t.db, provider, cfg: fixtureLlmConfig(), sleep: async () => undefined }, { chatIds: [mapChatId] });

    // Only my messages are in the map; the others' were read alongside them as context.
    const placed = (await t.db.execute<{ message_id: string }>(sql`SELECT DISTINCT message_id FROM placements WHERE chat_id = ${mapChatId}::uuid`)).rows.map((r) => r.message_id);
    expect(placed.length).toBeGreaterThan(0);
    expect(placed.every((id) => mine.has(id))).toBe(true);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => r.messages.every((id) => mine.has(id)))).toBe(true);
    expect(reads.some((r) => r.context.some((id) => id && !mine.has(id)))).toBe(true);
    const units = await t.db.select().from(s.analysisUnits).where(eq(s.analysisUnits.chatId, mapChatId));
    expect(units.every((u) => u.messageRefs.every((r) => mine.has(r.m)))).toBe(true);

    // The one-sided map is shown with only my messages counted and listed.
    const map = await getMap(t.db, ctx, chatId, new URLSearchParams({ status: 'all', side: 'mine' }));
    expect(map.side).toBe('mine');
    const [{ n: mineReadable }] = (await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM messages WHERE chat_id = ${chatId}::uuid AND direction = 'outgoing' AND kind IN ('text','media') AND state = 'active'`)).rows;
    expect(map.chat_totals.message_count).toBe(mineReadable);
    const topic = map.nodes.find((n) => n.kind === 'TOPIC' && n.matching_message_count > 0)!;
    const content = await getNodeContent(t.db, ctx, chatId, topic.id, new URLSearchParams({ status: 'all', side: 'mine', page_size: '200' }));
    const listed = (content.items as { message_id?: string }[]).map((m) => m.message_id).filter(Boolean) as string[];
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((id) => mine.has(id))).toBe(true);

    // The chat's own map is untouched, and the hidden map never shows as a chat.
    const ownAfter = await getMap(t.db, ctx, chatId, new URLSearchParams({ status: 'all' }));
    expect(ownAfter.chat_totals).toEqual(ownBefore.chat_totals);
    expect(ownAfter.nodes.map((n) => n.id).sort()).toEqual(ownBefore.nodes.map((n) => n.id).sort());
    expect((await listChats(t.db, ctx)).some((c) => c.id === mapChatId)).toBe(false);

    // Nothing new: asking again queues no reading.
    expect((await analyseSide(t.db, chatId, 'mine', 1000)).jobs.filter(Boolean).length).toBeLessThanOrEqual(1);
  });

  it('asks for a map before it exists, and goes with its chat', async () => {
    const userId = await createUser(t.db);
    const ws = (await ensurePrivateWorkspace(t.db, userId)).id;
    const { chatIdByKey } = await loadFixtureWorkspace(t.db, ws, { analyze: false });
    const chatId = chatIdByKey.music;
    const ctx = { userId, workspaceId: ws, mode: 'private' as const };
    await expect(getMap(t.db, ctx, chatId, new URLSearchParams({ side: 'others' }))).rejects.toThrow(/not been started/);
    await analyseSide(t.db, chatId, 'others', 1000);
    expect(await sideMapOf(t.db, chatId, 'others')).not.toBeNull();
    await deleteChat(t.db, ws, chatId, undefined, { keepAvatar: true });
    expect(await sideMapOf(t.db, chatId, 'others')).toBeNull();
  });
});
