// Recursive topic tree: one representation under every root, stable IDs,
// parent references, derived depth, and validated same-root subtree edits.
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import * as s from '../../db/schema';
import type { DbOrTx, Tx } from '../db';
import { notifyChange } from '../notify';
import { SafeError } from '../util';

export const ROOTS = ['KNOWLEDGE', 'GENERAL_CHAT', 'RESOURCES'] as const;
export type RootEnum = (typeof ROOTS)[number];
export const ROOT_LABELS: Record<RootEnum, string> = {
  KNOWLEDGE: 'Knowledge',
  GENERAL_CHAT: 'General Chat',
  RESOURCES: 'Resources',
};

export interface TreeNode {
  id: string;
  parentId: string | null;
  root: RootEnum;
  kind: 'CATEGORY' | 'TOPIC';
  title: string;
  depth: number;
  childIds: string[];
  needsReview: boolean;
  provenance: string;
}

export interface Tree {
  chatId: string;
  nodes: Map<string, TreeNode>;
  roots: TreeNode[];
  maxDepth: number;
}

/** Create the three fixed category roots for a chat if missing. */
export async function ensureRoots(db: DbOrTx, workspaceId: string, chatId: string): Promise<void> {
  for (const root of ROOTS) {
    await db.execute(sql`
      INSERT INTO topics (workspace_id, chat_id, root, kind, parent_id, title, provenance)
      VALUES (${workspaceId}::uuid, ${chatId}::uuid, ${root}, 'CATEGORY', NULL, ${ROOT_LABELS[root]}, 'system')
      ON CONFLICT DO NOTHING`);
  }
}

/** Load the live (non-retired) tree for a chat and derive depth from ancestry. */
export async function loadTree(db: DbOrTx, chatId: string): Promise<Tree> {
  const rows = await db
    .select({
      id: s.topics.id,
      parentId: s.topics.parentId,
      root: s.topics.root,
      kind: s.topics.kind,
      title: s.topics.title,
      needsReview: s.topics.needsReview,
      provenance: s.topics.provenance,
    })
    .from(s.topics)
    .where(and(eq(s.topics.chatId, chatId), isNull(s.topics.retiredInto)));
  const nodes = new Map<string, TreeNode>();
  for (const r of rows) nodes.set(r.id, { ...r, depth: -1, childIds: [] });
  for (const n of nodes.values()) {
    if (n.parentId) nodes.get(n.parentId)?.childIds.push(n.id);
  }
  const roots = ROOTS.map((r) => [...nodes.values()].find((n) => n.kind === 'CATEGORY' && n.root === r)).filter(
    (n): n is TreeNode => Boolean(n),
  );
  let maxDepth = 0;
  const stack: TreeNode[] = roots.map((r) => ((r.depth = 0), r));
  while (stack.length) {
    const n = stack.pop()!;
    for (const cid of n.childIds) {
      const c = nodes.get(cid)!;
      if (c.depth !== -1) continue; // defensive: cycles are prevented by DB trigger
      c.depth = n.depth + 1;
      if (c.depth > maxDepth) maxDepth = c.depth;
      stack.push(c);
    }
  }
  // Orphans (should not exist) are excluded from the navigable tree.
  for (const [id, n] of nodes) if (n.depth === -1) nodes.delete(id);
  for (const n of nodes.values()) n.childIds = n.childIds.filter((c) => nodes.has(c));
  return { chatId, nodes, roots, maxDepth };
}

export function ancestors(tree: Tree, id: string): TreeNode[] {
  const out: TreeNode[] = [];
  let cur = tree.nodes.get(id);
  while (cur) {
    out.unshift(cur);
    cur = cur.parentId ? tree.nodes.get(cur.parentId) : undefined;
  }
  return out;
}

export function pathOf(tree: Tree, id: string): { id: string; title: string; depth: number }[] {
  return ancestors(tree, id).map((n) => ({ id: n.id, title: n.title, depth: n.depth }));
}

export function descendantIds(tree: Tree, id: string): string[] {
  const out: string[] = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    out.push(cur);
    const n = tree.nodes.get(cur);
    if (n) stack.push(...n.childIds);
  }
  return out;
}

export function isAncestorOrSelf(tree: Tree, maybeAncestor: string, id: string): boolean {
  let cur: TreeNode | undefined = tree.nodes.get(id);
  while (cur) {
    if (cur.id === maybeAncestor) return true;
    cur = cur.parentId ? tree.nodes.get(cur.parentId) : undefined;
  }
  return false;
}

async function lockChat(tx: Tx, chatId: string) {
  const [c] = await tx.select().from(s.chats).where(eq(s.chats.id, chatId)).for('update');
  if (!c) throw new SafeError('chat not found', 404, 'not_found');
  return c;
}

async function bumpGraph(tx: Tx, workspaceId: string, chatId: string): Promise<number> {
  const [r] = await tx
    .update(s.chats)
    .set({ graphVersion: sql`${s.chats.graphVersion} + 1` })
    .where(eq(s.chats.id, chatId))
    .returning({ v: s.chats.graphVersion });
  await notifyChange(tx, { ws: workspaceId, kind: 'graph', chatId, version: r.v });
  return r.v;
}

export interface TopicEdit {
  title?: string;
  parentId?: string;
  mergeIntoId?: string;
  expectedGraphVersion?: number;
}

/**
 * Persistent user correction: rename, same-root subtree move, or merge, at any
 * depth. Validates cycles/scope before writing; the DB trigger re-checks.
 */
export async function editTopic(tx: Tx, scope: { workspaceId: string; userId: string }, topicId: string, edit: TopicEdit) {
  const [topic] = await tx
    .select()
    .from(s.topics)
    .where(and(eq(s.topics.id, topicId), eq(s.topics.workspaceId, scope.workspaceId)));
  if (!topic || topic.retiredInto) throw new SafeError('topic not found', 404, 'not_found');
  const chat = await lockChat(tx, topic.chatId);
  if (edit.expectedGraphVersion !== undefined && edit.expectedGraphVersion !== chat.graphVersion) {
    throw new SafeError('the map changed since it was loaded; reload and retry', 409, 'stale_graph');
  }
  const tree = await loadTree(tx, topic.chatId);
  const result: { mergedInto?: string; retired?: string[]; affectedAncestors: string[] } = { affectedAncestors: [] };
  const before = pathOf(tree, topicId).map((p) => p.id);

  if (edit.title !== undefined) {
    const title = edit.title.trim();
    if (!title || title.length > 120) throw new SafeError('title must be 1–120 characters');
    if (topic.kind === 'CATEGORY') throw new SafeError('category roots cannot be renamed');
    await tx.update(s.topics).set({ title, titleLocked: true, updatedAt: sql`now()` }).where(eq(s.topics.id, topicId));
    await tx.insert(s.taxonomyOverrides).values({ workspaceId: scope.workspaceId, chatId: topic.chatId, topicId, kind: 'rename', payload: { title }, createdBy: scope.userId });
  }

  if (edit.parentId !== undefined && edit.parentId !== topic.parentId) {
    if (topic.kind === 'CATEGORY') throw new SafeError('category roots cannot be moved');
    const target = tree.nodes.get(edit.parentId);
    if (!target) throw new SafeError('target parent not found in this chat', 400, 'invalid_parent');
    if (target.root !== topic.root) throw new SafeError('topics can only move within the same root', 400, 'cross_root');
    if (isAncestorOrSelf(tree, topicId, edit.parentId)) {
      throw new SafeError('cannot move a topic beneath itself or its descendant', 400, 'cycle');
    }
    await tx.update(s.topics).set({ parentId: edit.parentId, parentLocked: true, updatedAt: sql`now()` }).where(eq(s.topics.id, topicId));
    await tx.insert(s.taxonomyOverrides).values({
      workspaceId: scope.workspaceId,
      chatId: topic.chatId,
      topicId,
      kind: 'move',
      payload: { from: topic.parentId, to: edit.parentId },
      createdBy: scope.userId,
    });
    result.affectedAncestors.push(...before, ...pathOf(tree, edit.parentId).map((p) => p.id));
  }

  if (edit.mergeIntoId !== undefined) {
    if (topic.kind === 'CATEGORY') throw new SafeError('category roots cannot be merged');
    const target = tree.nodes.get(edit.mergeIntoId);
    if (!target || edit.mergeIntoId === topicId) throw new SafeError('merge target not found', 400, 'invalid_target');
    if (target.root !== topic.root) throw new SafeError('topics can only merge within the same root', 400, 'cross_root');
    if (isAncestorOrSelf(tree, topicId, edit.mergeIntoId)) {
      // Merging into a descendant would make that descendant its own ancestor.
      throw new SafeError('cannot merge a topic into its own descendant', 400, 'cycle');
    }
    // Children move to the survivor; memberships union by message (dedup).
    await tx.update(s.topics).set({ parentId: edit.mergeIntoId, updatedAt: sql`now()` }).where(and(eq(s.topics.parentId, topicId), isNull(s.topics.retiredInto)));
    await tx.execute(sql`
      INSERT INTO placements (workspace_id, chat_id, message_id, topic_id, discussion_id, is_primary, provenance, locked, analyzed_revision, taxonomy_version)
      SELECT workspace_id, chat_id, message_id, ${edit.mergeIntoId}::uuid, discussion_id, is_primary, 'user', true, analyzed_revision, taxonomy_version
      FROM placements WHERE topic_id = ${topicId}::uuid
      ON CONFLICT (topic_id, message_id) DO NOTHING`);
    await tx.delete(s.placements).where(eq(s.placements.topicId, topicId));
    await tx.update(s.discussions).set({ topicId: edit.mergeIntoId }).where(eq(s.discussions.topicId, topicId));
    await tx.update(s.topics).set({ retiredInto: edit.mergeIntoId, updatedAt: sql`now()` }).where(eq(s.topics.id, topicId));
    // Keep the merge map transitive so saved filters/links resolve to the live survivor.
    await tx.update(s.topicMergeMap).set({ survivingId: edit.mergeIntoId }).where(eq(s.topicMergeMap.survivingId, topicId));
    await tx.insert(s.topicMergeMap).values({ retiredId: topicId, survivingId: edit.mergeIntoId, chatId: topic.chatId });
    await tx.insert(s.taxonomyOverrides).values({
      workspaceId: scope.workspaceId,
      chatId: topic.chatId,
      topicId,
      kind: 'merge',
      payload: { into: edit.mergeIntoId },
      createdBy: scope.userId,
    });
    await tx.update(s.userChatViewPreferences).set({ focusNodeId: edit.mergeIntoId }).where(eq(s.userChatViewPreferences.focusNodeId, topicId));
    // Links to the retired topic follow the survivor.
    await tx.execute(sql`UPDATE cross_chat_links SET a_topic_id = ${edit.mergeIntoId}::uuid WHERE a_topic_id = ${topicId}::uuid
      AND NOT EXISTS (SELECT 1 FROM cross_chat_links x WHERE x.a_topic_id = ${edit.mergeIntoId}::uuid AND x.b_topic_id = cross_chat_links.b_topic_id AND x.relation_type = cross_chat_links.relation_type)`);
    await tx.execute(sql`UPDATE cross_chat_links SET b_topic_id = ${edit.mergeIntoId}::uuid WHERE b_topic_id = ${topicId}::uuid
      AND NOT EXISTS (SELECT 1 FROM cross_chat_links x WHERE x.b_topic_id = ${edit.mergeIntoId}::uuid AND x.a_topic_id = cross_chat_links.a_topic_id AND x.relation_type = cross_chat_links.relation_type)`);
    result.mergedInto = edit.mergeIntoId;
    result.retired = [topicId];
    result.affectedAncestors.push(...before, ...pathOf(tree, edit.mergeIntoId).map((p) => p.id));
  }

  // Generated prose over changed memberships is no longer guaranteed current.
  if (edit.parentId !== undefined || edit.mergeIntoId !== undefined) {
    const ids = [...new Set(result.affectedAncestors)];
    if (ids.length) await tx.update(s.summaryClaims).set({ valid: false }).where(inArray(s.summaryClaims.topicId, ids));
  }
  const graphVersion = await bumpGraph(tx, scope.workspaceId, topic.chatId);
  return { ...result, graphVersion, affectedAncestors: [...new Set(result.affectedAncestors)] };
}

/** Explicit message-placement correction (user override, survives regeneration). */
export async function correctPlacement(
  tx: Tx,
  scope: { workspaceId: string; userId: string },
  input: { messageId: string; addTopicId?: string; removeTopicId?: string },
) {
  const [m] = await tx
    .select({ id: s.messages.id, chatId: s.messages.chatId, rev: s.messages.contentRevision })
    .from(s.messages)
    .where(and(eq(s.messages.id, input.messageId), eq(s.messages.workspaceId, scope.workspaceId)));
  if (!m) throw new SafeError('message not found', 404, 'not_found');
  await lockChat(tx, m.chatId);
  if (input.addTopicId) {
    const [t] = await tx.select().from(s.topics).where(and(eq(s.topics.id, input.addTopicId), eq(s.topics.chatId, m.chatId), isNull(s.topics.retiredInto)));
    if (!t) throw new SafeError('topic not found in this chat', 400, 'invalid_topic');
    await tx
      .insert(s.placements)
      .values({ workspaceId: scope.workspaceId, chatId: m.chatId, messageId: m.id, topicId: t.id, provenance: 'user', locked: true, analyzedRevision: m.rev })
      .onConflictDoUpdate({ target: [s.placements.topicId, s.placements.messageId], set: { locked: true, provenance: 'user' } });
    await tx.insert(s.taxonomyOverrides).values({ workspaceId: scope.workspaceId, chatId: m.chatId, topicId: t.id, kind: 'placement_add', payload: { messageId: m.id }, createdBy: scope.userId });
  }
  if (input.removeTopicId) {
    await tx.delete(s.placements).where(and(eq(s.placements.messageId, m.id), eq(s.placements.topicId, input.removeTopicId)));
    await tx.insert(s.taxonomyOverrides).values({
      workspaceId: scope.workspaceId,
      chatId: m.chatId,
      topicId: input.removeTopicId,
      kind: 'placement_remove',
      payload: { messageId: m.id },
      createdBy: scope.userId,
    });
  }
  return { graphVersion: await bumpGraph(tx, scope.workspaceId, m.chatId) };
}

export { bumpGraph, lockChat };
