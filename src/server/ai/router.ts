// Model router: budget reservation, bounded network retries, schema validation
// with one repair call, and a model_runs record per attempt.
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { LlmConfig } from '../../lib/config';
import * as s from '../../db/schema';
import type { Db } from '../db';
import { sleep } from '../util';
import { extractJson, ProviderError, type FixtureHints, type ModelProvider, type Role } from './provider';
import { PROMPT_VERSION, SCHEMA_VERSION } from './schemas';

/** Retries for a busy provider (429/503/529), however low LLM_MAX_NETWORK_RETRIES is set. */
const BUSY_RETRIES = 4;

export class BudgetExceededError extends Error {
  constructor(readonly scope: 'job' | 'day') {
    super(`inference budget exhausted (${scope})`);
  }
}
export class InvalidOutputError extends Error {}

export interface RouterDeps {
  db: Db;
  provider: ModelProvider;
  cfg: LlmConfig;
  sleep?: (ms: number) => Promise<void>;
  /** Counts provider invocations (tests assert zero for navigation paths). */
  onCall?: (role: Role, operation: string) => void;
}

export interface CallScope {
  workspaceId: string;
  logicalJobId: string;
  jobId?: string | null;
}

const usdMicros = (usd: number) => Math.round(usd * 1_000_000);
const today = () => new Date().toISOString().slice(0, 10);

function prices(cfg: LlmConfig): Record<string, { input: number; output: number }> {
  if (!cfg.NEBIUS_PRICE_JSON) return {};
  try {
    return JSON.parse(cfg.NEBIUS_PRICE_JSON) as Record<string, { input: number; output: number }>;
  } catch {
    return {};
  }
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.2);
}

/** Create the ledger for a logical job; continuations reuse (never reset) it. */
export async function ensureLedger(db: Db, workspaceId: string, logicalJobId: string, cfg: LlmConfig) {
  await db
    .insert(s.budgetLedger)
    .values({ logicalJobId, workspaceId, maxCalls: cfg.LLM_MAX_CALLS_PER_JOB, maxUsdMicros: usdMicros(cfg.LLM_MAX_USD_PER_JOB) })
    .onConflictDoNothing();
}

async function reserve(db: Db, logicalJobId: string, cfg: LlmConfig, estMicros: number) {
  const job = await db.execute(sql`
    UPDATE budget_ledger SET calls_reserved = calls_reserved + 1, usd_micros_reserved = usd_micros_reserved + ${estMicros}, updated_at = now()
    WHERE logical_job_id = ${logicalJobId}::uuid
      AND calls_reserved + calls_used < max_calls
      AND usd_micros_reserved + usd_micros_used + ${estMicros} <= max_usd_micros
    RETURNING logical_job_id`);
  if (!job.rows.length) throw new BudgetExceededError('job');
  const day = today();
  await db.execute(sql`INSERT INTO daily_budget (day, max_usd_micros) VALUES (${day}, ${usdMicros(cfg.LLM_MAX_USD_PER_DAY)}) ON CONFLICT DO NOTHING`);
  const d = await db.execute(sql`
    UPDATE daily_budget SET usd_micros_reserved = usd_micros_reserved + ${estMicros}, calls = calls + 1
    WHERE day = ${day} AND usd_micros_reserved + usd_micros_used + ${estMicros} <= max_usd_micros
    RETURNING day`);
  if (!d.rows.length) {
    await db.execute(sql`UPDATE budget_ledger SET calls_reserved = calls_reserved - 1, usd_micros_reserved = usd_micros_reserved - ${estMicros} WHERE logical_job_id = ${logicalJobId}::uuid`);
    throw new BudgetExceededError('day');
  }
  return day;
}

async function settle(db: Db, logicalJobId: string, day: string, estMicros: number, actualMicros: number, tokens: { input: number; output: number }) {
  await db.execute(sql`
    UPDATE budget_ledger SET calls_reserved = calls_reserved - 1, calls_used = calls_used + 1,
      usd_micros_reserved = usd_micros_reserved - ${estMicros}, usd_micros_used = usd_micros_used + ${actualMicros},
      input_tokens = input_tokens + ${tokens.input}, output_tokens = output_tokens + ${tokens.output}, updated_at = now()
    WHERE logical_job_id = ${logicalJobId}::uuid`);
  await db.execute(sql`
    UPDATE daily_budget SET usd_micros_reserved = usd_micros_reserved - ${estMicros}, usd_micros_used = usd_micros_used + ${actualMicros}
    WHERE day = ${day}`);
}

export interface ModelCall<T> {
  role: Role;
  operation: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  schemaName: string;
  jsonSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
  hints?: FixtureHints;
  /** Override the provider's per-role reasoning default. */
  thinking?: boolean;
  /** Images for the vision role. */
  images?: { mime: string; b64: string }[];
}

export interface ModelCallResult<T> {
  value: T;
  modelId: string;
  fallback: boolean;
  repaired: boolean;
  calls: number;
}

export async function callModel<T>(deps: RouterDeps, scope: CallScope, call: ModelCall<T>): Promise<ModelCallResult<T>> {
  const { db, provider, cfg } = deps;
  const wait = deps.sleep ?? sleep;
  // Vision models bill an image at a few hundred tokens (measured: 258 for Nemotron VL).
  const inTokens = estimateTokens(call.system + call.user) + (call.images?.length ?? 0) * 800;
  if (inTokens > cfg.LLM_MAX_INPUT_TOKENS_PER_CALL * 1.5) {
    throw new InvalidOutputError(`prompt too large (${inTokens} est. tokens); caller must split input`);
  }
  const maxOut = Math.min(call.maxOutputTokens ?? cfg.LLM_MAX_OUTPUT_TOKENS_PER_CALL, cfg.LLM_MAX_OUTPUT_TOKENS_PER_CALL);
  const priceTable = prices(cfg);
  let calls = 0;

  const attempt = async (role: Role, operation: string, system: string, user: string, attemptNo: number, thinking = call.thinking) => {
    const modelId = provider.modelIdFor(role);
    const p = priceTable[modelId];
    const est = p ? usdMicros((inTokens * p.input + maxOut * p.output) / 1_000_000) : 0;
    const day = await reserve(db, scope.logicalJobId, cfg, est);
    const started = Date.now();
    calls++;
    deps.onCall?.(role, operation);
    try {
      const r = await provider.complete({ role, operation, system, user, maxOutputTokens: maxOut, schemaName: call.schemaName, jsonSchema: call.jsonSchema, fixtureHints: call.hints, thinking, images: call.images });
      const actual = p && r.usage.input !== null && r.usage.output !== null ? usdMicros((r.usage.input * p.input + r.usage.output * p.output) / 1_000_000) : est;
      await settle(db, scope.logicalJobId, day, est, actual, { input: r.usage.input ?? 0, output: r.usage.output ?? 0 });
      return { r, started, actual, modelId };
    } catch (e) {
      await settle(db, scope.logicalJobId, day, est, 0, { input: 0, output: 0 });
      await db.insert(s.modelRuns).values({
        workspaceId: scope.workspaceId,
        logicalJobId: scope.logicalJobId,
        jobId: scope.jobId ?? null,
        role,
        provider: provider.kind,
        modelId,
        operation,
        promptVersion: PROMPT_VERSION,
        schemaVersion: SCHEMA_VERSION,
        status: 'error',
        attempt: attemptNo,
        durationMs: Date.now() - started,
        safeError: e instanceof ProviderError ? `${e.kind}: ${e.message}` : 'unexpected provider failure',
      });
      throw e;
    }
  };

  // Network retries (bounded, exponential backoff with jitter).
  let res: Awaited<ReturnType<typeof attempt>> | undefined;
  for (let i = 0; ; i++) {
    try {
      res = await attempt(call.role, call.operation, call.system, call.user, i + 1);
      break;
    } catch (e) {
      // A busy provider (rate limit, overload) gets more tries and longer pauses: 5, 10, 20, 40 s.
      const busy = e instanceof ProviderError && (e.kind === 'rate_limit' || e.kind === 'overloaded');
      if (e instanceof ProviderError && e.retryable && i < (busy ? Math.max(cfg.LLM_MAX_NETWORK_RETRIES, BUSY_RETRIES) : cfg.LLM_MAX_NETWORK_RETRIES)) {
        await wait(busy ? 5_000 * 2 ** i : Math.min(30_000, 500 * 2 ** i) + Math.floor(Math.random() * 250));
        continue;
      }
      throw e;
    }
  }

  const log = async (status: 'ok' | 'invalid_output' | 'repaired', r: NonNullable<typeof res>, role: Role, operation: string, attemptNo: number) => {
    await db.insert(s.modelRuns).values({
      workspaceId: scope.workspaceId,
      logicalJobId: scope.logicalJobId,
      jobId: scope.jobId ?? null,
      role,
      provider: provider.kind,
      modelId: r.r.modelId,
      fallback: r.r.fallback,
      operation,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      status,
      attempt: attemptNo,
      inputTokens: r.r.usage.input,
      outputTokens: r.r.usage.output,
      reasoningTokens: r.r.usage.reasoning,
      usdMicros: r.actual,
      durationMs: Date.now() - r.started,
    });
  };

  const parse = (text: string): { ok: true; value: T } | { ok: false; error: string } => {
    let json: unknown;
    try {
      json = JSON.parse(extractJson(text));
    } catch {
      return { ok: false, error: 'output was not valid JSON' };
    }
    const p = call.schema.safeParse(json);
    if (!p.success) return { ok: false, error: p.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    return { ok: true, value: p.data };
  };

  const first = res.r.truncated ? ({ ok: false, error: 'output truncated at max_tokens' } as const) : parse(res.r.text);
  if (first.ok) {
    await log('ok', res, call.role, call.operation, 1);
    return { value: first.value, modelId: res.r.modelId, fallback: res.r.fallback, repaired: false, calls };
  }
  await log('invalid_output', res, call.role, call.operation, 1);
  if (process.env.DEBUG_MODEL_VALIDATION) console.error('model output validation failed', call.operation, first.error);
  if (cfg.LLM_MAX_SCHEMA_REPAIRS < 1) throw new InvalidOutputError(first.error);

  // One bounded repair call via the balanced (Super) role.
  const repairSystem = `${call.system}\nYour previous output failed validation: ${first.error}. Return corrected JSON only.`;
  const repairUser = `${call.user}\n\nPREVIOUS_OUTPUT:\n${res.r.text.slice(0, 6000)}`;
  // Repair is mechanical; a reasoning trace would only eat the output budget.
  const rep = await attempt('balanced', `${call.operation}:repair`, repairSystem, repairUser, 2, false);
  const second = rep.r.truncated ? ({ ok: false, error: 'repair output truncated at max_tokens' } as const) : parse(rep.r.text);
  if (!second.ok) {
    await log('invalid_output', rep, 'balanced', `${call.operation}:repair`, 2);
    throw new InvalidOutputError(second.error);
  }
  await log('repaired', rep, 'balanced', `${call.operation}:repair`, 2);
  return { value: second.value, modelId: res.r.modelId, fallback: res.r.fallback, repaired: true, calls };
}
