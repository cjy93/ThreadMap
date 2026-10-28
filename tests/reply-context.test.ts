import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { fixtureLlmConfig, loadFixtureWorkspace } from '../src/fixtures/load';
import { FixtureModelProvider } from '../src/fixtures/model';
import { loadFixtureBundle } from '../src/fixtures/source';
import { drainJobs } from '../src/server/ai/drain';
import type { PromptMessage, UnitDigest } from '../src/server/ai/prompts';
import type { CompletionRequest, CompletionResult, ModelProvider, Role } from '../src/server/ai/provider';
import { ingestEvents } from '../src/server/ingest/ingest';
import type { MessageEvent } from '../src/server/ingest/types';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

const bundle = loadFixtureBundle();

/** Records every request so the test can inspect exactly what the model was shown. */
class Recording implements ModelProvider {
  readonly kind = 'fixture' as const;
  requests: CompletionRequest[] = [];
  constructor(private inner: FixtureModelProvider) {}
  modelIdFor(r: Role) {
    return this.inner.modelIdFor(r);
  }
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(req);
    return this.inner.complete(req);
  }
}

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t?.close());

const VAGUE = 'Yeah, the second approach worked for us.';

describe('reply-aware analysis', () => {
  it('reads a reply with the far-away message it quotes and files it under the same topic', async () => {
    const u = await createUser(t.db);
    const ws = await ensurePrivateWorkspace(t.db, u);
    const { chatIdByKey, ctx } = await loadFixtureWorkspace(t.db, ws.id);
    const chatId = chatIdByKey.builders;
    const jid = bundle.manifest.chats.builders.jid;

    // Oldest messages primarily placed in the deep refresh-flow topic: far outside any preceding-context window.
    const deep = await t.db.execute<{ id: string; native_id: string; body: string; topic_id: string }>(sql`
      SELECT m.id, m.native_id, m.body, p.topic_id FROM messages m
      JOIN placements p ON p.message_id = m.id AND p.is_primary
      JOIN topics tp ON tp.id = p.topic_id
      WHERE m.chat_id = ${chatId}::uuid AND tp.title = 'Refresh flow' AND m.kind = 'text'
      ORDER BY m.sent_at LIMIT 2`);
    expect(deep.rows.length).toBe(2);
    const [target, revokedTarget] = deep.rows;
    const later = await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM messages WHERE chat_id = ${chatId}::uuid AND sent_at > (SELECT sent_at FROM messages WHERE id = ${target.id}::uuid)`);
    expect(later.rows[0].n).toBeGreaterThan(50);

    // A quoted source that is revoked afterwards must never be shown to the model.
    await t.db.update(s.messages).set({ state: 'revoked', body: null }).where(eq(s.messages.id, revokedTarget.id));

    const last = await t.db.execute<{ s: number }>(sql`SELECT extract(epoch FROM max(sent_at))::int AS s FROM messages WHERE chat_id = ${chatId}::uuid`);
    const at = last.rows[0].s + 86_400 * 2;
    const ev = (nativeId: string, body: string, replyToNativeId: string | null, dt: number): MessageEvent => ({
      type: 'message', origin: 'live', chatJid: jid, chatKind: 'group', nativeId, fromMe: false, participantJid: 'p1@s.whatsapp.net', participantAltJid: null,
      senderJid: 'p1@s.whatsapp.net', senderName: 'Pat', sentAtSec: at + dt, kind: 'text', body, attachments: [], replyToNativeId, ephemeralSec: null, marker: null,
    });
    await ingestEvents(t.db, ctx, [
      ev('REPLY-FAR', VAGUE, target.native_id, 0),
      ev('CONTROL', VAGUE, null, 1),
      ev('NEW-Q', 'Is the venue wifi password still the same?', null, 2),
      ev('REPLY-NEAR', 'Yes, same one.', 'NEW-Q', 3),
      ev('REPLY-REVOKED', 'Agreed with that.', revokedTarget.native_id, 4),
    ]);

    const provider = new Recording(new FixtureModelProvider(bundle.manifest));
    await drainJobs({ db: t.db, provider, cfg: fixtureLlmConfig(), sleep: async () => undefined }, { chatIds: [chatId] });

    // --- What the extraction model was shown ---
    const extract = provider.requests.find((r) => r.operation === 'extract');
    expect(extract).toBeDefined();
    const input = JSON.parse(extract!.user) as { context: PromptMessage[]; messages: PromptMessage[] };
    const byText = (text: string) => input.messages.filter((m) => m.text === text);
    const [far, control] = byText(VAGUE);
    const quoted = input.context.find((c) => c.text.startsWith(target.body.slice(0, 200)));
    expect(quoted, 'out-of-window quoted message offered as context').toBeDefined();
    expect(quoted!.ref).toMatch(/^q\d+$/);
    expect(far.reply_to).toBe(quoted!.ref);
    expect(control.reply_to).toBeUndefined();
    // In-chunk replies point at the in-chunk ref.
    const q = byText('Is the venue wifi password still the same?')[0];
    expect(byText('Yes, same one.')[0].reply_to).toBe(q.ref);
    // Revoked quoted content is neither offered nor referenced.
    expect(byText('Agreed with that.')[0].reply_to).toBeUndefined();
    expect(extract!.user).not.toContain(revokedTarget.body);
    expect(extract!.system).toMatch(/reply_to/);

    // --- What the assignment model was shown ---
    const assign = provider.requests.find((r) => r.operation === 'assign');
    expect(assign).toBeDefined();
    // Topics are sent as short keys (t1…); the reply's key must name the quoted message's topic.
    const shown = JSON.parse(assign!.user) as { units: UnitDigest[]; candidates: { id: string; path: string }[] };
    const replyKeys = shown.units.flatMap((x) => x.reply_topics ?? []);
    expect(replyKeys.length).toBeGreaterThan(0);
    const replyPaths = shown.candidates.filter((c) => replyKeys.includes(c.id)).map((c) => c.path);
    expect(replyPaths.some((p) => p.endsWith('Refresh flow'))).toBe(true);
    // No full topic ids reach the model.
    expect(assign!.user).not.toContain(target.topic_id);

    // --- Outcome: the reply joins the quoted message's topic; the identical unlinked text does not ---
    const primaryOf = async (nativeId: string) => {
      const r = await t.db
        .select({ topicId: s.placements.topicId })
        .from(s.placements)
        .innerJoin(s.messages, eq(s.messages.id, s.placements.messageId))
        .where(and(eq(s.messages.chatId, chatId), eq(s.messages.nativeId, nativeId), eq(s.placements.isPrimary, true)));
      return r.map((x) => x.topicId);
    };
    expect(await primaryOf('REPLY-FAR')).toEqual([target.topic_id]);
    expect(await primaryOf('CONTROL')).not.toContain(target.topic_id);
  });
});
