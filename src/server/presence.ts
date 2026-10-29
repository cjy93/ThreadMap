// Delete-on-leave: forgetting "Disconnect and delete my data" must not leave a
// WhatsApp link and stored chats behind. Every open ThreadMap page checks in each
// minute; when no page of a private account has checked in for
// AUTO_DELETE_AFTER_MINUTES (30 by default; 0 switches this off), the account is
// deleted exactly as that button does: the companion unlinks the device from the
// phone, then deletes the account with its chats, messages, maps and files.
// A browser cannot reliably report being closed (reloads, crashes, sleep), so
// absence of check-ins is the signal.
import { and, eq, lt, sql } from 'drizzle-orm';
import * as s from '../db/schema';
import type { Db } from './db';
import { COMMAND_CHANNEL } from './api/connector';

export const autoDeleteMinutes = () => {
  const v = Number(process.env.AUTO_DELETE_AFTER_MINUTES ?? 30);
  return Number.isFinite(v) && v >= 0 ? v : 30;
};

/** An open page of a private account checked in; viewing the demo (by owner) counts too. */
export async function markSeen(db: Db, workspaceId: string, ownerUserId?: string) {
  const which = ownerUserId ? eq(s.workspaces.ownerUserId, ownerUserId) : eq(s.workspaces.id, workspaceId);
  await db.update(s.workspaces).set({ lastSeenAt: new Date() }).where(and(which, eq(s.workspaces.mode, 'private')));
  return { ok: true, delete_after_minutes: autoDeleteMinutes() };
}

/**
 * Worker tick: delete private accounts no page has checked in on for the set time.
 * Queued once per account (idempotency key); the companion does the deleting.
 * Returns how many accounts were queued.
 */
export async function deleteAbandoned(db: Db): Promise<number> {
  const minutes = autoDeleteMinutes();
  if (minutes === 0) return 0;
  const cutoff = new Date(Date.now() - minutes * 60_000);
  const gone = await db
    .select({ id: s.workspaces.id, owner: s.workspaces.ownerUserId })
    .from(s.workspaces)
    .where(and(eq(s.workspaces.mode, 'private'), lt(s.workspaces.lastSeenAt, cutoff)));
  let queued = 0;
  for (const ws of gone) {
    const [la] = await db.select({ id: s.linkedAccounts.id }).from(s.linkedAccounts).where(eq(s.linkedAccounts.workspaceId, ws.id));
    if (!la) {
      // Never linked a phone: nothing to unlink, so delete the account here.
      await db.delete(s.user).where(eq(s.user.id, ws.owner));
      queued++;
      continue;
    }
    const [cmd] = await db
      .insert(s.connectorCommands)
      .values({ workspaceId: ws.id, linkedAccountId: la.id, type: 'delete_account', payload: { reason: 'no_page_open' }, idempotencyKey: `auto-delete:${ws.id}` })
      .onConflictDoNothing()
      .returning({ id: s.connectorCommands.id });
    if (!cmd) continue; // already queued
    // Browsers still signed in are signed out; their next request lands on the start page.
    await db.delete(s.session).where(eq(s.session.userId, ws.owner));
    await db.execute(sql`SELECT pg_notify(${COMMAND_CHANNEL}, ${la.id})`);
    queued++;
  }
  return queued;
}
