import crypto from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as s from '../db/schema';
import type { Db, Tx } from './db';
import { ensureRoots } from './graph/tree';
import { notifyChange } from './notify';
import { SafeError } from './util';

// After a chat is first opened, its history keeps arriving from the phone for a few minutes.
export const FIRST_OPEN_ANALYSIS_MS = 10 * 60 * 1000;

export async function ensurePrivateWorkspace(db: Db, userId: string, name = 'My workspace') {
  const [existing] = await db.select().from(s.workspaces).where(and(eq(s.workspaces.ownerUserId, userId), eq(s.workspaces.mode, 'private')));
  if (existing) return existing;
  const [ws] = await db.insert(s.workspaces).values({ ownerUserId: userId, mode: 'private', name }).onConflictDoNothing().returning();
  return ws ?? (await db.select().from(s.workspaces).where(and(eq(s.workspaces.ownerUserId, userId), eq(s.workspaces.mode, 'private'))))[0];
}

export async function ensureLinkedAccount(db: Db, workspaceId: string) {
  const [la] = await db.select().from(s.linkedAccounts).where(eq(s.linkedAccounts.workspaceId, workspaceId));
  if (la) return la;
  const [created] = await db.insert(s.linkedAccounts).values({ workspaceId }).onConflictDoNothing().returning();
  const row = created ?? (await db.select().from(s.linkedAccounts).where(eq(s.linkedAccounts.workspaceId, workspaceId)))[0];
  await db.insert(s.connectionStatus).values({ linkedAccountId: row.id }).onConflictDoNothing();
  return row;
}

export interface SelectionInput {
  chatId: string;
  selected: boolean;
  historyMode?: 'available_history' | 'new_only';
  /** When opening: how many older messages to import (null = the deployment's cap). */
  historyLimit?: number | null;
}

/**
 * Apply chat selection. Selecting bumps the selection epoch, creates the three
 * fixed roots and (for new-only) freezes a UTC cutoff. Deselecting stops
 * future capture and invalidates not-yet-dispatched analysis; indexed data is
 * retained until explicitly deleted.
 */
export async function applySelections(db: Db, workspaceId: string, items: SelectionInput[], now = new Date()) {
  const ids = items.map((i) => i.chatId);
  if (!ids.length) return [];
  const chats = await db.select().from(s.chats).where(and(eq(s.chats.workspaceId, workspaceId), inArray(s.chats.id, ids)));
  if (chats.length !== new Set(ids).size) throw new SafeError('unknown chat in selection', 400, 'invalid_chat');
  const out = [];
  for (const item of items) {
    const res = await db.transaction(async (tx) => {
      const [c] = await tx.select().from(s.chats).where(eq(s.chats.id, item.chatId)).for('update');
      if (item.selected) {
        const reselect = !c.selected;
        const mode = item.historyMode ?? c.historyMode;
        const [u] = await tx
          .update(s.chats)
          .set({
            selected: true,
            excluded: false,
            paused: false,
            selectionEpoch: reselect ? c.selectionEpoch + 1 : c.selectionEpoch,
            historyMode: mode,
            // A fresh cutoff only when switching to new-only; never silently shifted.
            newOnlyCutoff: mode === 'new_only' ? (c.historyMode === 'new_only' && c.newOnlyCutoff ? c.newOnlyCutoff : now) : null,
            // First open: analyse the history arriving over the next few minutes; later messages wait for Refresh.
            ...(reselect ? { autoAnalyzeUntil: new Date(now.getTime() + FIRST_OPEN_ANALYSIS_MS), historyLimit: item.historyLimit ?? null } : {}),
          })
          .where(eq(s.chats.id, c.id))
          .returning();
        await ensureRoots(tx, workspaceId, c.id);
        await tx.insert(s.syncCoverage).values({ chatId: c.id }).onConflictDoNothing();
        return u;
      }
      const [u] = await tx.update(s.chats).set({ selected: false, selectionEpoch: c.selectionEpoch + 1 }).where(eq(s.chats.id, c.id)).returning();
      await tx.delete(s.analysisOutbox).where(and(eq(s.analysisOutbox.chatId, c.id), sql`${s.analysisOutbox.dispatchedJobId} IS NULL`));
      await tx.execute(sql`UPDATE analysis_jobs SET status = 'cancelled' WHERE chat_id = ${c.id}::uuid AND status = 'pending'`);
      return u;
    });
    out.push({ chatId: res.id, selected: res.selected, historyMode: res.historyMode, cutoff: res.newOnlyCutoff, epoch: res.selectionEpoch });
  }
  await notifyChange(db, { ws: workspaceId, kind: 'chats' });
  return out;
}

/**
 * Delete an indexed chat: unsubscribe first (deselect + generation bump), then
 * purge content and derivatives, keeping a minimal exclusion marker so replay
 * cannot recreate it until explicit reselection. With `keepAvatar` (unopening)
 * the chat stays in the list of chats to open with its profile photo, like any
 * chat that was never opened.
 */
export async function deleteChat(db: Db, workspaceId: string, chatId: string, purgeObject?: (key: string) => Promise<void>, opts: { keepAvatar?: boolean } = {}) {
  const keys = await db.transaction(async (tx) => {
    const [c] = await tx.select().from(s.chats).where(and(eq(s.chats.id, chatId), eq(s.chats.workspaceId, workspaceId))).for('update');
    if (!c) throw new SafeError('chat not found', 404, 'not_found');
    await tx
      .update(s.chats)
      .set({ ...(opts.keepAvatar ? {} : { avatarKey: null, avatarCheckedAt: null }), selected: false, excluded: true, deletionGeneration: c.deletionGeneration + 1, selectionEpoch: c.selectionEpoch + 1, sourceVersion: sql`${s.chats.sourceVersion} + 1`, graphVersion: sql`${s.chats.graphVersion} + 1`, taxonomyVersion: 0 })
      .where(eq(s.chats.id, chatId));
    await tx.execute(sql`UPDATE analysis_jobs SET status = 'cancelled' WHERE chat_id = ${chatId}::uuid AND status IN ('pending','running','budget_paused')`);
    // Its one-sided maps ("Map from: You / Others") go entirely.
    const sideMaps = await tx.select({ id: s.chats.id }).from(s.chats).where(eq(s.chats.mapOf, chatId));
    for (const m of sideMaps) {
      await tx.execute(sql`UPDATE analysis_jobs SET status = 'cancelled' WHERE chat_id = ${m.id}::uuid AND status IN ('pending','running','budget_paused')`);
      await tx.execute(sql`DELETE FROM cross_chat_links WHERE a_chat_id = ${m.id}::uuid OR b_chat_id = ${m.id}::uuid`);
      for (const table of ['summary_claims', 'analysis_units', 'taxonomy_frontiers', 'placements', 'discussions', 'topic_merge_map', 'taxonomy_overrides', 'user_chat_view_preferences']) {
        await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE chat_id = ${m.id}::uuid`);
      }
      await deleteTopicsLeafFirst(tx, m.id);
      await tx.delete(s.chats).where(eq(s.chats.id, m.id));
    }
    const objs = await tx.execute<{ object_key: string }>(sql`SELECT a.object_key FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.chat_id = ${chatId}::uuid AND a.object_key IS NOT NULL`);
    // Purge derived and canonical content (cascade covers revisions/attachments/placements/reviews).
    await tx.execute(sql`DELETE FROM cross_chat_links WHERE a_chat_id = ${chatId}::uuid OR b_chat_id = ${chatId}::uuid`);
    await tx.execute(sql`DELETE FROM summary_claims WHERE chat_id = ${chatId}::uuid`);
    await tx.execute(sql`DELETE FROM analysis_units WHERE chat_id = ${chatId}::uuid`);
    await tx.execute(sql`DELETE FROM taxonomy_frontiers WHERE chat_id = ${chatId}::uuid`);
    await tx.execute(sql`DELETE FROM analysis_outbox WHERE chat_id = ${chatId}::uuid`);
    await tx.execute(sql`DELETE FROM placements WHERE chat_id = ${chatId}::uuid`);
    await tx.execute(sql`DELETE FROM discussions WHERE chat_id = ${chatId}::uuid`);
    await tx.execute(sql`DELETE FROM messages WHERE chat_id = ${chatId}::uuid`);
    await tx.execute(sql`DELETE FROM control_events WHERE chat_id = ${chatId}::uuid`);
    await tx.execute(sql`DELETE FROM topic_merge_map WHERE chat_id = ${chatId}::uuid`);
    await tx.execute(sql`DELETE FROM taxonomy_overrides WHERE chat_id = ${chatId}::uuid`);
    await tx.execute(sql`DELETE FROM user_chat_view_preferences WHERE chat_id = ${chatId}::uuid`);
    // Topics: delete leaves first (parent FK is RESTRICT).
    await deleteTopicsLeafFirst(tx, chatId);
    await tx.update(s.syncCoverage).set({ historyState: 'not_requested', earliestAt: null, latestAt: null, historyCount: 0, liveCount: 0, warnings: [] }).where(eq(s.syncCoverage.chatId, chatId));
    await notifyChange(tx, { ws: workspaceId, kind: 'chats', chatId });
    return [...objs.rows.map((r) => r.object_key), ...(c.avatarKey && !opts.keepAvatar ? [c.avatarKey] : [])];
  });
  if (purgeObject) for (const k of keys) await purgeObject(k).catch(() => undefined);
  return { purgedObjects: keys.length };
}

async function deleteTopicsLeafFirst(tx: Parameters<Parameters<Db['transaction']>[0]>[0], chatId: string) {
  for (let i = 0; i < 10_000; i++) {
    const r = await tx.execute(sql`
      DELETE FROM topics t WHERE t.chat_id = ${chatId}::uuid
        AND NOT EXISTS (SELECT 1 FROM topics c WHERE c.parent_id = t.id)
      RETURNING t.id`);
    if (!r.rows.length) break;
  }
}

// ---------------------------------------------------------------------------
// WhatsApp is the sign-in. A browser starts with an anonymous session and a
// short-lived pending workspace; scanning the QR claims it. There is no
// password: possession of the phone is the credential, every time.
// ---------------------------------------------------------------------------
export const PENDING_LINK_TTL_MS = 60 * 60 * 1000;

/** Pending private workspace for this session's user (reused if present), ready to pair. */
export async function startWhatsAppLogin(db: Db, user: { id: string; isAnonymous: boolean }) {
  const [existing] = await db.select().from(s.workspaces).where(and(eq(s.workspaces.ownerUserId, user.id), eq(s.workspaces.mode, 'private')));
  if (existing) return existing;
  if (!user.isAnonymous) throw new SafeError('this account has no WhatsApp workspace', 403, 'no_workspace');
  // A demo guest who chooses to connect leaves the synthetic replay behind.
  await db.delete(s.workspaces).where(and(eq(s.workspaces.ownerUserId, user.id), eq(s.workspaces.mode, 'demo')));
  const [ws] = await db
    .insert(s.workspaces)
    .values({ ownerUserId: user.id, mode: 'private', name: 'Pending WhatsApp link', expiresAt: new Date(Date.now() + PENDING_LINK_TTL_MS) })
    .onConflictDoNothing()
    .returning();
  return ws ?? (await db.select().from(s.workspaces).where(and(eq(s.workspaces.ownerUserId, user.id), eq(s.workspaces.mode, 'private'))))[0];
}

/** Other linked accounts already bound to this WhatsApp number. */
export async function accountsWithFingerprint(db: Db | Tx, fingerprint: string, exceptAccountId: string): Promise<string[]> {
  const rows = await db
    .select({ id: s.linkedAccounts.id })
    .from(s.linkedAccounts)
    .where(and(eq(s.linkedAccounts.accountFingerprint, fingerprint), sql`${s.linkedAccounts.id} <> ${exceptAccountId}::uuid`));
  return rows.map((r) => r.id);
}

export type ClaimOutcome =
  | { outcome: 'same' }
  | { outcome: 'mismatch' }
  | { outcome: 'fresh'; workspaceId: string; replacedAccountIds: string[]; purgeKeys: string[] };

/**
 * Every QR scan starts from scratch. The scanned device gets a brand-new, empty
 * account; every earlier account for this number, and the scanning browser's
 * previous workspace, is deleted with all its data; the browser's sessions move
 * to the new account. A reconnect from saved credentials (freshScan=false) keeps
 * everything. The linked-account row keeps its id, because its stored
 * credentials are sealed to it. Returns stored-object keys for the caller to purge.
 */
export async function claimWhatsAppIdentity(db: Db, accountId: string, fingerprint: string, opts: { freshScan: boolean }): Promise<ClaimOutcome> {
  return db.transaction(async (tx) => {
    const [la] = await tx.select().from(s.linkedAccounts).where(eq(s.linkedAccounts.id, accountId)).for('update');
    if (la.accountFingerprint && !opts.freshScan) return la.accountFingerprint === fingerprint ? { outcome: 'same' } : { outcome: 'mismatch' };

    const [ws] = await tx.select().from(s.workspaces).where(eq(s.workspaces.id, la.workspaceId));
    const replacedAccountIds = await accountsWithFingerprint(tx, fingerprint, accountId);
    const priorWs = replacedAccountIds.length
      ? (await tx.select({ ws: s.linkedAccounts.workspaceId }).from(s.linkedAccounts).where(inArray(s.linkedAccounts.id, replacedAccountIds))).map((r) => r.ws)
      : [];
    const doomedWs = [...new Set([ws.id, ...priorWs])];
    const doomedUsers = [...new Set((await tx.select({ u: s.workspaces.ownerUserId }).from(s.workspaces).where(inArray(s.workspaces.id, doomedWs))).map((r) => r.u))];
    const keys = await tx.execute<{ k: string }>(sql`
      SELECT a.object_key AS k FROM attachments a WHERE a.workspace_id IN (${sql.join(doomedWs.map((w) => sql`${w}::uuid`), sql`, `)}) AND a.object_key IS NOT NULL
      UNION SELECT c.avatar_key FROM chats c WHERE c.workspace_id IN (${sql.join(doomedWs.map((w) => sql`${w}::uuid`), sql`, `)}) AND c.avatar_key IS NOT NULL`);

    // A brand-new owner and workspace; the email is final once the old account is gone.
    const userId = crypto.randomUUID();
    await tx.insert(s.user).values({ id: userId, name: 'WhatsApp account', email: `wa-pending-${userId}@whatsapp.threadmap.invalid`, isAnonymous: false });
    const [fresh] = await tx.insert(s.workspaces).values({ ownerUserId: userId, mode: 'private', name: 'My WhatsApp' }).returning();
    await tx
      .update(s.linkedAccounts)
      .set({ workspaceId: fresh.id, accountFingerprint: fingerprint, desiredState: 'active', updatedAt: new Date() })
      .where(eq(s.linkedAccounts.id, accountId));
    await tx.update(s.session).set({ userId }).where(eq(s.session.userId, ws.ownerUserId));
    // Deleting the old owners cascades to their workspaces, chats, messages, maps and old devices.
    await tx.delete(s.user).where(inArray(s.user.id, doomedUsers));
    await tx.update(s.user).set({ email: `wa-${fingerprint.slice(0, 32)}@whatsapp.threadmap.invalid` }).where(eq(s.user.id, userId));
    return { outcome: 'fresh', workspaceId: fresh.id, replacedAccountIds, purgeKeys: keys.rows.map((r) => r.k) };
  });
}

/**
 * Delete a ThreadMap account and everything in it (workspaces, chats, messages,
 * maps, linked devices, sign-ins). Returns stored-object keys (files, photos)
 * for the caller to purge. The companion calls this after logging the device out.
 */
export async function deleteAccountData(db: Db, userId: string): Promise<string[]> {
  return db.transaction(async (tx) => {
    const keys = await tx.execute<{ k: string }>(sql`
      SELECT a.object_key AS k FROM attachments a JOIN workspaces w ON w.id = a.workspace_id WHERE w.owner_user_id = ${userId} AND a.object_key IS NOT NULL
      UNION SELECT c.avatar_key FROM chats c JOIN workspaces w ON w.id = c.workspace_id WHERE w.owner_user_id = ${userId} AND c.avatar_key IS NOT NULL`);
    await tx.delete(s.user).where(eq(s.user.id, userId));
    return keys.rows.map((r) => r.k);
  });
}
