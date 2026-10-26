// A18 live check: feed fresh synthetic normalized events through the REAL
// pipeline on Token Factory (Nano extraction, Ultra recursive taxonomy with
// refinement frontiers, Super escalation/link verification) in an isolated
// workspace, then record nonsecret evidence to reports/live-inference.json.
// Usage: DATABASE_URL=... NEBIUS_API_KEY=... NEBIUS_MODEL_*=... node dist/cli/live-inference.js
import crypto from 'node:crypto';
import fs from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import * as s from '../db/schema';
import { loadLlmConfig } from '../lib/config';
import { loadFixtureWorkspace } from '../fixtures/load';
import { drainJobs } from '../server/ai/drain';
import { NebiusModelProvider, type Role } from '../server/ai/provider';
import { PROMPT_VERSION, SCHEMA_VERSION } from '../server/ai/schemas';
import { closeDb, getDb } from '../server/db';
import { ancestors, loadTree } from '../server/graph/tree';
import { ensurePrivateWorkspace } from '../server/workspace';

async function main() {
  const cfg = loadLlmConfig();
  const out: Record<string, unknown> = { generated_at: new Date().toISOString(), endpoint: cfg.NEBIUS_BASE_URL, prompt_version: PROMPT_VERSION, schema_version: SCHEMA_VERSION, evidence: 'fresh synthetic normalized events (labeled fixture content), real Token Factory inference' };
  if (!cfg.NEBIUS_API_KEY || !cfg.NEBIUS_MODEL_REASONING || !cfg.NEBIUS_MODEL_FAST || !cfg.NEBIUS_MODEL_BALANCED) {
    out.status = 'BLOCKED_EXTERNAL';
    out.blocker = 'NEBIUS_API_KEY and NEBIUS_MODEL_REASONING/FAST/BALANCED must be configured (run models:discover first)';
    return finish(out);
  }
  const db = getDb();
  const uid = `live-inference-${crypto.randomBytes(4).toString('hex')}`;
  await db.insert(s.user).values({ id: uid, name: 'live inference check', email: `${uid}@example.invalid`, emailVerified: false });
  const ws = await ensurePrivateWorkspace(db, uid, 'A18 live inference (synthetic)');
  const { chatIdByKey } = await loadFixtureWorkspace(db, ws.id, { analyze: false });
  const provider = new NebiusModelProvider(cfg);
  for (const r of (process.env.NEBIUS_JSON_SCHEMA_ROLES ?? '').split(',').filter(Boolean)) provider.jsonSchemaRoles.add(r as Role);
  const chats = [chatIdByKey.builders, chatIdByKey.study];
  const t0 = Date.now();
  const ran = await drainJobs({ db, provider, cfg }, { chatIds: chats, swallowErrors: true, maxJobs: Number(process.env.A18_MAX_JOBS ?? 60) });
  out.duration_ms = Date.now() - t0;
  out.jobs = ran.reduce<Record<string, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});

  const runs = await db.select().from(s.modelRuns).where(eq(s.modelRuns.workspaceId, ws.id));
  const byRole: Record<string, unknown> = {};
  for (const role of ['reasoning', 'fast', 'balanced']) {
    const rr = runs.filter((r) => r.role === role);
    byRole[role] = {
      model_ids: [...new Set(rr.map((r) => r.modelId))],
      calls: rr.length,
      ok: rr.filter((r) => r.status === 'ok' || r.status === 'repaired').length,
      invalid_output: rr.filter((r) => r.status === 'invalid_output').length,
      errors: rr.filter((r) => r.status === 'error').map((r) => r.safeError).slice(0, 5),
      fallback_used: rr.some((r) => r.fallback),
      operations: [...new Set(rr.map((r) => r.operation))],
      input_tokens: rr.reduce((n, r) => n + (r.inputTokens ?? 0), 0),
      output_tokens: rr.reduce((n, r) => n + (r.outputTokens ?? 0), 0),
      p50_duration_ms: pct(rr.map((r) => r.durationMs), 0.5),
      p95_duration_ms: pct(rr.map((r) => r.durationMs), 0.95),
    };
  }
  out.roles = byRole;

  const depth: Record<string, unknown> = {};
  for (const [k, id] of Object.entries({ builders: chatIdByKey.builders, study: chatIdByKey.study })) {
    const tree = await loadTree(db, id);
    const modelTopics = [...tree.nodes.values()].filter((n) => n.provenance === 'model');
    const deepest = modelTopics.sort((a, b) => b.depth - a.depth)[0];
    const placements = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM placements WHERE chat_id = ${id}::uuid AND provenance = 'model'`);
    const frontiers = await db.select().from(s.taxonomyFrontiers).where(eq(s.taxonomyFrontiers.chatId, id));
    depth[k] = {
      model_topic_count: modelTopics.length,
      observed_max_topic_depth: tree.maxDepth,
      deepest_model_path: deepest ? ancestors(tree, deepest.id).map((a) => a.title) : [],
      model_placements: placements.rows[0].n,
      frontiers: frontiers.reduce<Record<string, number>>((m, f) => ((m[f.status] = (m[f.status] ?? 0) + 1), m), {}),
      ultra_path_beyond_two_levels: Boolean(deepest && deepest.depth > 2),
    };
  }
  out.taxonomy = depth;
  const links = await db.select().from(s.crossChatLinks).where(eq(s.crossChatLinks.workspaceId, ws.id));
  out.cross_chat_links = { verified: links.filter((l) => l.status === 'verified').length, rejected: links.filter((l) => l.status === 'rejected').length, verifier_models: [...new Set(links.map((l) => l.verifierModel))] };
  const ledgers = await db.select().from(s.budgetLedger).where(eq(s.budgetLedger.workspaceId, ws.id));
  out.budget = { calls_used: ledgers.reduce((n, l) => n + l.callsUsed, 0), usd_used_estimate: ledgers.reduce((n, l) => n + l.usdMicrosUsed, 0) / 1e6, price_table_configured: Boolean(cfg.NEBIUS_PRICE_JSON) };
  const anyDeep = Object.values(depth).some((d) => (d as { ultra_path_beyond_two_levels: boolean }).ultra_path_beyond_two_levels);
  const allRoles = ['reasoning', 'fast', 'balanced'].every((r) => (byRole[r] as { ok: number }).ok > 0);
  out.status = anyDeep && allRoles && links.some((l) => l.verifierModel) ? 'PASS' : 'FAIL';
  out.workspace_note = 'isolated synthetic workspace; delete with the cleanup flag after review';
  if (process.argv.includes('--cleanup')) await db.delete(s.user).where(and(eq(s.user.id, uid)));
  await closeDb();
  finish(out);
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(p * a.length))];
};

function finish(out: Record<string, unknown>) {
  fs.mkdirSync('reports', { recursive: true });
  const p = 'reports/live-inference.json';
  const prev = fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>) : {};
  fs.writeFileSync(p, JSON.stringify({ ...prev, a18_pipeline: out }, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
