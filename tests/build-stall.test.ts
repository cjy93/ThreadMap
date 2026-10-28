import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureLlmConfig, loadFixtureWorkspace } from '../src/fixtures/load';
import { FixtureModelProvider } from '../src/fixtures/model';
import { drainJobs } from '../src/server/ai/drain';
import type { CompletionRequest, ModelProvider } from '../src/server/ai/provider';
import { loadTree } from '../src/server/graph/tree';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// Han Qi's build stopped with 354 discussions unplaced: Super's answer for a
// window of 40 discussions was cut off at the output limit (the repair too), and
// the build and all its refinements shared one 100-call allowance, which ran out.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t?.close());

/** The fixture model, except a map-building answer for more than 5 discussions is cut off. */
function cutsOffBigWindows(inner: ModelProvider): ModelProvider & { taxonomyCalls: number[] } {
  const taxonomyCalls: number[] = [];
  return {
    kind: 'fixture',
    taxonomyCalls,
    modelIdFor: (r) => inner.modelIdFor(r),
    complete: async (req: CompletionRequest) => {
      if (req.operation.startsWith('taxonomy')) {
        const input = JSON.parse(req.user.split('\n\nPREVIOUS_OUTPUT:')[0]) as { units: unknown[] };
        taxonomyCalls.push(input.units.length);
        if (input.units.length > 5) return { text: '{"nodes":[', modelId: 'fixture-balanced', fallback: false, truncated: true, usage: { input: 100, output: 4096, reasoning: null } };
      }
      return inner.complete(req);
    },
  };
}

describe('a long chat whose map answers overflow', () => {
  it('retries smaller windows and places every discussion within its call allowance', async () => {
    const ws = (await ensurePrivateWorkspace(t.db, await createUser(t.db))).id;
    const { chatIdByKey, bundle } = await loadFixtureWorkspace(t.db, ws, { analyze: false });
    const chatId = chatIdByKey.builders;
    const provider = cutsOffBigWindows(new FixtureModelProvider(bundle.manifest));
    // The production allowance, not the fixture's generous one.
    const cfg = { ...fixtureLlmConfig(), LLM_MAX_CALLS_PER_JOB: 100 };
    const ran = await drainJobs({ db: t.db, provider, cfg, sleep: async () => undefined }, { chatIds: [chatId] });

    expect(ran.filter((j) => j.status !== 'completed')).toEqual([]);
    const left = await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM analysis_units WHERE chat_id = ${chatId}::uuid AND assigned_topic_id IS NULL`);
    expect(left.rows[0].n).toBe(0);
    // Big windows were cut off, then the build went on with small ones.
    expect(provider.taxonomyCalls.some((n) => n > 5)).toBe(true);
    expect(provider.taxonomyCalls.some((n) => n <= 5)).toBe(true);
    // Refinements budget on their own, not out of the build's allowance.
    const shared = await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM analysis_jobs r JOIN analysis_jobs b ON b.logical_job_id = r.logical_job_id AND b.kind = 'rebuild'
      WHERE r.chat_id = ${chatId}::uuid AND r.kind = 'refine'`);
    expect(shared.rows[0].n).toBe(0);
  });

  it('keeps every level at six or fewer while the map is still being built', async () => {
    const ws = (await ensurePrivateWorkspace(t.db, await createUser(t.db))).id;
    const { chatIdByKey, bundle } = await loadFixtureWorkspace(t.db, ws, { analyze: false });
    const chatId = chatIdByKey.builders;
    // A level already far over the limit, as an interrupted build left Han Qi's roots.
    const [knowledge] = (await t.db.execute<{ id: string }>(sql`SELECT id FROM topics WHERE chat_id = ${chatId}::uuid AND kind = 'CATEGORY' AND root = 'KNOWLEDGE'`)).rows;
    for (let i = 0; i < 20; i++) {
      await t.db.execute(sql`INSERT INTO topics (workspace_id, chat_id, root, kind, parent_id, title, provenance) VALUES (${ws}::uuid, ${chatId}::uuid, 'KNOWLEDGE', 'TOPIC', ${knowledge.id}::uuid, ${`Subject ${i}`}, 'model')`);
    }
    // Look at the map each time Super is asked to place the next window.
    const widest: number[] = [];
    const inner = new FixtureModelProvider(bundle.manifest);
    const provider: ModelProvider = {
      kind: 'fixture',
      modelIdFor: (r) => inner.modelIdFor(r),
      complete: async (req: CompletionRequest) => {
        if (req.operation === 'taxonomy') {
          const tree = await loadTree(t.db, chatId);
          widest.push(Math.max(0, ...[...tree.nodes.values()].map((n) => n.childIds.length)));
        }
        return inner.complete(req);
      },
    };
    // Small calls, so the build takes several windows.
    const cfg = { ...fixtureLlmConfig(), LLM_MAX_INPUT_TOKENS_PER_CALL: 2500 };
    await drainJobs({ db: t.db, provider, cfg, sleep: async () => undefined }, { chatIds: [chatId] });
    expect(widest.length).toBeGreaterThan(2);
    expect(widest[0]).toBeGreaterThan(6);
    // Before the first window the level is 20 wide; after every window it is back to six or fewer.
    expect(widest.slice(1).every((n) => n <= 6), String(widest)).toBe(true);
  });
});
