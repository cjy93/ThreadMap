// Single-owner account lease: a session-scoped advisory lock on a dedicated
// connection (requires session pooling or a direct connection) plus a renewable
// lease row with a monotonically increasing fencing token.
import { sql } from 'drizzle-orm';
import pg from 'pg';
import type { Db, Tx } from '../db';
import { pgSslOptions } from '../db';

export class LeaseLostError extends Error {
  constructor() {
    super('account lease lost');
  }
}

export interface Lease {
  token: number;
  fence: (tx: Tx) => Promise<void>;
  release: () => Promise<void>;
  lost: Promise<void>;
}

const LEASE_TTL_MS = 30_000;
const RENEW_MS = 10_000;

export async function acquireLease(db: Db, url: string, linkedAccountId: string, ownerId: string): Promise<Lease | null> {
  const client = new pg.Client({ connectionString: url, ssl: pgSslOptions(), application_name: 'threadmap-companion-lease' });
  await client.connect();
  const r = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok`, [`tm-wa:${linkedAccountId}`]);
  if (!r.rows[0].ok) {
    await client.end();
    return null;
  }
  // Taking over locks the row FOR UPDATE, so it waits for writes still fenced by the previous
  // owner (KEY SHARE, below). Plain renewals do not, so slow writes never delay a renewal.
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM connector_leases WHERE linked_account_id = ${linkedAccountId}::uuid FOR UPDATE`);
    return tx.execute<{ fencing_token: number }>(sql`
    INSERT INTO connector_leases (linked_account_id, owner_id, fencing_token, expires_at, heartbeat_at)
    VALUES (${linkedAccountId}::uuid, ${ownerId}, 1, now() + ${`${LEASE_TTL_MS} milliseconds`}::interval, now())
    ON CONFLICT (linked_account_id) DO UPDATE SET owner_id = EXCLUDED.owner_id,
      fencing_token = connector_leases.fencing_token + 1, expires_at = EXCLUDED.expires_at, heartbeat_at = now()
    RETURNING fencing_token`);
  });
  const token = row.rows[0].fencing_token;
  let lostResolve!: () => void;
  const lost = new Promise<void>((res) => (lostResolve = res));
  let done = false;
  const markLost = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    lostResolve();
  };
  client.on('error', markLost);
  client.on('end', markLost);
  const timer = setInterval(async () => {
    try {
      await client.query('SELECT 1');
      const u = await db.execute(sql`
        UPDATE connector_leases SET expires_at = now() + ${`${LEASE_TTL_MS} milliseconds`}::interval, heartbeat_at = now()
        WHERE linked_account_id = ${linkedAccountId}::uuid AND owner_id = ${ownerId} AND fencing_token = ${token}
        RETURNING 1`);
      if (!u.rows.length) markLost();
    } catch {
      markLost();
    }
  }, RENEW_MS);
  return {
    token,
    lost,
    fence: async (tx: Tx) => {
      const ok = await tx.execute(sql`
        SELECT 1 FROM connector_leases WHERE linked_account_id = ${linkedAccountId}::uuid AND owner_id = ${ownerId}
          AND fencing_token = ${token} AND expires_at > now() FOR KEY SHARE`);
      if (!ok.rows.length || done) throw new LeaseLostError();
    },
    release: async () => {
      done = true;
      clearInterval(timer);
      // Expire (not delete) so the fencing token stays monotonic across owners.
      await db.execute(sql`UPDATE connector_leases SET expires_at = now() WHERE linked_account_id = ${linkedAccountId}::uuid AND owner_id = ${ownerId} AND fencing_token = ${token}`).catch(() => undefined);
      await client.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`tm-wa:${linkedAccountId}`]).catch(() => undefined);
      await client.end().catch(() => undefined);
    },
  };
}
