// Isolated synthetic demo workspaces for public guests. Each guest gets its own
// workspace seeded from the labeled fixture replay; pairing is never allowed.
import { and, eq, lt, sql } from 'drizzle-orm';
import * as s from '../db/schema';
import { loadFixtureWorkspace } from '../fixtures/load';
import type { Db } from './db';
import { getStorage } from './storage';

const DEMO_TTL_MS = 24 * 60 * 60 * 1000;

export async function ensureDemoWorkspace(db: Db, userId: string) {
  const [existing] = await db.select().from(s.workspaces).where(and(eq(s.workspaces.ownerUserId, userId), eq(s.workspaces.mode, 'demo')));
  if (existing) return existing;
  const [ws] = await db
    .insert(s.workspaces)
    .values({ ownerUserId: userId, mode: 'demo', name: 'ThreadMap demo (synthetic replay)', expiresAt: new Date(Date.now() + DEMO_TTL_MS) })
    .onConflictDoNothing()
    .returning();
  if (!ws) return (await db.select().from(s.workspaces).where(and(eq(s.workspaces.ownerUserId, userId), eq(s.workspaces.mode, 'demo'))))[0];
  await loadFixtureWorkspace(db, ws.id, { storage: getStorage() });
  return ws;
}

/**
 * Remove expired demo workspaces and WhatsApp link attempts that were never
 * scanned; deleting the anonymous user cascades to all its data. Claimed
 * accounts are not anonymous and have no expiry, so they are never touched.
 */
export async function purgeExpiredDemos(db: Db) {
  const expired = await db.select().from(s.workspaces).where(lt(s.workspaces.expiresAt, new Date()));
  for (const w of expired) {
    await db.execute(sql`DELETE FROM "user" WHERE id = ${w.ownerUserId} AND is_anonymous`);
  }
  return expired.length;
}
