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

// Asking for "davincci" found only messages spelled exactly that way. Ask now
// matches close spellings, and reads the matches for the chat's other names for
// the same thing ("davinci = Elucidex").
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
  const rows = (await t.db.execute<{ id: string }>(sql`SELECT id FROM messages WHERE chat_id = ${chatId}::uuid AND body IS NOT NULL ORDER BY sent_at, id LIMIT 4`)).rows;
  const bodies = { typo: 'So can u submit both ninja and Davincci?', right: 'Davinci demo is ready for the judges', alias: 'btw davinci = Elucidex now, new name', renamed: 'Elucidex pitch deck uploaded' };
  for (const [i, [k, body]] of Object.entries(bodies).entries()) {
    ids[k] = rows[i].id;
    await t.db.update(s.messages).set({ body, searchText: normalizeSearch(body) }).where(eq(s.messages.id, rows[i].id));
  }
});
afterAll(async () => t?.close());

const params = (q: string) => new URLSearchParams({ q, chat: chatId, status: 'all' });
const found = (r: { results: { message_id: string }[] }) => r.results.map((x) => x.message_id);

describe('Ask finds a name however it is written', () => {
  it('matches close spellings of a term', async () => {
    const r = await ask(t.db, auth, params('davincci'), async () => ({ interpretation: 'Davinci', terms: ['davincci'], topicIds: [] }));
    expect(found(r)).toContain(ids.typo);
    expect(found(r)).toContain(ids.right);
    expect(found(r)).toContain(ids.alias);
  });

  it("adds the chat's other names for it, read from the messages that mention it", async () => {
    let read: string[] = [];
    const provider: ModelProvider = {
      kind: 'nebius',
      modelIdFor: () => 'stub-fast',
      complete: async (req: CompletionRequest) => {
        const input = JSON.parse(req.user) as { messages?: string[] };
        const out =
          req.operation === 'ask_alias'
            ? ((read = input.messages ?? []), { aliases: (input.messages ?? []).some((m) => m.includes('= Elucidex')) ? ['elucidex'] : [] })
            : { interpretation: 'The Davinci project', terms: ['davincci'], topic_keys: [] };
        return { text: JSON.stringify(out), modelId: 'stub-fast', fallback: false, usage: { input: 50, output: 20, reasoning: null } };
      },
    };
    const deps = { db: t.db, provider, cfg: fixtureLlmConfig() };
    const r = await ask(t.db, auth, params('davincci'), (ws, chats, q) => interpretRequest(deps, ws, chats, q));
    expect(read.some((m) => m.includes('= Elucidex'))).toBe(true);
    expect(r.terms).toContain('elucidex');
    // Found under its other name, though it never says "davinci".
    expect(found(r)).toContain(ids.renamed);
  });

  it('does not match unrelated words that merely share letters', async () => {
    const r = await ask(t.db, auth, params('davincci'), async () => ({ interpretation: 'Davinci', terms: ['davincci'], topicIds: [] }));
    expect(found(r)).not.toContain(ids.renamed);
  });
});
