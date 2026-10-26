// Discover exact Nemotron model IDs from the authenticated Token Factory
// catalog and capability-test Ultra/Nano/Super with the real output schemas.
// Writes nonsecret results to reports/live-inference.json (merging).
import fs from 'node:fs';
import { loadLlmConfig } from '../lib/config';
import { capabilityPrompt } from '../server/ai/prompts';
import { extractJson, NebiusModelProvider, ProviderError, type Role } from '../server/ai/provider';
import { CapabilitySchema, ExtractionSchema, JSON_SCHEMAS, PROMPT_VERSION, SCHEMA_VERSION } from '../server/ai/schemas';

const PREFERRED: Record<Role, RegExp> = {
  reasoning: /nemotron-3-ultra/i,
  fast: /nemotron-3-nano/i,
  balanced: /nemotron-3-super/i,
};

async function main() {
  const cfg = loadLlmConfig();
  const report: Record<string, unknown> = { generated_at: new Date().toISOString(), endpoint: cfg.NEBIUS_BASE_URL, prompt_version: PROMPT_VERSION, schema_version: SCHEMA_VERSION };
  if (!cfg.NEBIUS_API_KEY) {
    report.status = 'BLOCKED_EXTERNAL';
    report.blocker = 'NEBIUS_API_KEY is not configured in this environment';
    write(report);
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const provider = new NebiusModelProvider(cfg);
  const catalog = await provider.listModels();
  const nemotron = catalog.filter((m) => /nemotron/i.test(m));
  const resolved: Record<string, string | null> = {};
  for (const role of ['reasoning', 'fast', 'balanced'] as Role[]) {
    const configured = role === 'reasoning' ? cfg.NEBIUS_MODEL_REASONING : role === 'fast' ? cfg.NEBIUS_MODEL_FAST : cfg.NEBIUS_MODEL_BALANCED;
    resolved[role] = configured && catalog.includes(configured) ? configured : (catalog.find((m) => PREFERRED[role].test(m)) ?? null);
  }
  report.catalog_nemotron = nemotron;
  report.resolved = resolved;
  const checks: Record<string, unknown> = {};
  for (const role of ['reasoning', 'fast', 'balanced'] as Role[]) {
    const id = resolved[role];
    if (!id) {
      checks[role] = { status: 'FAIL', reason: 'no matching model in the account catalog' };
      continue;
    }
    const roleCfg = { ...cfg, NEBIUS_MODEL_REASONING: id, NEBIUS_MODEL_FAST: id, NEBIUS_MODEL_BALANCED: id };
    const p = new NebiusModelProvider(roleCfg);
    const result: Record<string, unknown> = { model_id: id };
    for (const mode of ['json_schema', 'json_object'] as const) {
      if (mode === 'json_schema') p.jsonSchemaRoles.add(role);
      else p.jsonSchemaRoles.delete(role);
      const t0 = Date.now();
      try {
        const cp = capabilityPrompt(role);
        const r = await p.complete({ role, operation: 'capability', ...cp, maxOutputTokens: 2048, schemaName: 'capability', jsonSchema: JSON_SCHEMAS.capability });
        const ok = CapabilitySchema.safeParse(JSON.parse(extractJson(r.text))).success;
        // Real extraction-schema check on a tiny synthetic sample.
        const ex = await p.complete({
          role,
          operation: 'capability-extract',
          system: 'Segment the messages into discussion units. Return {"units":[{"unit_key","primary_root","discussion_title","topic_terms","message_refs","summary_bullets":[{"text","evidence_refs"}],"resource_refs","needs_review"}]}. primary_root is KNOWLEDGE, GENERAL_CHAT or RESOURCES. JSON only.',
          user: JSON.stringify({ messages: [{ ref: 'm1', sender: 'A', text: 'Rotate refresh tokens on every use.' }, { ref: 'm2', sender: 'B', text: 'Meet at 7pm?' }] }),
          maxOutputTokens: 2048,
          schemaName: 'extraction',
          jsonSchema: JSON_SCHEMAS.extraction,
        });
        const exOk = ExtractionSchema.safeParse(JSON.parse(extractJson(ex.text))).success;
        result[mode] = { capability_ok: ok, extraction_schema_ok: exOk, duration_ms: Date.now() - t0, returned_model: r.modelId, usage: r.usage };
      } catch (e) {
        result[mode] = { error: e instanceof ProviderError ? `${e.kind}: ${e.message}` : 'unexpected error', duration_ms: Date.now() - t0 };
      }
    }
    checks[role] = result;
  }
  report.capability = checks;
  report.recommended_env = {
    NEBIUS_MODEL_REASONING: resolved.reasoning,
    NEBIUS_MODEL_FAST: resolved.fast,
    NEBIUS_MODEL_BALANCED: resolved.balanced,
    NEBIUS_JSON_SCHEMA_ROLES: (['reasoning', 'fast', 'balanced'] as Role[]).filter((r) => (checks[r] as Record<string, { extraction_schema_ok?: boolean }>)?.json_schema?.extraction_schema_ok).join(','),
  };
  write(report);
  console.log(JSON.stringify(report, null, 2));
}

function write(r: Record<string, unknown>) {
  fs.mkdirSync('reports', { recursive: true });
  const p = 'reports/live-inference.json';
  const prev = fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>) : {};
  fs.writeFileSync(p, JSON.stringify({ ...prev, discovery: r }, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
