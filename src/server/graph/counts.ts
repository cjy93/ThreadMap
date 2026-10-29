// Server-derived matching counts. N(v) = |distinct eligible canonical messages
// placed on v or any recursive descendant ∩ content filter|. Never computed by
// summing child counts; never influenced by display depth or graph pages.
import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { filterFingerprint, matchingMessagesSql, type ContentFilter } from './filters';

export interface NodeCount {
  total: number;
  missed: number;
}

export interface CountSnapshot {
  topics: Map<string, NodeCount>;
  discussions: Map<string, NodeCount>;
  countVersion: string;
  filterFingerprint: string;
}

export interface CountScope {
  userId: string;
  workspaceId: string;
  /** The map: its topics and placements. */
  chatId: string;
  /** The chat whose messages are counted, when the map is a one-sided map of it. */
  messageChatId?: string;
}

/** Versions that define a coherent aggregate snapshot for one user/chat. */
export async function countVersion(db: DbOrTx, scope: CountScope): Promise<string> {
  // The map's graph version; the messages' source and review versions.
  const r = await db.execute<{ g: number; s: number; r: number | null }>(sql`
    SELECT (SELECT graph_version FROM chats WHERE id = ${scope.chatId}::uuid) AS g, c.source_version AS s,
      (SELECT version FROM review_versions rv WHERE rv.user_id = ${scope.userId} AND rv.chat_id = c.id) AS r
    FROM chats c WHERE c.id = ${scope.messageChatId ?? scope.chatId}::uuid AND c.workspace_id = ${scope.workspaceId}::uuid`);
  const row = r.rows[0];
  if (!row) throw new Error('chat not in scope');
  return `g${row.g}.s${row.s}.r${row.r ?? 0}`;
}

export async function computeCounts(db: DbOrTx, scope: CountScope, filter: ContentFilter): Promise<CountSnapshot> {
  // Read version, then counts, inside one REPEATABLE READ snapshot when called in a tx;
  // the API layer wraps this in such a transaction.
  const cv = await countVersion(db, scope);
  const matching = matchingMessagesSql({ userId: scope.userId, workspaceId: scope.workspaceId, chatIds: [scope.messageChatId ?? scope.chatId] }, filter);
  const topicRows = await db.execute<{ node_id: string; total: number; missed: number }>(sql`
    WITH RECURSIVE live AS (
      SELECT id, parent_id FROM topics WHERE chat_id = ${scope.chatId}::uuid AND retired_into IS NULL
    ),
    closure(ancestor, descendant) AS (
      SELECT id, id FROM live
      UNION ALL
      SELECT c.ancestor, l.id FROM closure c JOIN live l ON l.parent_id = c.descendant
    ),
    mt AS (${matching})
    SELECT c.ancestor AS node_id,
      count(DISTINCT p.message_id)::int AS total,
      count(DISTINCT p.message_id) FILTER (WHERE NOT mt.is_read)::int AS missed
    FROM closure c
    JOIN placements p ON p.topic_id = c.descendant AND p.chat_id = ${scope.chatId}::uuid
    JOIN mt ON mt.id = p.message_id
    GROUP BY c.ancestor`);
  const discRows = await db.execute<{ node_id: string; total: number; missed: number }>(sql`
    WITH mt AS (${matching})
    SELECT p.discussion_id AS node_id,
      count(DISTINCT p.message_id)::int AS total,
      count(DISTINCT p.message_id) FILTER (WHERE NOT mt.is_read)::int AS missed
    FROM placements p JOIN mt ON mt.id = p.message_id
    WHERE p.chat_id = ${scope.chatId}::uuid AND p.discussion_id IS NOT NULL
    GROUP BY p.discussion_id`);
  const topics = new Map<string, NodeCount>();
  for (const r of topicRows.rows) topics.set(r.node_id, { total: r.total, missed: r.missed });
  const discussions = new Map<string, NodeCount>();
  for (const r of discRows.rows) discussions.set(r.node_id, { total: r.total, missed: r.missed });
  return {
    topics,
    discussions,
    countVersion: cv,
    filterFingerprint: filterFingerprint({ userId: scope.userId, workspaceId: scope.workspaceId, chatIds: [scope.chatId] }, filter),
  };
}

/** Chat-level overall counts (unfiltered) plus pending-analysis (unassigned) messages. */
export async function chatTotals(db: DbOrTx, userId: string, workspaceId: string, chatIds: string[]) {
  type Totals = { total: number; missed: number; pending: number; first_at: string | null; last_at: string | null };
  if (!chatIds.length) return new Map<string, Totals>();
  const list = sql.join(chatIds.map((c) => sql`${c}::uuid`), sql`, `);
  const r = await db.execute<{ chat_id: string; total: number; missed: number; pending: number; first_at: string | null; last_at: string | null }>(sql`
    SELECT m.chat_id,
      count(*)::int AS total,
      to_char(min(m.sent_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS first_at,
      to_char(max(m.sent_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_at,
      count(*) FILTER (WHERE NOT COALESCE(rs.status = 'read' AND rs.reviewed_revision = m.content_revision, false))::int AS missed,
      count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM placements p WHERE p.message_id = m.id AND p.chat_id = m.chat_id))::int AS pending
    FROM messages m
    LEFT JOIN review_state rs ON rs.user_id = ${userId} AND rs.message_id = m.id
    WHERE m.workspace_id = ${workspaceId}::uuid AND m.chat_id IN (${list})
      AND m.kind IN ('text','media') AND m.state = 'active' AND (m.expires_at IS NULL OR m.expires_at > now())
    GROUP BY m.chat_id`);
  const out = new Map<string, Totals>();
  for (const row of r.rows) out.set(row.chat_id, { total: row.total, missed: row.missed, pending: row.pending, first_at: row.first_at, last_at: row.last_at });
  return out;
}
