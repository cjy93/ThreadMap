import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { fixtureLlmConfig } from '../src/fixtures/load';
import type { CompletionResult, ModelProvider } from '../src/server/ai/provider';
import { BudgetExceededError, callModel, ensureLedger, phoneFingerprint } from '../src/server/ai/router';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// Each call bills 100k input + 100k output tokens at $1/$1 per million = $0.20.
class Billed implements ModelProvider {
  readonly kind = 'nebius' as const;
  calls = 0;
  modelIdFor() {
    return 'priced-model';
  }
  async complete(): Promise<CompletionResult> {
    this.calls++;
    return { text: '{"ok":true}', modelId: 'priced-model', fallback: false, usage: { input: 100_000, output: 100_000, reasoning: 0 } };
  }
}

const OWNER = '+65 9123 4567';
const cfg = {
  ...fixtureLlmConfig(),
  LLM_PROVIDER: 'nebius' as const,
  NEBIUS_PRICE_JSON: JSON.stringify({ 'priced-model': { input: 1, output: 1 } }),
  LLM_MAX_OUTPUT_TOKENS_PER_CALL: 10,
  LLM_MAX_USD_PER_USER: 0.4,
  LLM_MAX_USD_PER_JOB: 0.3,
  LLM_MAX_USD_PER_DAY: 100,
  LLM_UNLIMITED_PHONES: OWNER,
};

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t?.close());

async function workspace(phone?: string) {
  const ws = await ensurePrivateWorkspace(t.db, await createUser(t.db));
  if (phone) await t.db.insert(s.linkedAccounts).values({ workspaceId: ws.id, accountFingerprint: phoneFingerprint(phone) });
  return ws.id;
}

async function call(provider: Billed, workspaceId: string) {
  const logicalJobId = crypto.randomUUID();
  await ensureLedger(t.db, workspaceId, logicalJobId, cfg);
  return callModel({ db: t.db, provider, cfg }, { workspaceId, logicalJobId }, { role: 'fast', operation: 'test', system: 's', user: 'u', schema: z.object({ ok: z.boolean() }), schemaName: 'ok' });
}

describe('per-user inference allowance', () => {
  it('stops a public user at LLM_MAX_USD_PER_USER, across jobs', async () => {
    const p = new Billed();
    const ws = await workspace('6580000001');
    await call(p, ws);
    await call(p, ws);
    await expect(call(p, ws)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(p.calls).toBe(2);
    const [row] = await t.db.select().from(s.usageAllowance).where(eq(s.usageAllowance.subject, `wa:${phoneFingerprint('6580000001')}`));
    expect(row).toMatchObject({ usdMicrosUsed: 400_000, usdMicrosReserved: 0 });
  });

  it('keeps the allowance with the WhatsApp number when it is linked to a new workspace', async () => {
    const p = new Billed();
    await call(p, await workspace('6580000002'));
    await call(p, await workspace('6580000002'));
    await expect(call(p, await workspace('6580000002'))).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('caps an unlinked (demo) workspace on its own', async () => {
    const p = new Billed();
    const ws = await workspace();
    await call(p, ws);
    await call(p, ws);
    await expect(call(p, ws)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('lets the owner number past the user, job and daily USD caps', async () => {
    const p = new Billed();
    const ws = await workspace('6591234567');
    const logicalJobId = crypto.randomUUID();
    await ensureLedger(t.db, ws, logicalJobId, cfg);
    const dailyUsed = async () => (await t.db.select().from(s.dailyBudget)).reduce((n, d) => n + d.usdMicrosUsed, 0);
    const before = await dailyUsed();
    // Three calls in one job: $0.60, above both the $0.40 user and $0.30 job caps.
    for (let i = 0; i < 3; i++) {
      await callModel({ db: t.db, provider: p, cfg }, { workspaceId: ws, logicalJobId }, { role: 'fast', operation: 'test', system: 's', user: 'u', schema: z.object({ ok: z.boolean() }), schemaName: 'ok' });
    }
    expect(p.calls).toBe(3);
    // The owner's spend is recorded but does not use up the shared daily budget.
    expect(await dailyUsed()).toBe(before);
    const [row] = await t.db.select().from(s.usageAllowance).where(eq(s.usageAllowance.subject, `wa:${phoneFingerprint(OWNER)}`));
    expect(row.usdMicrosUsed).toBe(600_000);
  });
});

describe('per-job call cap', () => {
  it('LLM_MAX_CALLS_PER_JOB=0 means no limit', async () => {
    const p = new Billed();
    const ws = await workspace(OWNER);
    const free = { ...cfg, LLM_MAX_CALLS_PER_JOB: 0 };
    const logicalJobId = crypto.randomUUID();
    await ensureLedger(t.db, ws, logicalJobId, free);
    for (let i = 0; i < 3; i++) {
      await callModel({ db: t.db, provider: p, cfg: free }, { workspaceId: ws, logicalJobId }, { role: 'fast', operation: 'test', system: 's', user: 'u', schema: z.object({ ok: z.boolean() }), schemaName: 'ok' });
    }
    expect(p.calls).toBe(3);
  });
});
