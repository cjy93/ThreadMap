import { and, eq, inArray, sql } from 'drizzle-orm';
import * as s from '../db/schema';
import type { Db } from './db';
import { ensureRoots } from './graph/tree';
import { notifyChange } from './notify';
import { SafeError } from './util';

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
 * cannot recreate it until explicit reselection.
 */
export async function deleteChat(db: Db, workspaceId: string, chatId: string, purgeObject?: (key: string) => Promise<void>) {
  const keys = await db.transaction(async (tx) => {
    const [c] = await tx.select().from(s.chats).where(and(eq(s.chats.id, chatId), eq(s.chats.workspaceId, workspaceId))).for('update');
    if (!c) throw new SafeError('chat not found', 404, 'not_found');
    await tx
      .update(s.chats)
      .set({ selected: false, excluded: true, deletionGeneration: c.deletionGeneration + 1, selectionEpoch: c.selectionEpoch + 1, sourceVersion: sql`${s.chats.sourceVersion} + 1`, graphVersion: sql`${s.chats.graphVersion} + 1`, taxonomyVersion: 0 })
      .where(eq(s.chats.id, chatId));
    await tx.execute(sql`UPDATE analysis_jobs SET status = 'cancelled' WHERE chat_id = ${chatId}::uuid AND status IN ('pending','running','budget_paused')`);
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
    return objs.rows.map((r) => r.object_key);
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
