import { sql } from 'drizzle-orm';
import { getDb } from './db';
import { trustedOrigin } from './origin';

const STALE_MS = 90_000;

export async function readiness() {
  const db = getDb();
  const checks: Record<string, boolean> = { database: false, origin_configured: false, companion_heartbeat: false, worker_heartbeat: false };
  try {
    await db.execute(sql`SELECT 1`);
    checks.database = true;
    checks.origin_configured = Boolean(await trustedOrigin(db));
    const hb = await db.execute<{ process_name: string; heartbeat_at: Date }>(sql`SELECT process_name, heartbeat_at FROM process_heartbeats`);
    for (const r of hb.rows) {
      const fresh = Date.now() - new Date(r.heartbeat_at).getTime() < STALE_MS;
      if (r.process_name === 'companion') checks.companion_heartbeat = fresh;
      if (r.process_name === 'worker') checks.worker_heartbeat = fresh;
    }
  } catch {
    /* reported as not ready */
  }
  return { ready: checks.database && checks.origin_configured, checks };
}
