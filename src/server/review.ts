// ThreadMap Read/Missed review state: per user, per canonical message, and
// revision-aware. Independent of WhatsApp receipts (no WhatsApp calls here).
import { and, eq, sql } from 'drizzle-orm';
import * as s from '../db/schema';
import type { Db, Tx } from './db';
import { matchingMessagesSql, type ContentFilter } from './graph/filters';
import { descendantIds, loadTree } from './graph/tree';
import { notifyChange } from './notify';
import { SafeError } from './util';

export interface ReviewScope {
  userId: string;
  workspaceId: string;
}

async function bumpReview(tx: Tx, scope: ReviewScope, chatId: string) {
  const [r] = await tx
    .insert(s.reviewVersions)
    .values({ userId: scope.userId, chatId, version: 1 })
    .onConflictDoUpdate({ target: [s.reviewVersions.userId, s.reviewVersions.chatId], set: { version: sql`${s.reviewVersions.version} + 1` } })
    .returning({ v: s.reviewVersions.version });
  await notifyChange(tx, { ws: scope.workspaceId, kind: 'review', chatId, version: r.v, userId: scope.userId });
  return r.v;
}

/**
 * Mark one message Read (for the observed revision) or Missed. A stale Read for
 * an older revision is rejected so a newer edit stays Missed.
 */
export async function setReview(
  db: Db,
  scope: ReviewScope,
  input: { messageId: string; status: 'read' | 'missed'; observedRevision: number; source: 'dwell' | 'manual' },
) {
  return db.transaction(async (tx) => {
    const [m] = await tx
      .select({ id: s.messages.id, chatId: s.messages.chatId, rev: s.messages.contentRevision, state: s.messages.state, kind: s.messages.kind })
      .from(s.messages)
      .where(and(eq(s.messages.id, input.messageId), eq(s.messages.workspaceId, scope.workspaceId)))
      .for('update');
    if (!m) throw new SafeError('message not found', 404, 'not_found');
    if (m.state !== 'active' || (m.kind !== 'text' && m.kind !== 'media')) {
      throw new SafeError('this record is not a reviewable message', 400, 'not_reviewable');
    }
    if (input.status === 'read' && input.observedRevision !== m.rev) {
      return { applied: false, reason: 'revision_changed' as const, currentRevision: m.rev };
    }
    await tx
      .insert(s.reviewState)
      .values({
        userId: scope.userId,
        messageId: m.id,
        status: input.status,
        reviewedRevision: input.status === 'read' ? m.rev : null,
        readAt: input.status === 'read' ? new Date() : null,
      })
      .onConflictDoUpdate({
        target: [s.reviewState.userId, s.reviewState.messageId],
        set: {
          status: input.status,
          reviewedRevision: input.status === 'read' ? m.rev : null,
          readAt: input.status === 'read' ? new Date() : null,
          updatedAt: sql`now()`,
        },
      });
    const v = await bumpReview(tx, scope, m.chatId);
    return { applied: true, reason: null, currentRevision: m.rev, reviewVersion: v };
  });
}

/**
 * Freeze the exact (message id, current revision) pairs a bulk action will
 * touch: the complete matching subtree of a node (including hidden/unloaded
 * descendants and beyond the first content page). Depth is not an input.
 */
export async function createBulkSnapshot(db: Db, scope: ReviewScope, chatId: string, nodeId: string | null, filter: ContentFilter, mapChatId = chatId) {
  const [chat] = await db.select().from(s.chats).where(and(eq(s.chats.id, chatId), eq(s.chats.workspaceId, scope.workspaceId)));
  if (!chat) throw new SafeError('chat not found', 404, 'not_found');
  // Marking a topic Read also clears the filler in it, though the map does not list it.
  const matching = matchingMessagesSql({ userId: scope.userId, workspaceId: scope.workspaceId, chatIds: [chatId] }, { ...filter, includeFiller: true });
  let rows: { id: string; content_revision: number }[];
  if (nodeId) {
    const tree = await loadTree(db, mapChatId);
    let membership;
    if (tree.nodes.has(nodeId)) {
      const ids = descendantIds(tree, nodeId);
      membership = sql`SELECT p.message_id FROM placements p WHERE p.chat_id = ${mapChatId}::uuid AND p.topic_id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`;
    } else {
      membership = sql`SELECT p.message_id FROM placements p WHERE p.chat_id = ${mapChatId}::uuid AND p.discussion_id = ${nodeId}::uuid`;
    }
    rows = (await db.execute<{ id: string; content_revision: number }>(sql`
      WITH mt AS (${matching}) SELECT DISTINCT mt.id, mt.content_revision FROM mt WHERE mt.id IN (${membership}) ORDER BY mt.id`)).rows;
  } else {
    rows = (await db.execute<{ id: string; content_revision: number }>(sql`WITH mt AS (${matching}) SELECT mt.id, mt.content_revision FROM mt ORDER BY mt.id`)).rows;
  }
  const [snap] = await db
    .insert(s.bulkReviewSnapshots)
    .values({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      chatId,
      scope: { nodeId, filter },
      pairs: rows.map((r) => ({ m: r.id, r: r.content_revision })),
    })
    .returning({ id: s.bulkReviewSnapshots.id });
  // Small talk is marked too (it stays out of the map's counts), so say how much of the total it is.
  const filler = rows.length
    ? (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM messages WHERE filler AND id IN (${sql.join(rows.map((r) => sql`${r.id}::uuid`), sql`, `)})`)).rows[0].n
    : 0;
  return { snapshotId: snap.id, count: rows.length, filler };
}

/** Apply a frozen snapshot. Idempotent: re-execution returns the first result. */
export async function executeBulk(db: Db, scope: ReviewScope, snapshotId: string, target: 'read' | 'missed') {
  return db.transaction(async (tx) => {
    const [snap] = await tx
      .select()
      .from(s.bulkReviewSnapshots)
      .where(and(eq(s.bulkReviewSnapshots.id, snapshotId), eq(s.bulkReviewSnapshots.userId, scope.userId), eq(s.bulkReviewSnapshots.workspaceId, scope.workspaceId)))
      .for('update');
    if (!snap) throw new SafeError('bulk selection not found', 404, 'not_found');
    if (snap.executedAt) return snap.result as { updated: number; changedRevision: number; unavailable: number; target: string };
    const pairs = snap.pairs;
    let updated = 0;
    let changedRevision = 0;
    let unavailable = 0;
    if (pairs.length) {
      const r = await tx.execute<{ id: string; content_revision: number; state: string }>(sql`
        SELECT m.id, m.content_revision, m.state FROM messages m
        WHERE m.workspace_id = ${scope.workspaceId}::uuid AND m.id IN (${sql.join(pairs.map((p) => sql`${p.m}::uuid`), sql`, `)})
        FOR UPDATE`);
      const current = new Map(r.rows.map((x) => [x.id, x]));
      const apply: { m: string; r: number }[] = [];
      for (const p of pairs) {
        const c = current.get(p.m);
        if (!c || c.state !== 'active') unavailable++;
        else if (c.content_revision !== p.r) changedRevision++;
        else apply.push(p);
      }
      const now = new Date();
      for (let i = 0; i < apply.length; i += 1000) {
        await tx
          .insert(s.reviewState)
          .values(
            apply.slice(i, i + 1000).map((p) => ({
              userId: scope.userId,
              messageId: p.m,
              status: target,
              reviewedRevision: target === 'read' ? p.r : null,
              readAt: target === 'read' ? now : null,
            })),
          )
          .onConflictDoUpdate({
            target: [s.reviewState.userId, s.reviewState.messageId],
            set: {
              status: sql`excluded.status`,
              reviewedRevision: sql`excluded.reviewed_revision`,
              readAt: sql`excluded.read_at`,
              updatedAt: sql`now()`,
            },
          });
      }
      updated = apply.length;
    }
    const result = { updated, changedRevision, unavailable, target };
    await tx.update(s.bulkReviewSnapshots).set({ executedAt: new Date(), result }).where(eq(s.bulkReviewSnapshots.id, snapshotId));
    await bumpReview(tx, scope, snap.chatId);
    return result;
  });
}
