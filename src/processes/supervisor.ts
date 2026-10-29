// Container entrypoint: supervises web, companion and worker as separate Node
// processes with per-child environment allowlists, signal forwarding, reaping
// and bounded restart backoff. The three children share one container trust
// boundary; the allowlist reduces accidental exposure only.
import type { Env } from '../lib/config';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const COMMON = ['NODE_ENV', 'APP_MODE', 'PATH', 'HOME', 'TZ', 'DATABASE_CA_CERT', 'DATABASE_CA_CERT_FILE', 'DATABASE_REQUIRE_TLS', 'DB_POOL_MAX', 'DEPLOYMENT_ID', 'PUBLIC_ORIGIN_MODE', 'STORAGE_DRIVER', 'LOCAL_STORAGE_DIR', 'S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'FIXTURE_DIR', 'MAX_ATTACHMENT_MIB', 'MAX_MEDIA_CACHE_MIB'];

export interface ChildSpec {
  name: 'web' | 'companion' | 'worker';
  cmd: string[];
  allow: string[];
  dbUrlFrom: string;
  extra?: Record<string, string>;
}

const ROOT = process.env.APP_ROOT ?? path.resolve(process.cwd());

export const CHILDREN: ChildSpec[] = [
  {
    name: 'web',
    cmd: ['node', path.join(ROOT, 'server.js')],
    dbUrlFrom: 'DATABASE_URL',
    allow: ['PORT', 'APP_URL', 'BETTER_AUTH_URL', 'BETTER_AUTH_SECRET', 'PUBLIC_DEMO_ENABLED', 'PUBLIC_DEMO_PAIRING_ENABLED', 'WHATSAPP_PAIRING_ENABLED', 'WHATSAPP_HISTORY_MAX_MESSAGES_PER_CHAT', 'SOURCE_PROVIDER', 'DEFAULT_DISPLAY_TIMEZONE', 'AUTO_READ_DWELL_MS', 'MAP_DEFAULT_TOPIC_DEPTH', 'MAP_MAX_VISIBLE_NODES', 'MAP_CONTENT_PAGE_SIZE', 'MAP_NODE_MIN_DIAMETER_PX', 'MAP_NODE_MAX_DIAMETER_PX', 'MAP_NODE_SIZE_REFERENCE_COUNT'],
    extra: { HOSTNAME: '0.0.0.0', LLM_PROVIDER: 'fixture' },
  },
  {
    name: 'companion',
    cmd: ['node', path.join(ROOT, 'dist', 'companion.js')],
    dbUrlFrom: 'COMPANION_DATABASE_URL',
    allow: ['WHATSAPP_AUTH_ENCRYPTION_KEY', 'WHATSAPP_INITIAL_SYNC_MODE', 'WHATSAPP_HISTORY_MAX_MESSAGES_PER_CHAT', 'WHATSAPP_PRESELECTION_BUFFER_MIB', 'WHATSAPP_PRESELECTION_BUFFER_TTL_SECONDS', 'WHATSAPP_MARK_ONLINE_ON_CONNECT', 'MEDIA_DOWNLOAD_MODE'],
  },
  {
    name: 'worker',
    cmd: ['node', path.join(ROOT, 'dist', 'worker.js')],
    dbUrlFrom: 'WORKER_DATABASE_URL',
    allow: ['LLM_PROVIDER', 'NEBIUS_API_KEY', 'NEBIUS_BASE_URL', 'NEBIUS_MODEL_REASONING', 'NEBIUS_MODEL_FAST', 'NEBIUS_MODEL_BALANCED', 'NEBIUS_MODEL_VISION', 'ALLOW_REASONING_FALLBACK', 'NEBIUS_MODEL_REASONING_FALLBACK', 'NEBIUS_PRICE_JSON', 'NEBIUS_JSON_SCHEMA_ROLES', 'NEBIUS_THINKING_OFF_ROLES', 'LLM_EXTRACT_MAX_MESSAGES', 'LLM_MAX_USD_PER_JOB', 'LLM_MAX_USD_PER_DAY', 'LLM_MAX_CALLS_PER_JOB', 'LLM_MAX_USD_PER_USER', 'LLM_UNLIMITED_PHONES', 'LLM_MICROBATCH_MAX_MESSAGES', 'LLM_MICROBATCH_MAX_WAIT_MS', 'LLM_MAX_INPUT_TOKENS_PER_CALL', 'LLM_MAX_OUTPUT_TOKENS_PER_CALL', 'LLM_CONCURRENCY', 'LLM_HTTP_TIMEOUT_MS', 'LLM_MAX_NETWORK_RETRIES', 'LLM_MAX_SCHEMA_REPAIRS', 'AUTO_DELETE_AFTER_MINUTES', 'CROSS_CHAT_LINKS', 'PGBOSS_POOL_MAX', 'TAVILY_API_KEY', 'STUDY_MAP_MAX_SEARCHES'],
  },
];

export function childEnv(spec: ChildSpec, env: Env): Env {
  const out: Env = { PROCESS_NAME: spec.name };
  for (const k of [...COMMON, ...spec.allow]) if (env[k] !== undefined) out[k] = env[k];
  // Per-child pool size (e.g. COMPANION_DB_POOL_MAX) overrides the shared DB_POOL_MAX.
  const ownPool = env[`${spec.name.toUpperCase()}_DB_POOL_MAX`];
  if (ownPool !== undefined) out.DB_POOL_MAX = ownPool;
  out.DATABASE_URL = env[spec.dbUrlFrom] ?? env.DATABASE_URL;
  return { ...out, ...spec.extra };
}

const log = (msg: string, meta: Record<string, string | number> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), proc: 'supervisor', msg, ...meta }));

export function supervise(children = CHILDREN, env = process.env) {
  const running = new Map<string, ChildProcess>();
  const restarts = new Map<string, number[]>();
  let stopping = false;

  const launch = (spec: ChildSpec) => {
    const child = spawn(spec.cmd[0], spec.cmd.slice(1), { env: childEnv(spec, env) as NodeJS.ProcessEnv, stdio: ['ignore', 'inherit', 'inherit'] });
    running.set(spec.name, child);
    log('child_started', { child: spec.name, pid: child.pid ?? -1 });
    child.on('exit', (code, signal) => {
      running.delete(spec.name);
      if (stopping) return;
      const now = Date.now();
      const recent = (restarts.get(spec.name) ?? []).filter((t) => now - t < 10 * 60_000);
      recent.push(now);
      restarts.set(spec.name, recent);
      if (recent.length > 8) {
        // A permanently failing child must not hide behind a healthy container.
        log('child_crash_loop', { child: spec.name });
        void shutdown(1);
        return;
      }
      const delay = Math.min(60_000, 1000 * 2 ** (recent.length - 1));
      log('child_exited', { child: spec.name, code: code ?? -1, signal: signal ?? 'none', restart_in_ms: delay });
      setTimeout(() => !stopping && launch(spec), delay);
    });
  };

  const shutdown = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    log('stopping');
    for (const c of running.values()) c.kill('SIGTERM');
    const deadline = Date.now() + 25_000;
    while (running.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    for (const c of running.values()) c.kill('SIGKILL');
    process.exit(code);
  };

  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGINT', () => void shutdown(0));
  for (const c of children) launch(c);
  return { shutdown, running };
}

if (process.argv[1] && /supervisor\.(js|ts)$/.test(process.argv[1])) supervise();
