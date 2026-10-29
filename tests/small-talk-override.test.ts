import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { FixtureModelProvider } from '../src/fixtures/model';
import { fixtureLlmConfig, loadFixtureWorkspace } from '../src/fixtures/load';
import { drainJobs } from '../src/server/ai/drain';
import { rereadChatFromScratch } from '../src/server/ai/pipeline';
import { listSmallTalk, setSmallTalk, type AuthCtx } from '../src/server/api/service';
import { computeCounts } from '../src/server/graph/counts';
import { ContentFilterSchema } from '../src/server/graph/filters';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// The owner moves a message to small talk, or back onto the map; automatic screening keeps
// that choice, and it beats the rules (even "Done", which is small talk by rule).
let t: TestDb;
let auth: AuthCtx;
let chatId: string;
let bundle: Awaited<ReturnType<typeof loadFixtureWorkspace>>['bundle'];
const filter = ContentFilterSchema.parse({ status: 'all' });
beforeAll(async () => {
  t = await createTestDb();
  const ws = await ensurePrivateWorkspace(t.db, await createUser(t.db));
  const r = await loadFixtureWorkspace(t.db, ws.id, { analyze: true });
  chatId = r.chatIdByKey.builders;
  bundle = r.bundle;
  auth = { userId: ws.ownerUserId, workspaceId: ws.id, mode: 'private' };
});
afterAll(async () => t?.close());

/** A placed message, its primary topic, and how many messages that topic shows. */
async function placedMessage() {
  const [p] = (await t.db.execute<{ m: string; topic: string }>(sql`
    SELECT p.message_id AS m, p.topic_id AS topic FROM placements p JOIN messages x ON x.id = p.message_id
    WHERE p.chat_id = ${chatId}::uuid AND p.is_primary AND x.kind = 'text' AND x.filler IS NOT TRUE ORDER BY x.sent_at LIMIT 1`)).rows;
  return p;
}
const shown = async (topic: string) => (await computeCounts(t.db, { userId: auth.userId, workspaceId: auth.workspaceId, chatId }, filter)).topics.get(topic)?.total ?? 0;

describe('moving a message between the map and small talk', () => {
  it('takes it off the map and lists it as small talk, then puts it back', async () => {
    const { m, topic } = await placedMessage();
    const before = await shown(topic);
    expect(await setSmallTalk(t.db, auth, m, { small: true })).toMatchObject({ small_talk: true, placed: true });
    expect(await shown(topic)).toBe(before - 1);
    expect((await listSmallTalk(t.db, auth, chatId, new URLSearchParams())).messages.map((x) => x.message_id)).toContain(m);
    await setSmallTalk(t.db, auth, m, { small: false });
    expect(await shown(topic)).toBe(before);
  });

  it("puts even courtesy-only small talk on the map when the owner says so", async () => {
    const { m, topic } = await placedMessage();
    const before = await shown(topic);
    // No choice of the owner's yet (the first test made one on this message): the rule hides it.
    await t.db.update(s.messages).set({ body: 'Done', searchText: 'done', filler: true, fillerOverride: null }).where(eq(s.messages.id, m));
    expect(await shown(topic)).toBe(before - 1);
    await setSmallTalk(t.db, auth, m, { small: false });
    expect(await shown(topic)).toBe(before);
  });

  it('keeps the choice through a full re-read of the chat', async () => {
    const { m } = await placedMessage();
    await setSmallTalk(t.db, auth, m, { small: true });
    await rereadChatFromScratch(t.db, chatId);
    await drainJobs({ db: t.db, provider: new FixtureModelProvider(bundle.manifest), cfg: fixtureLlmConfig(), sleep: async () => undefined }, { chatIds: [chatId] });
    const [after] = await t.db.select({ filler: s.messages.filler, own: s.messages.fillerOverride }).from(s.messages).where(eq(s.messages.id, m));
    expect(after).toEqual({ filler: true, own: true });
  }, 30_000);

  it('refuses the demo and a bad request', async () => {
    const [{ id: m }] = await t.db.select({ id: s.messages.id }).from(s.messages).where(eq(s.messages.chatId, chatId)).limit(1);
    await expect(setSmallTalk(t.db, { ...auth, mode: 'demo' }, m, { small: true })).rejects.toThrow();
    await expect(setSmallTalk(t.db, auth, m, { small: 'yes' })).rejects.toThrow();
  });
});
