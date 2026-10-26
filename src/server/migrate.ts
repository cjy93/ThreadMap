import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createPool } from './db';

const MIGRATION_LOCK_KEY = 0x7468_6d70; // 'thmp'

export function migrationsFolder(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../db/migrations');
}

/** Run all pending migrations while holding a session advisory lock. */
export async function runMigrations(url: string | undefined, folder = migrationsFolder()): Promise<void> {
  const pool = createPool(url, { max: 2, application: 'threadmap-migrate' });
  const lockClient = await pool.connect();
  try {
    await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await migrate(drizzle(pool), { migrationsFolder: folder });
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    lockClient.release();
    await pool.end();
  }
}
