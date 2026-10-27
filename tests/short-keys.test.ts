import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { fixtureLlmConfig, loadFixtureWorkspace } from '../src/fixtures/load';
import { FixtureModelProvider } from '../src/fixtures/model';
import { loadFixtureBundle } from '../src/fixtures/source';
import { drainJobs } from '../src/server/ai/drain';
import type { CompletionRequest, CompletionResult, ModelProvider, Role } from '../src/server/ai/provider';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

const bundle = loadFixtureBundle();
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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

describe('ids sent to models', () => {
  it('uses short unit and topic keys, so abbreviated ids cannot strand every discussion in Needs review', async () => {
    const ws = await ensurePrivateWorkspace(t.db, await createUser(t.db));
    const { chatIdByKey } = await loadFixtureWorkspace(t.db, ws.id, { analyze: false });
    const provider = new Recording(new FixtureModelProvider(bundle.manifest));
    await drainJobs({ db: t.db, provider, cfg: fixtureLlmConfig(), sleep: async () => undefined }, { chatIds: [chatIdByKey.builders] });

    const structural = provider.requests.filter((r) => /^(taxonomy|refine|assign)/.test(r.operation));
    expect(structural.map((r) => r.operation)).toEqual(expect.arrayContaining(['taxonomy', 'refine']));
    for (const r of structural) {
      expect(r.system + r.user, r.operation).not.toMatch(UUID);
    }
    const taxonomyUnits = (JSON.parse(provider.requests.find((r) => r.operation === 'taxonomy')!.user) as { units: { unit_key: string }[] }).units;
    expect(taxonomyUnits.every((u) => /^u\d+$/.test(u.unit_key))).toBe(true);

    // The answers are mapped back: discussions land in real topics, not Needs review.
    const inReview = await t.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM placements p JOIN topics tp ON tp.id = p.topic_id WHERE p.chat_id = ${chatIdByKey.builders}::uuid AND tp.title = 'Needs review'`);
    const placed = await t.db.select().from(s.placements).where(eq(s.placements.chatId, chatIdByKey.builders));
    expect(placed.length).toBeGreaterThan(100);
    expect(inReview.rows[0].n).toBeLessThan(placed.length / 10);
  });
});
