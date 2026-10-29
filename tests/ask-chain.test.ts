import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { fixtureLlmConfig, loadFixtureWorkspace } from '../src/fixtures/load';
import { ask, interpretRequest } from '../src/server/api/ask';
import type { CompletionRequest, ModelProvider } from '../src/server/ai/provider';
import type { AuthCtx } from '../src/server/api/service';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { normalizeSearch } from '../src/server/util';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// Asked "ninja", Ask found the chat's other name "conquercourse" but not "Dojo": Dojo is
// only ever mentioned next to Conquercourse/Conquerquest ("Conquercourse become Dojo?",
// "Dojo is just slow area of the game"), never next to "ninja". The names step now reads
// one step further, and keeps names of parts (areas, levels, modes) as well as renames.
let t: TestDb;
let auth: AuthCtx;
let chatId: string;
const ids: Record<string, string> = {};
beforeAll(async () => {
  t = await createTestDb();
  const ws = await ensurePrivateWorkspace(t.db, await createUser(t.db));
  const r = await loadFixtureWorkspace(t.db, ws.id, { analyze: false });
  chatId = r.chatIdByKey.builders;
  auth = { userId: ws.ownerUserId, workspaceId: ws.id, mode: 'private' };
  const rows = (await t.db.execute<{ id: string }>(sql`SELECT id FROM messages WHERE chat_id = ${chatId}::uuid AND body IS NOT NULL ORDER BY sent_at, id LIMIT 3`)).rows;
  const bodies = { named: 'the ninja game is called conquercourse now', asked: 'Conquercourse become Dojo?', part: 'Dojo is just slow area of the game. Same name still' };
  for (const [i, [k, body]] of Object.entries(bodies).entries()) {
    ids[k] = rows[i].id;
    await t.db.update(s.messages).set({ body, searchText: normalizeSearch(body) }).where(eq(s.messages.id, rows[i].id));
  }
});
afterAll(async () => t?.close());

describe('Ask: names found through other names', () => {
  it('follows "ninja" -> "conquercourse" -> "dojo" and finds the Dojo messages', async () => {
    const asked: string[][] = [];
    const provider: ModelProvider = {
      kind: 'nebius',
      modelIdFor: () => 'stub-fast',
      complete: async (req: CompletionRequest) => {
        const input = JSON.parse(req.user) as { messages?: string[]; known_names?: string[] };
        let out: unknown = { interpretation: 'The ninja game', terms: ['ninja'], topic_keys: [] };
        if (req.operation === 'ask_alias') {
          const msgs = input.messages ?? [];
          asked.push(input.known_names ?? []);
          // A model reading these messages: the rename, then (one step on) the area named Dojo.
          out = {
            aliases: msgs.some((m) => m.includes('called conquercourse')) ? ['conquercourse'] : [],
            parts: msgs.some((m) => m.includes('Dojo is just slow area')) ? ['dojo'] : [],
          };
        }
        return { text: JSON.stringify(out), modelId: 'stub-fast', fallback: false, usage: { input: 50, output: 20, reasoning: null } };
      },
    };
    const deps = { db: t.db, provider, cfg: fixtureLlmConfig() };
    const r = await ask(t.db, auth, new URLSearchParams({ q: 'ninja', chat: chatId, status: 'all' }), (ws, chats, q, found) => interpretRequest(deps, ws, chats, q, found));
    // The second step knew conquercourse was the same thing.
    expect(asked[1]).toEqual(['ninja', 'conquercourse']);
    expect(r.terms).toEqual(expect.arrayContaining(['ninja', 'conquercourse', 'dojo']));
    const hit = r.results.map((x) => x.message_id);
    expect(hit).toEqual(expect.arrayContaining([ids.named, ids.asked, ids.part]));
  });
});
