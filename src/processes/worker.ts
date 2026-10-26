// Analysis worker: durable pg-boss queue over analysis_jobs rows. Never a
// request-owned promise; restarts resume pending jobs from PostgreSQL.
import { PgBoss } from 'pg-boss';
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as s from '../db/schema';
import { loadLlmConfig } from '../lib/config';
import { FixtureModelProvider } from '../fixtures/model';
import { loadFixtureBundle } from '../fixtures/source';
import { dispatchOutbox, maybeScheduleInitialTaxonomy, runJob, type PipelineDeps } from '../server/ai/pipeline';
import { NebiusModelProvider, type ModelProvider, type Role } from '../server/ai/provider';
import { getDb, pgSslOptions } from '../server/db';
import { purgeExpiredDemos } from '../server/demo';
import { sweepExpired } from '../server/ingest/ingest';
import { getStorage } from '../server/storage';

const QUEUE = 'tm-analysis';
const log = (msg: string, meta: Record<string, string | number | boolean | null> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), proc: 'worker', msg, ...meta }));

async function main() {
  const db = getDb();
  const cfg = loadLlmConfig();
  let provider: ModelProvider | null = null;
  if (cfg.LLM_PROVIDER === 'fixture') {
    provider = new FixtureModelProvider(loadFixtureBundle().manifest);
    log('provider', { kind: 'fixture', note: 'development mode; not live inference' });
  } else if (cfg.NEBIUS_API_KEY) {
    const p = new NebiusModelProvider(cfg);
    for (const r of (process.env.NEBIUS_JSON_SCHEMA_ROLES ?? '').split(',').filter(Boolean)) p.jsonSchemaRoles.add(r as Role);
    provider = p;
    log('provider', { kind: 'nebius' });
  } else {
    log('provider_missing', { note: 'NEBIUS_API_KEY not configured; sources are captured and analysis stays pending' });
  }

  const boss = new PgBoss({ connectionString: process.env.DATABASE_URL, ssl: pgSslOptions(), max: 4, schema: 'pgboss' });
  boss.on('error', (e) => log('boss_error', { error: e instanceof Error ? e.name : 'unknown' }));
  await boss.start();
  await boss.createQueue(QUEUE, { retryLimit: 2, retryBackoff: true, retryDelay: 10 }).catch(() => undefined);
  const deps = provider ? ({ db, provider, cfg } satisfies PipelineDeps) : null;

  const enqueue = async (ids: string[]) => {
    for (const id of ids) await boss.send(QUEUE, { jobId: id }, { singletonKey: id });
  };

  if (deps) {
    await boss.work<{ jobId: string }>(QUEUE, { localConcurrency: Math.max(1, cfg.LLM_CONCURRENCY), pollingIntervalSeconds: 1 }, async (jobs) => {
      for (const job of jobs) {
        const out = await runJob(deps, job.data.jobId);
        log('job_done', { job: job.data.jobId.slice(0, 8), status: out.status, followUps: out.followUps.length });
        await enqueue(out.followUps);
      }
    });
  }

  const heartbeat = async () => {
    await db
      .insert(s.processHeartbeats)
      .values({ processName: 'worker', instanceId: String(process.pid), detail: { provider: provider?.kind ?? 'none' } })
      .onConflictDoUpdate({ target: s.processHeartbeats.processName, set: { heartbeatAt: new Date(), detail: { provider: provider?.kind ?? 'none' } } });
  };

  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await heartbeat();
      if (!deps) return;
      await dispatchOutbox(db, cfg);
      // Debounced initial taxonomy for chats whose extraction has settled.
      const waiting = await db.execute<{ chat_id: string }>(sql`
        SELECT DISTINCT u.chat_id FROM analysis_units u JOIN chats c ON c.id = u.chat_id
        JOIN workspaces w ON w.id = c.workspace_id
        WHERE u.assigned_topic_id IS NULL AND c.taxonomy_version = 0 AND c.selected AND w.mode = 'private'`);
      for (const r of waiting.rows) await maybeScheduleInitialTaxonomy(db, r.chat_id);
      // Durable recovery: every pending private job is (re)submitted idempotently.
      const pending = await db
        .select({ id: s.analysisJobs.id })
        .from(s.analysisJobs)
        .innerJoin(s.workspaces, eq(s.workspaces.id, s.analysisJobs.workspaceId))
        .where(and(inArray(s.analysisJobs.status, ['pending']), eq(s.workspaces.mode, 'private')))
        .limit(200);
      await enqueue(pending.map((p) => p.id));
      // Jobs left 'running' by a crashed worker are reset to pending after 10 minutes.
      await db.execute(sql`UPDATE analysis_jobs SET status = 'pending' WHERE status = 'running' AND started_at < now() - interval '10 minutes'`);
    } catch (e) {
      log('tick_failed', { error: e instanceof Error ? e.name : 'unknown' });
    } finally {
      busy = false;
    }
  };
  const t1 = setInterval(() => void tick(), 1000);
  const t2 = setInterval(() => {
    void sweepExpired(db, getStorage()).catch(() => undefined);
    void purgeExpiredDemos(db).catch(() => undefined);
  }, 60_000);
  await tick();
  log('started');

  const stop = async () => {
    clearInterval(t1);
    clearInterval(t2);
    await boss.stop({ graceful: true, timeout: 20_000 }).catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}

main().catch((e) => {
  log('fatal', { error: e instanceof Error ? e.message.slice(0, 160) : 'unknown' });
  process.exit(1);
});
