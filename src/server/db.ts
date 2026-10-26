import fs from 'node:fs';
import type { Env } from '../lib/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '../db/schema';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

// Return BIGINT/COUNT as JS numbers; all our counters are far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

/**
 * TLS settings for the Managed PostgreSQL private endpoint. In hosted mode the
 * CA must be supplied and certificates are always verified (hostname included).
 */
export function pgSslOptions(env: Env = process.env): pg.PoolConfig['ssl'] {
  const caPem = env.DATABASE_CA_CERT ?? (env.DATABASE_CA_CERT_FILE ? fs.readFileSync(env.DATABASE_CA_CERT_FILE, 'utf8') : undefined);
  if (caPem) return { ca: caPem, rejectUnauthorized: true };
  if (env.APP_MODE === 'hosted') {
    throw new Error('hosted mode requires DATABASE_CA_CERT or DATABASE_CA_CERT_FILE for verified TLS');
  }
  return undefined;
}

export function createPool(url: string | undefined, opts: { max?: number; application?: string } = {}): pg.Pool {
  if (!url) throw new Error('database URL is not configured');
  const cleaned = stripSslParams(url);
  return new pg.Pool({
    connectionString: cleaned,
    ssl: pgSslOptions(),
    max: opts.max ?? Number(process.env.DB_POOL_MAX ?? 5),
    application_name: opts.application ?? 'threadmap',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

/** sslmode in the URL would override our verified-TLS options; strip it. */
function stripSslParams(url: string): string {
  try {
    const u = new URL(url);
    for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return url;
  }
}

let shared: { pool: pg.Pool; db: Db } | undefined;

/** Process-wide pool using the URL for this process (DATABASE_URL by default). */
export function getDb(urlEnv = 'DATABASE_URL'): Db {
  if (!shared) {
    const pool = createPool(process.env[urlEnv] ?? process.env.DATABASE_URL, {
      application: process.env.PROCESS_NAME ?? 'threadmap',
    });
    shared = { pool, db: drizzle(pool, { schema }) };
  }
  return shared.db;
}

export function getPool(): pg.Pool {
  getDb();
  return shared!.pool;
}

export function dbFromPool(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}

export async function closeDb(): Promise<void> {
  if (shared) {
    const p = shared.pool;
    shared = undefined;
    await p.end();
  }
}
