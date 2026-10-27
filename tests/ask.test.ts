import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { fixtureLlmConfig, loadFixtureWorkspace } from '../src/fixtures/load';
import { FixtureModelProvider } from '../src/fixtures/model';
import { loadFixtureBundle } from '../src/fixtures/source';
import { ask, interpretRequest, viaWorker, type Interpreter } from '../src/server/api/ask';
import type { AuthCtx } from '../src/server/api/service';
import { ASK_CHANNEL, ASK_REPLY_CHANNEL } from '../src/server/notify';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

let t: TestDb;
let auth: AuthCtx;
let builders: string;
let direct: Interpreter;
beforeAll(async () => {
  t = await createTestDb();
  const ws = await ensurePrivateWorkspace(t.db, await createUser(t.db));
  const r = await loadFixtureWorkspace(t.db, ws.id);
  builders = r.chatIdByKey.builders;
  auth = { userId: ws.ownerUserId, workspaceId: ws.id, mode: 'private' };
  const deps = { db: t.db, provider: new FixtureModelProvider(loadFixtureBundle().manifest), cfg: fixtureLlmConfig() };
  direct = (wsId, chatIds, q) => interpretRequest(deps, wsId, chatIds, q);
});
afterAll(async () => t?.close());

const params = (q: string) => new URLSearchParams({ q, chat: builders, status: 'all' });

describe('Ask: describe what you are looking for', () => {
  it('finds messages through the topics the model picks, not just exact words', async () => {
    const r = await ask(t.db, auth, params('anything about refresh flow?'), direct);
    expect(r.interpretation).toContain('refresh');
    expect(r.topics.some((x) => x.path.at(-1)?.title === 'Refresh flow')).toBe(true);
    expect(r.results.length).toBeGreaterThan(0);
    // Messages placed in the chosen topic rank above plain word matches.
    expect(r.results[0].topic_paths.flat().some((p) => p.title === 'Refresh flow')).toBe(true);
    expect(r.results.every((x, i, a) => i === 0 || a[i - 1].score >= x.score)).toBe(true);
  });

  it('matches what the vision model saw in an image', async () => {
    // An ordinary, placed text message (system markers and the like are outside search by design).
    const [msg] = await t.db
      .select({ id: s.messages.id })
      .from(s.messages)
      .innerJoin(s.placements, eq(s.placements.messageId, s.messages.id))
      .where(and(eq(s.messages.chatId, builders), eq(s.messages.kind, 'text'), eq(s.messages.state, 'active')))
      .orderBy(s.messages.id)
      .limit(1);
    await t.db.insert(s.attachments).values({ workspaceId: auth.workspaceId, messageId: msg.id, mediaType: 'image', availability: 'cached', aiDescription: 'A hand-drawn poster announcing the robotics showcase' });
    const r = await ask(t.db, auth, params('the robotics poster'), direct);
    expect(r.results.map((x) => x.message_id)).toContain(msg.id);
  });

  it("uses the model's terms, not filler words from the question", async () => {
    const r = await ask(t.db, auth, params('show me information related to refresh'), async () => ({ interpretation: 'Token refresh', terms: ['refresh'], topicIds: [] }));
    expect(r.terms).toEqual(['refresh']);
  });

  it('still answers with plain word search when the model gives no answer', async () => {
    const r = await ask(t.db, auth, params('refresh'), async () => null);
    expect(r.interpretation).toBeNull();
    expect(r.terms).toEqual(['refresh']);
    expect(r.results.length).toBeGreaterThan(0);
  });

  it('round-trips through the worker over PostgreSQL notifications', async () => {
    process.env.DATABASE_URL = t.url;
    const worker = new pg.Client({ connectionString: t.url });
    await worker.connect();
    await worker.query(`LISTEN ${ASK_CHANNEL}`);
    const deps = { db: t.db, provider: new FixtureModelProvider(loadFixtureBundle().manifest), cfg: fixtureLlmConfig() };
    worker.on('notification', (n) => {
      void (async () => {
        const req = JSON.parse(n.payload!) as { id: string; workspaceId: string; chatIds: string[]; question: string };
        const out = await interpretRequest(deps, req.workspaceId, req.chatIds, req.question);
        await t.db.execute(sql`SELECT pg_notify(${ASK_REPLY_CHANNEL}, ${JSON.stringify({ id: req.id, ok: true, ...out })})`);
      })();
    });
    const started = Date.now();
    const r = await ask(t.db, auth, params('refresh flow'), viaWorker(t.db));
    expect(Date.now() - started).toBeLessThan(5000); // answered, not timed out
    expect(r.interpretation).toContain('refresh');
    await worker.end();
  });
});
