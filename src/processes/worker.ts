// Analysis worker: durable pg-boss queue over analysis_jobs rows. Never a
// request-owned promise; restarts resume pending jobs from PostgreSQL.
import { PgBoss } from 'pg-boss';
import { sql } from 'drizzle-orm';
import * as s from '../db/schema';
import { loadLlmConfig } from '../lib/config';
import { FixtureModelProvider } from '../fixtures/model';
import { loadFixtureBundle } from '../fixtures/source';
import { dispatchOutbox, maybeScheduleInitialTaxonomy, resumeStrandedBuilds, runJob, type PipelineDeps } from '../server/ai/pipeline';
import { NebiusModelProvider, type ModelProvider, type Role } from '../server/ai/provider';
import { getDb, pgSslOptions } from '../server/db';
import { listenForever } from '../server/listen';
import { purgeExpiredDemos } from '../server/demo';
import { deleteAbandoned } from '../server/presence';
import { sweepExpired } from '../server/ingest/ingest';
import { getStorage } from '../server/storage';
import { BudgetExceededError } from '../server/ai/router';
import { inferAnswers } from '../server/api/answers';
import { answerQuestion, interpretRequest } from '../server/api/ask';
import { ASK_CHANNEL, ASK_REPLY_CHANNEL } from '../server/notify';
import pg from 'pg';

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

  // The job queue's own connections; a hosted pooler may cap the whole app (Supabase free: 15).
  const boss = new PgBoss({ connectionString: process.env.DATABASE_URL, ssl: pgSslOptions(), max: Number(process.env.PGBOSS_POOL_MAX ?? 4), schema: 'pgboss' });
  boss.on('error', (e) => log('boss_error', { error: e instanceof Error ? e.name : 'unknown' }));
  await boss.start();
  await boss.createQueue(QUEUE, { retryLimit: 2, retryBackoff: true, retryDelay: 10 }).catch(() => undefined);
  const deps = provider ? ({ db, provider, cfg } satisfies PipelineDeps) : null;

  // Ask: the web process sends questions here because only this process holds the model key.
  if (deps) {
    const onAsk = (n: pg.Notification) => {
      void (async () => {
        let id = '';
        try {
          const req = JSON.parse(n.payload ?? '{}') as { id: string; kind?: 'answer' | 'answers'; workspaceId: string; chatIds: string[]; question: string; messageIds?: string[]; messageId?: string };
          id = req.id;
          const r =
            req.kind === 'answer'
              ? await answerQuestion(deps, req.workspaceId, req.chatIds, req.question, req.messageIds ?? [])
              : req.kind === 'answers'
                ? await inferAnswers(deps, req.workspaceId, req.messageId ?? '')
                : await interpretRequest(deps, req.workspaceId, req.chatIds, req.question);
          await db.execute(sql`SELECT pg_notify(${ASK_REPLY_CHANNEL}, ${JSON.stringify({ id, ok: true, ...r })})`);
        } catch (e) {
          // The reason (e.g. "prompt too large", "provider overloaded") carries no chat content.
          log('ask_failed', { error: e instanceof Error ? `${e.name}: ${e.message.slice(0, 120)}` : 'unknown' });
          // Tell the page why, so it does not claim Nemotron was merely slow.
          const reason = e instanceof BudgetExceededError ? `budget_${e.scope}` : 'error';
          if (id) await db.execute(sql`SELECT pg_notify(${ASK_REPLY_CHANNEL}, ${JSON.stringify({ id, ok: false, reason })})`).catch(() => undefined);
        }
      })();
    };
    await listenForever({ url: process.env.DATABASE_URL, application: 'threadmap-worker-ask', channels: [ASK_CHANNEL], onNotification: onAsk });
  }

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
        WHERE u.assigned_topic_id IS NULL AND c.taxonomy_version = 0 AND (c.selected OR c.map_of IS NOT NULL) AND w.mode = 'private'`);
      for (const r of waiting.rows) await maybeScheduleInitialTaxonomy(db, r.chat_id);
      // A map build that failed partway resumes on its own (picked up below as a pending job).
      const resumed = await resumeStrandedBuilds(db);
      if (resumed.length) log('builds_resumed', { count: resumed.length });
      // Durable recovery: a pending private job with no live queue entry is (re)submitted.
      // singletonKey does not de-duplicate on a standard pg-boss queue, so resubmitting every
      // pending job each tick piled up thousands of copies and starved new jobs behind them.
      const pending = await db.execute<{ id: string }>(sql`
        SELECT a.id FROM analysis_jobs a JOIN workspaces w ON w.id = a.workspace_id
        WHERE a.status = 'pending' AND w.mode = 'private'
          AND NOT EXISTS (SELECT 1 FROM pgboss.job j WHERE j.name = ${QUEUE} AND j.state IN ('created', 'retry', 'active') AND j.data->>'jobId' = a.id::text)
        LIMIT 200`);
      await enqueue(pending.rows.map((p) => p.id));
      // Jobs left 'running' by a crashed worker are reset to pending after 10 minutes.
      await db.execute(sql`UPDATE analysis_jobs SET status = 'pending' WHERE status = 'running' AND started_at < now() - interval '10 minutes'`);
      // Jobs paused by the account allowance or the day's budget try again every few minutes, so
      // raising the allowance (or a new day) carries on by itself; while the budget still blocks
      // them they pause again before any model call. A job's own call cap (runaway guard) stays paused.
      const retried = await db.execute(sql`
        UPDATE analysis_jobs SET status = 'pending', safe_error = NULL
        WHERE status = 'budget_paused' AND (safe_error LIKE '%(user)%' OR safe_error LIKE '%(day)%')
          AND completed_at < now() - interval '5 minutes'`);
      if (retried.rowCount) log('budget_paused_retried', { count: retried.rowCount });
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
    // Accounts with no ThreadMap page open for a while are deleted (see presence.ts).
    void deleteAbandoned(db)
      .then((n) => n && log('accounts_auto_deleted', { count: n }))
      .catch(() => undefined);
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
