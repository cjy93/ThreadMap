import crypto from 'node:crypto';
import pg from 'pg';
import { createPool, dbFromPool, type Db } from '../../src/server/db';
import { runMigrations } from '../../src/server/migrate';
import * as s from '../../src/db/schema';

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://threadmap:devpass@127.0.0.1:5432/threadmap';

export interface TestDb {
  db: Db;
  pool: pg.Pool;
  url: string;
  close(): Promise<void>;
}

/** A fresh, migrated database per test file (dropped afterwards). */
export async function createTestDb(): Promise<TestDb> {
  const name = `tm_test_${crypto.randomBytes(5).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(ADMIN_URL);
  u.pathname = `/${name}`;
  const url = u.toString();
  await runMigrations(url);
  const pool = createPool(url, { max: 8, application: 'threadmap-test' });
  return {
    db: dbFromPool(pool),
    pool,
    url,
    async close() {
      await pool.end();
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export async function createUser(db: Db, id = `u_${crypto.randomBytes(4).toString('hex')}`) {
  await db.insert(s.user).values({ id, name: id, email: `${id}@example.test`, emailVerified: true });
  return id;
}
