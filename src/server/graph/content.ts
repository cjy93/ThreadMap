// Node content: paginated matching Messages or Files from a root/topic's own
// and all recursive descendant memberships (or a discussion's members). The
// membership is independent of Show depth and graph pagination.
import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { SafeError } from '../util';
import { filterFingerprint, matchingMessagesSql, type ContentFilter } from './filters';
import { descendantIds, pathOf, type Tree } from './tree';

export interface ContentScope {
  userId: string;
  workspaceId: string;
  /** The map: its topics, discussions and placements. */
  chatId: string;
  /** The chat whose messages are listed, when the map is a one-sided map of it. */
  messageChatId?: string;
}

interface Cursor {
  fp: string;
  node: string;
  g: number;
  tab: 'messages' | 'files';
  // keyset: [sent_at epoch ms or null, id]
  k: [number | null, string];
}

const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
function decodeCursor(s: string): Cursor {
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Cursor;
  } catch {
    throw new SafeError('invalid cursor', 400, 'invalid_cursor');
  }
}

export class CursorInvalidatedError extends SafeError {
  constructor() {
    super('the content changed; refetch from the first page', 409, 'refetch');
  }
}

export interface ContentRequest {
  nodeId: string;
  tab: 'messages' | 'files';
  cursor?: string | null;
  pageSize: number;
}

export async function nodeContent(db: DbOrTx, scope: ContentScope, tree: Tree, graphVersion: number, filter: ContentFilter, req: ContentRequest) {
  const fp = filterFingerprint({ userId: scope.userId, workspaceId: scope.workspaceId, chatIds: [scope.messageChatId ?? scope.chatId] }, filter);
  let topicIds: string[] | null = null;
  let discussionId: string | null = null;
  let nodePath: { id: string; title: string; depth: number }[];
  if (tree.nodes.has(req.nodeId)) {
    topicIds = descendantIds(tree, req.nodeId);
    nodePath = pathOf(tree, req.nodeId);
  } else {
    const d = await db.execute<{ id: string; topic_id: string; title: string }>(
      sql`SELECT id, topic_id, title FROM discussions WHERE id = ${req.nodeId}::uuid AND chat_id = ${scope.chatId}::uuid AND workspace_id = ${scope.workspaceId}::uuid`,
    );
    if (!d.rows[0]) throw new SafeError('node not found', 404, 'not_found');
    discussionId = d.rows[0].id;
    nodePath = [...pathOf(tree, d.rows[0].topic_id), { id: discussionId, title: d.rows[0].title, depth: -1 }];
  }

  let after: Cursor['k'] | null = null;
  if (req.cursor) {
    const c = decodeCursor(req.cursor);
    if (c.fp !== fp || c.node !== req.nodeId || c.tab !== req.tab) throw new CursorInvalidatedError();
    if (c.g !== graphVersion) throw new CursorInvalidatedError();
    after = c.k;
  }

  const matching = matchingMessagesSql({ userId: scope.userId, workspaceId: scope.workspaceId, chatIds: [scope.messageChatId ?? scope.chatId] }, filter);
  const membership = topicIds
    ? sql`SELECT DISTINCT p.message_id FROM placements p WHERE p.chat_id = ${scope.chatId}::uuid AND p.topic_id IN (${sql.join(
        topicIds.map((t) => sql`${t}::uuid`),
        sql`, `,
      )})`
    : sql`SELECT DISTINCT p.message_id FROM placements p WHERE p.discussion_id = ${discussionId}::uuid`;

  // Order newest first; NULL sent_at last; id as stable tie-breaker.
  const keyset = after
    ? after[0] === null
      ? sql`AND m.sent_at IS NULL AND m.id < ${after[1]}::uuid`
      : sql`AND (m.sent_at < to_timestamp(${after[0]} / 1000.0) OR (m.sent_at = to_timestamp(${after[0]} / 1000.0) AND m.id < ${after[1]}::uuid) OR m.sent_at IS NULL)`
    : sql``;

  const totals = await db.execute<{ total: number; missed: number; files: number }>(sql`
    WITH mt AS (${matching}), mem AS (${membership})
    SELECT count(*)::int AS total, count(*) FILTER (WHERE NOT mt.is_read)::int AS missed,
      (SELECT count(*)::int FROM attachments a WHERE a.message_id IN (SELECT mt2.id FROM mt mt2 JOIN mem m2 ON m2.message_id = mt2.id)) AS files
    FROM mt JOIN mem ON mem.message_id = mt.id`);
  const { total, missed, files } = totals.rows[0];

  if (req.tab === 'messages') {
    const rows = await db.execute<{
      id: string;
      sender_label: string;
      direction: string;
      kind: string;
      body: string | null;
      sent_at: Date | null;
      received_at: Date;
      edited_at: Date | null;
      content_revision: number;
      is_read: boolean;
      topic_ids: string[];
      attachment_count: number;
      attachments: { id: string; media_type: string; filename: string | null; availability: string; has_preview: boolean; description: string | null }[];
    }>(sql`
      WITH mt AS (${matching}), mem AS (${membership})
      SELECT m.id, m.sender_label, m.direction, m.kind, m.body, m.sent_at, m.received_at, m.edited_at,
        m.content_revision, mt.is_read,
        ARRAY(SELECT p.topic_id::text FROM placements p WHERE p.message_id = m.id ORDER BY p.is_primary DESC, p.topic_id) AS topic_ids,
        (SELECT count(*)::int FROM attachments a WHERE a.message_id = m.id) AS attachment_count,
        -- Shown inline in the list (photos, videos, voice clips), so they need no extra click.
        COALESCE((SELECT json_agg(json_build_object('id', a.id, 'media_type', a.media_type, 'filename', a.filename, 'availability', a.availability,
            'has_preview', a.thumbnail IS NOT NULL, 'description', a.ai_description) ORDER BY a.ordinal)
          FROM attachments a WHERE a.message_id = m.id), '[]'::json) AS attachments
      FROM messages m JOIN mt ON mt.id = m.id JOIN mem ON mem.message_id = m.id
      WHERE true ${keyset}
      ORDER BY m.sent_at DESC NULLS LAST, m.id DESC
      LIMIT ${req.pageSize + 1}`);
    const items = rows.rows.slice(0, req.pageSize).map((r) => ({
      message_id: r.id,
      sender: r.sender_label,
      direction: r.direction,
      kind: r.kind,
      snippet: r.body ? r.body.slice(0, 280) : null,
      sent_at: r.sent_at ? new Date(r.sent_at).toISOString() : null,
      edited: Boolean(r.edited_at),
      content_revision: r.content_revision,
      review: r.is_read ? 'read' : 'missed',
      attachment_count: r.attachment_count,
      attachments: r.attachments,
      // Actual topic paths for every placement (deduplicated message, many paths).
      topic_paths: r.topic_ids.filter((t) => tree.nodes.has(t)).map((t) => pathOf(tree, t)),
      route: `/chats/${scope.messageChatId ?? scope.chatId}/messages/${r.id}`,
    }));
    const last = rows.rows.length > req.pageSize ? rows.rows[req.pageSize - 1] : null;
    return {
      node_id: req.nodeId,
      node_path: nodePath,
      tab: req.tab,
      filter_fingerprint: fp,
      graph_version: graphVersion,
      matching_message_count: total,
      matching_missed_count: missed,
      matching_file_count: files,
      items,
      next_cursor: last
        ? encodeCursor({ fp, node: req.nodeId, g: graphVersion, tab: 'messages', k: [last.sent_at ? new Date(last.sent_at).getTime() : null, last.id] })
        : null,
    };
  }

  const rows = await db.execute<{
    id: string;
    message_id: string;
    media_type: string;
    mime: string | null;
    filename: string | null;
    size: number | null;
    availability: string;
    has_preview: boolean;
    description: string | null;
    sent_at: Date | null;
    sender_label: string;
    topic_ids: string[];
  }>(sql`
    WITH mt AS (${matching}), mem AS (${membership})
    SELECT a.id, a.message_id, a.media_type, COALESCE(a.detected_mime, a.declared_mime) AS mime, a.filename,
      COALESCE(a.byte_count, a.declared_size) AS size, a.availability, a.thumbnail IS NOT NULL AS has_preview, a.ai_description AS description, m.sent_at, m.sender_label,
      ARRAY(SELECT p.topic_id::text FROM placements p WHERE p.message_id = m.id ORDER BY p.is_primary DESC, p.topic_id) AS topic_ids
    FROM attachments a JOIN messages m ON m.id = a.message_id JOIN mt ON mt.id = m.id JOIN mem ON mem.message_id = m.id
    WHERE true ${keyset}
    ORDER BY m.sent_at DESC NULLS LAST, m.id DESC, a.ordinal
    LIMIT ${req.pageSize + 1}`);
  // Keyset is per message: never split one message's attachments across pages.
  let cut = Math.min(rows.rows.length, req.pageSize);
  if (rows.rows.length > req.pageSize) {
    const firstExcluded = rows.rows[req.pageSize].message_id;
    while (cut > 1 && rows.rows[cut - 1].message_id === firstExcluded) cut--;
  }
  const items = rows.rows.slice(0, cut).map((r) => ({
    attachment_id: r.id,
    message_id: r.message_id,
    media_type: r.media_type,
    mime: r.mime,
    filename: r.filename,
    size: r.size,
    availability: r.availability,
    has_preview: r.has_preview,
    description: r.description,
    sent_at: r.sent_at ? new Date(r.sent_at).toISOString() : null,
    sender: r.sender_label,
    topic_paths: r.topic_ids.filter((t) => tree.nodes.has(t)).map((t) => pathOf(tree, t)),
    route: `/chats/${scope.messageChatId ?? scope.chatId}/messages/${r.message_id}`,
  }));
  const lastRow = rows.rows.length > req.pageSize ? rows.rows[cut - 1] : null;
  const next = lastRow
    ? encodeCursor({ fp, node: req.nodeId, g: graphVersion, tab: 'files', k: [lastRow.sent_at ? new Date(lastRow.sent_at).getTime() : null, lastRow.message_id] })
    : null;
  return {
    node_id: req.nodeId,
    node_path: nodePath,
    tab: req.tab,
    filter_fingerprint: fp,
    graph_version: graphVersion,
    matching_message_count: total,
    matching_missed_count: missed,
    matching_file_count: files,
    items,
    next_cursor: next,
  };
}
