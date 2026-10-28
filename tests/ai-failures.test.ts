import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { fixtureLlmConfig, loadFixtureWorkspace } from '../src/fixtures/load';
import { FixtureModelProvider } from '../src/fixtures/model';
import { loadFixtureBundle } from '../src/fixtures/source';
import { drainJobs } from '../src/server/ai/drain';
import { resumePausedFrontiers } from '../src/server/ai/pipeline';
import { ProviderError, type CompletionRequest, type CompletionResult, type ModelProvider, type Role } from '../src/server/ai/provider';
import { getMap, type AuthCtx } from '../src/server/api/service';
import { loadTree } from '../src/server/graph/tree';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

const bundle = loadFixtureBundle();

class Scripted implements ModelProvider {
  readonly kind = 'fixture' as const;
  calls: string[] = [];
  constructor(
    private inner: FixtureModelProvider,
    private script: (req: CompletionRequest, n: number) => 'ok' | 'rate_limit' | 'timeout' | 'outage' | 'bad_json' | 'bad_refs',
  ) {}
  modelIdFor(r: Role) {
    return this.inner.modelIdFor(r);
  }
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls.push(req.operation);
    const action = this.script(req, this.calls.length);
    if (action === 'rate_limit') throw new ProviderError('provider rate limit', 'rate_limit', true);
    if (action === 'timeout') throw new ProviderError('provider timeout', 'timeout', true);
    if (action === 'outage') throw new ProviderError('provider error 503', 'unavailable', true);
    const r = await this.inner.complete(req);
    if (action === 'bad_json') return { ...r, text: '{"units": [ broken' };
    if (action === 'bad_refs') {
      const v = JSON.parse(r.text);
      for (const u of v.units ?? []) u.message_refs = ['m9999', ...u.message_refs];
      return { ...r, text: JSON.stringify(v) };
    }
    return r;
  }
}

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t?.close());

async function freshWorkspace() {
  const u = await createUser(t.db);
  const ws = await ensurePrivateWorkspace(t.db, u);
  const r = await loadFixtureWorkspace(t.db, ws.id, { analyze: false });
  return { ctx: { userId: u, workspaceId: ws.id, mode: 'private' } as AuthCtx, chats: r.chatIdByKey };
}

describe('provider failures', () => {
  it('retries transient 429/timeout within bounds, repairs invalid JSON once, drops invented refs', async () => {
    const { chats } = await freshWorkspace();
    let extractN = 0;
    const p = new Scripted(new FixtureModelProvider(bundle.manifest), (req) => {
      if (req.operation === 'extract') {
        extractN++;
        if (extractN === 1) return 'rate_limit';
        if (extractN === 2) return 'timeout';
        if (extractN === 3) return 'bad_json';
        if (extractN === 5) return 'bad_refs';
      }
      return 'ok';
    });
    await drainJobs({ db: t.db, provider: p, cfg: fixtureLlmConfig(), sleep: async () => undefined }, { chatIds: [chats.music] });
    const runs = await t.db.select().from(s.modelRuns).where(eq(s.modelRuns.operation, 'extract'));
    expect(runs.some((r) => r.status === 'error' && r.safeError?.startsWith('rate_limit'))).toBe(true);
    expect(runs.some((r) => r.status === 'invalid_output')).toBe(true);
    const repaired = await t.db.select().from(s.modelRuns).where(eq(s.modelRuns.operation, 'extract:repair'));
    expect(repaired[0].status).toBe('repaired');
    // Music chat fully analyzed: every eligible message has a placement; no unknown refs persisted.
    const pending = await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM messages m WHERE chat_id = ${chats.music}::uuid AND kind IN ('text','media') AND state='active' AND NOT EXISTS (SELECT 1 FROM placements p WHERE p.message_id = m.id)`);
    expect(pending.rows[0].n).toBe(0);
  });

  it('keeps sources accessible and analysis visibly failed during a provider outage, with bounded attempts', async () => {
    const { ctx, chats } = await freshWorkspace();
    const p = new Scripted(new FixtureModelProvider(bundle.manifest), () => 'outage');
    await drainJobs({ db: t.db, provider: p, cfg: { ...fixtureLlmConfig(), LLM_MAX_NETWORK_RETRIES: 2 }, sleep: async () => undefined }, { chatIds: [chats.study], swallowErrors: true, maxJobs: 3 });
    expect(p.calls.length).toBeLessThanOrEqual(9); // ≤ 3 jobs × (1 + 2 retries)
    const failed = await t.db.select().from(s.analysisJobs).where(and(eq(s.analysisJobs.chatId, chats.study), eq(s.analysisJobs.status, 'failed')));
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0].safeError).toMatch(/503/);
    const map = await getMap(t.db, ctx, chats.study, new URLSearchParams({ status: 'all' }));
    expect(map.chat_totals.message_count).toBe(100);
    expect(map.chat_totals.pending_analysis_count).toBe(100);
  });
});

describe('budget-bounded recursive refinement', () => {
  it('pauses with a persisted frontier, never flattens, and resumes under the same refinement ledger', async () => {
    const { chats } = await freshWorkspace();
    const provider = new FixtureModelProvider(bundle.manifest);
    // Tight per-job cap: each refinement the build starts gets one call, and the deeper
    // refinements it asks for share that ledger, so they pause. (The build's own allowance
    // grows with the chat's size.) Extraction runs as one call per microbatch.
    const cfg = { ...fixtureLlmConfig(), LLM_MAX_CALLS_PER_JOB: 1, LLM_EXTRACT_MAX_MESSAGES: 1000, LLM_MICROBATCH_MAX_MESSAGES: 1000, LLM_MAX_INPUT_TOKENS_PER_CALL: 200_000 };
    await drainJobs({ db: t.db, provider, cfg, sleep: async () => undefined }, { chatIds: [chats.builders] });
    const paused = await t.db.select().from(s.taxonomyFrontiers).where(and(eq(s.taxonomyFrontiers.chatId, chats.builders), eq(s.taxonomyFrontiers.status, 'budget_paused')));
    expect(paused.length).toBeGreaterThan(0);
    const jobs = await t.db.select().from(s.analysisJobs).where(and(eq(s.analysisJobs.chatId, chats.builders), eq(s.analysisJobs.status, 'budget_paused')));
    expect(jobs.length).toBeGreaterThan(0);
    const ledgerId = paused[0].logicalJobId;
    const [ledger] = await t.db.select().from(s.budgetLedger).where(eq(s.budgetLedger.logicalJobId, ledgerId));
    expect(ledger.callsUsed).toBe(1);
    const partial = await loadTree(t.db, chats.builders);
    expect(partial.maxDepth).toBeLessThan(6);
    // Resume: continuation shares the ledger; caps are NOT reset, so it pauses again until raised.
    await resumePausedFrontiers(t.db, chats.builders);
    await drainJobs({ db: t.db, provider, cfg, sleep: async () => undefined }, { chatIds: [chats.builders] });
    const [ledger2] = await t.db.select().from(s.budgetLedger).where(eq(s.budgetLedger.logicalJobId, ledgerId));
    expect(ledger2.callsUsed).toBe(1);
    // Owner raises the cap on the same ledger; refinement completes to full depth.
    await t.db.update(s.budgetLedger).set({ maxCalls: 100 }).where(eq(s.budgetLedger.logicalJobId, ledgerId));
    await resumePausedFrontiers(t.db, chats.builders);
    await drainJobs({ db: t.db, provider, cfg: { ...cfg, LLM_MAX_CALLS_PER_JOB: 100 }, sleep: async () => undefined }, { chatIds: [chats.builders] });
    const full = await loadTree(t.db, chats.builders);
    expect(full.maxDepth).toBe(6);
    const refineJobs = await t.db.select().from(s.analysisJobs).where(and(eq(s.analysisJobs.chatId, chats.builders), eq(s.analysisJobs.kind, 'refine')));
    // Refinements never draw on a build's allowance; the paused one resumed on its own ledger.
    const builds = new Set((await t.db.select().from(s.analysisJobs).where(and(eq(s.analysisJobs.chatId, chats.builders), eq(s.analysisJobs.kind, 'rebuild')))).map((j) => j.logicalJobId));
    expect(refineJobs.filter((j) => builds.has(j.logicalJobId))).toEqual([]);
    expect(refineJobs.some((j) => j.logicalJobId === ledgerId)).toBe(true);
  });
});

describe('stale results', () => {
  it('does not place a revision that was edited while its job was queued', async () => {
    const { chats } = await freshWorkspace();
    const provider = new FixtureModelProvider(bundle.manifest);
    const [m] = await t.db.select().from(s.messages).where(and(eq(s.messages.chatId, chats.music), eq(s.messages.state, 'active'), eq(s.messages.kind, 'text'))).limit(1);
    // Simulate an edit landing after dispatch: bump revision without outbox for the old job.
    const { dispatchOutbox } = await import('../src/server/ai/pipeline');
    await dispatchOutbox(t.db, fixtureLlmConfig(), { force: true });
    await t.db.update(s.messages).set({ contentRevision: m.contentRevision + 1, body: 'edited later' }).where(eq(s.messages.id, m.id));
    await drainJobs({ db: t.db, provider, cfg: fixtureLlmConfig(), sleep: async () => undefined }, { chatIds: [chats.music] });
    const pl = await t.db.select().from(s.placements).where(eq(s.placements.messageId, m.id));
    expect(pl).toEqual([]);
  });
});
