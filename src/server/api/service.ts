// Application API service layer. Route handlers are thin wrappers around these
// functions so integration tests exercise the exact same authorization,
// filter, count and projection code. Nothing here calls a model.
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import * as s from '../../db/schema';
import { type ViewConfig, loadViewConfig, loadWhatsAppConfig } from '../../lib/config';
import { nodeDiameter } from '../../lib/sizing';
import type { Db, DbOrTx } from '../db';
import { nodeContent } from '../graph/content';
import { chatTotals, computeCounts } from '../graph/counts';
import { filterFingerprint, matchingMessagesSql, parseContentFilter, parseDisplayDepth, validTimezone, type ContentFilter, type DisplayDepth } from '../graph/filters';
import { sideMapOf, sideSql, type MapSide } from '../ai/pipeline';
import { projectMap } from '../graph/projection';
import { correctPlacement, editTopic, loadTree, pathOf } from '../graph/tree';
import { createBulkSnapshot, executeBulk, setReview } from '../review';
import { isUuid, normalizeSearch, SafeError } from '../util';

export interface AuthCtx {
  userId: string;
  workspaceId: string;
  mode: 'private' | 'demo';
}

let viewCfg: ViewConfig | undefined;
export const view = () => (viewCfg ??= loadViewConfig());

export async function requireChat(db: DbOrTx, ctx: AuthCtx, chatId: string) {
  if (!isUuid(chatId)) throw new SafeError('chat not found', 404, 'not_found');
  const [c] = await db.select().from(s.chats).where(and(eq(s.chats.id, chatId), eq(s.chats.workspaceId, ctx.workspaceId)));
  if (!c || c.excluded) throw new SafeError('chat not found', 404, 'not_found');
  return c;
}

/**
 * Paused or failed steps count only for the current build: once a later build of
 * the map has completed, an older stalled step (e.g. a refinement that used up its
 * own call cap) no longer says anything about the map, so it does not show as
 * "paused by budget" or "failed". Waiting and running steps always count.
 */
const currentBuildOnly = sql`(j.status IN ('pending','running') OR j.created_at > COALESCE(
  (SELECT max(b.completed_at) FROM analysis_jobs b WHERE b.chat_id = j.chat_id AND b.kind = 'rebuild' AND b.status = 'completed'), 'epoch'::timestamptz))`;

/** Indexed chats with selection state, overall distinct counts and pending analysis. */
export async function listChats(db: Db, ctx: AuthCtx) {
  const chats = await db.select().from(s.chats).where(and(eq(s.chats.workspaceId, ctx.workspaceId), eq(s.chats.excluded, false))).orderBy(s.chats.title);
  const indexed = chats.filter((c) => c.selected || c.taxonomyVersion > 0 || c.sourceVersion > 0);
  const totals = await chatTotals(db, ctx.userId, ctx.workspaceId, indexed.map((c) => c.id));
  const jobs = indexed.length
    ? await db.execute<{ chat_id: string; status: string; n: number }>(sql`
        SELECT j.chat_id, j.status, count(*)::int AS n FROM analysis_jobs j
        WHERE j.chat_id IN (${sql.join(indexed.map((c) => sql`${c.id}::uuid`), sql`, `)}) AND j.status IN ('pending','running','budget_paused','failed')
          AND ${currentBuildOnly}
        GROUP BY j.chat_id, j.status`)
    : { rows: [] };
  return indexed.map((c) => {
    const t = totals.get(c.id) ?? { total: 0, missed: 0, pending: 0, first_at: null, last_at: null };
    const js = jobs.rows.filter((j) => j.chat_id === c.id);
    return {
      id: c.id,
      title: c.title,
      kind: c.kind,
      source: c.sourceKind,
      // Same versioned photo URL as the chat picker, so the list shows who each chat is.
      avatar_url: c.avatarKey ? `/api/chats/${c.id}/avatar?v=${c.avatarCheckedAt?.getTime() ?? 0}` : null,
      selected: c.selected,
      paused: c.paused,
      history_mode: c.historyMode,
      message_count: t.total,
      missed_count: t.missed,
      pending_analysis_count: t.pending,
      // The span of messages ThreadMap holds, so a date range outside it can be flagged.
      first_message_at: t.first_at,
      last_message_at: t.last_at,
      analysis: {
        pending_jobs: js.filter((j) => j.status === 'pending' || j.status === 'running').reduce((n, j) => n + j.n, 0),
        budget_paused: js.some((j) => j.status === 'budget_paused'),
        failed: js.some((j) => j.status === 'failed'),
        last_analysis_at: c.lastAnalysisAt?.toISOString() ?? null,
      },
      last_event_at: c.lastEventAt?.toISOString() ?? null,
    };
  });
}

async function effectiveDepth(db: Db, ctx: AuthCtx, chatId: string, urlDepth: DisplayDepth | undefined): Promise<{ depth: DisplayDepth; source: 'url' | 'preference' | 'default' }> {
  if (urlDepth !== undefined) return { depth: urlDepth, source: 'url' };
  const [pref] = await db.select().from(s.userChatViewPreferences).where(and(eq(s.userChatViewPreferences.userId, ctx.userId), eq(s.userChatViewPreferences.chatId, chatId)));
  if (pref) return { depth: parseDisplayDepth(pref.showDepth)!, source: 'preference' };
  return { depth: view().defaultTopicDepth, source: 'default' };
}

const idList = (v: string | null) =>
  (v ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(isUuid)
    .slice(0, 500);

/**
 * Which map to show: the chat's own, or with ?side=mine|others its one-sided
 * map ("Map from: You / Others"), which must have been started first.
 */
async function mapFor(db: DbOrTx, chatId: string, params: URLSearchParams): Promise<{ mapId: string; side: MapSide | null }> {
  const side = params.get('side');
  if (side !== 'mine' && side !== 'others') return { mapId: chatId, side: null };
  const map = await sideMapOf(db, chatId, side);
  if (!map) throw new SafeError('this map has not been started yet', 409, 'side_map_missing');
  return { mapId: map.id, side };
}

/** Analysis state of one map (a chat's own, or one of its one-sided maps). */
async function mapAnalysis(db: DbOrTx, mapId: string) {
  const js = (await db.execute<{ status: string; n: number }>(sql`
    SELECT j.status, count(*)::int AS n FROM analysis_jobs j WHERE j.chat_id = ${mapId}::uuid AND j.status IN ('pending','running','budget_paused','failed') AND ${currentBuildOnly} GROUP BY j.status`)).rows;
  // Messages Nemotron has still to read: not yet handed to a batch, or in a batch not finished.
  // Unlike the job count, this covers the whole build, so the time estimate can too.
  const [unread] = (await db.execute<{ n: number }>(sql`
    SELECT (SELECT count(*) FROM analysis_outbox o WHERE o.chat_id = ${mapId}::uuid AND o.dispatched_job_id IS NULL)::int
      + (SELECT coalesce(sum(jsonb_array_length(j.input_messages)), 0) FROM analysis_jobs j
         WHERE j.chat_id = ${mapId}::uuid AND j.kind = 'microbatch' AND j.status IN ('pending','running'))::int AS n`)).rows;
  return {
    pending_jobs: js.filter((j) => j.status === 'pending' || j.status === 'running').reduce((n, j) => n + j.n, 0),
    unread_messages: unread?.n ?? 0,
    budget_paused: js.some((j) => j.status === 'budget_paused'),
    failed: js.some((j) => j.status === 'failed'),
  };
}

export async function getMap(db: Db, ctx: AuthCtx, chatId: string, params: URLSearchParams) {
  const chat = await requireChat(db, ctx, chatId);
  const { mapId, side } = await mapFor(db, chat.id, params);
  const cfg = view();
  const filter = parseContentFilter(params, { tz: cfg.defaultTimezone });
  const urlDepth = parseDisplayDepth(params.get('max_topic_depth'));
  const { depth, source } = await effectiveDepth(db, ctx, chatId, urlDepth);
  const collapsed = new Set(idList(params.get('collapsed')));
  const focus = params.get('focus');
  const offsets: Record<string, number> = {};
  for (const part of (params.get('offsets') ?? '').split(',')) {
    const [id, n] = part.split(':');
    if (isUuid(id) && /^\d+$/.test(n ?? '')) offsets[id] = Number(n);
  }
  // One consistent snapshot for tree, counts and versions.
  return db.transaction(
    async (tx) => {
      const tree = await loadTree(tx, mapId);
      const counts = await computeCounts(tx, { userId: ctx.userId, workspaceId: ctx.workspaceId, chatId: mapId, messageChatId: chatId }, filter);
      const discussions = await tx.select({ id: s.discussions.id, topicId: s.discussions.topicId, title: s.discussions.title }).from(s.discussions).where(eq(s.discussions.chatId, mapId));
      const [g] = await tx.select({ g: s.chats.graphVersion }).from(s.chats).where(eq(s.chats.id, mapId));
      const filterActive = filter.status !== 'all' || Boolean(filter.from || filter.to) || filter.topicIds.length > 0;
      const projection = projectMap({
        tree,
        discussions,
        counts,
        depth,
        collapsed,
        focusId: isUuid(focus) && tree.nodes.has(focus) ? focus : null,
        childOffsets: offsets,
        expandIds: idList(params.get('expand')),
        selectedTopicIds: filter.topicIds,
        filterActive,
        view: cfg,
      });
      // A one-sided map counts only that side's messages, and "pending" means not yet on that map.
      const totals = side
        ? (
            await tx.execute<{ total: number; missed: number; pending: number }>(sql`
              SELECT count(*)::int AS total,
                count(*) FILTER (WHERE NOT COALESCE(rs.status = 'read' AND rs.reviewed_revision = m.content_revision, false))::int AS missed,
                count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM placements p WHERE p.message_id = m.id AND p.chat_id = ${mapId}::uuid))::int AS pending
              FROM messages m LEFT JOIN review_state rs ON rs.user_id = ${ctx.userId} AND rs.message_id = m.id
              WHERE m.chat_id = ${chatId}::uuid AND ${sideSql(side)} AND m.kind IN ('text','media') AND m.state = 'active' AND (m.expires_at IS NULL OR m.expires_at > now())`)
          ).rows[0]
        : ((await chatTotals(tx, ctx.userId, ctx.workspaceId, [chatId])).get(chatId) ?? { total: 0, missed: 0, pending: 0 });
      // Small talk left off the map, so its counts can add up to less than the chat's.
      const [fill] = (await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM messages WHERE chat_id = ${chatId}::uuid AND filler`)).rows;
      // When ThreadMap last asked the phone for this chat's older messages, so an empty or
      // short chat can say why instead of just showing zeros.
      const [hist] = (
        await tx.execute<{ at: Date | null; loading: boolean }>(sql`SELECT max(created_at) AS at, COALESCE(max(created_at) > now() - interval '3 minutes', false) AS loading FROM connector_commands WHERE workspace_id = ${ctx.workspaceId}::uuid AND type = 'request_history' AND payload->>'chatId' = ${chatId}`)
      ).rows;
      // At the per-chat history limit (WHATSAPP_HISTORY_MAX_MESSAGES_PER_CHAT): older pages would be dropped.
      const [cov] = await tx.select({ n: s.syncCoverage.historyCount }).from(s.syncCoverage).where(eq(s.syncCoverage.chatId, chatId));
      const historyMax = loadWhatsAppConfig().WHATSAPP_HISTORY_MAX_MESSAGES_PER_CHAT;
      return {
        chat: { id: chat.id, title: chat.title, kind: chat.kind, source: chat.sourceKind },
        graph_version: g.g,
        count_version: counts.countVersion,
        filter_fingerprint: counts.filterFingerprint,
        filter,
        depth_source: source,
        ...projection,
        // Logical (unzoomed) diameters derived from server counts with the shared scale.
        nodes: projection.nodes.map((n) => ({ ...n, diameter: nodeDiameter(n.matching_message_count, cfg.sizing) })),
        chat_totals: { message_count: totals.total, missed_count: totals.missed, pending_analysis_count: totals.pending, filler_count: fill.n },
        history_requested_at: hist?.at ? new Date(hist.at).toISOString() : null,
        // Asked within the last few minutes: the phone's answer may still be on its way.
        history_loading: Boolean(hist?.loading),
        history_limited: cov && cov.n >= historyMax ? cov.n : null,
        // Which map this is, and how far its analysis has got.
        side,
        analysis: await mapAnalysis(tx, mapId),
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

export async function getNodeContent(db: Db, ctx: AuthCtx, chatId: string, nodeId: string, params: URLSearchParams) {
  await requireChat(db, ctx, chatId);
  const { mapId } = await mapFor(db, chatId, params);
  if (!isUuid(nodeId)) throw new SafeError('node not found', 404, 'not_found');
  const cfg = view();
  const filter = parseContentFilter(params, { tz: cfg.defaultTimezone });
  const tab = params.get('tab') === 'files' ? 'files' : 'messages';
  const pageSize = Math.min(Math.max(Number(params.get('page_size') ?? cfg.contentPageSize) || cfg.contentPageSize, 1), 200);
  return db.transaction(
    async (tx) => {
      const tree = await loadTree(tx, mapId);
      const [g] = await tx.select({ g: s.chats.graphVersion }).from(s.chats).where(eq(s.chats.id, mapId));
      const res = await nodeContent(tx, { userId: ctx.userId, workspaceId: ctx.workspaceId, chatId: mapId, messageChatId: chatId }, tree, g.g, filter, { nodeId, tab, cursor: params.get('cursor'), pageSize });
      // A topic's summary covers every discussion beneath it: grouping and refinement leave parents with none of their own.
      const under = (id: string): string[] => [id, ...(tree.nodes.get(id)?.childIds ?? []).flatMap(under)];
      const summary = await nodeSummary(tx, mapId, nodeId, tree.nodes.has(nodeId) ? under(nodeId) : [], filter, params.get('full_summary') === '1');
      return { ...res, summary };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/**
 * Grounded summary claims for the discussions in a topic and every topic beneath
 * it (`topicIds`), one per discussion first so a large branch shows a spread.
 * Prose summarizing the whole topic is hidden when content filters narrow its
 * input set, unless the user explicitly asks for the full-topic summary (labeled
 * with its coverage).
 */
async function nodeSummary(db: DbOrTx, chatId: string, nodeId: string, topicIds: string[], filter: ContentFilter, full: boolean) {
  const topics = topicIds.length ? sql`ARRAY[${sql.join(topicIds.map((id) => sql`${id}::uuid`), sql`, `)}]` : sql`ARRAY[]::uuid[]`;
  const narrowed = filter.status !== 'all' || Boolean(filter.from || filter.to) || filter.topicIds.length > 0;
  const claims = await db.execute<{ id: string; text: string; evidence: { m: string; r: number }[]; inputs: number }>(sql`
    SELECT id, text, inputs, evidence FROM (
      SELECT c.id, c.text, jsonb_array_length(c.input_message_ids) AS inputs, c.created_at,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('m', e.message_id, 'r', e.revision)) FROM claim_evidence e WHERE e.claim_id = c.id), '[]'::jsonb) AS evidence,
        row_number() OVER (PARTITION BY c.discussion_id ORDER BY c.created_at) AS nth
      FROM summary_claims c
      LEFT JOIN discussions d ON d.id = c.discussion_id
      WHERE c.chat_id = ${chatId}::uuid AND c.valid AND (c.discussion_id = ${nodeId}::uuid OR d.topic_id = ANY(${topics}))) x
    ORDER BY nth, created_at LIMIT 20`);
  const available = claims.rows.length > 0;
  if (narrowed && !full) {
    return { coverage: 'hidden_for_filtered_view', available, claims: [] as typeof claims.rows, note: 'Summary covers all dates and review states; open "View full-topic summary" to see it.' };
  }
  return { coverage: 'full_topic', available, claims: claims.rows, note: null };
}

/**
 * The whole discussion a message belongs to, in order, filler included: its
 * unit, plus units of the same title placed in the same topic (one conversation
 * read in several batches). Empty before the message is analysed.
 */
export async function discussionRows(db: DbOrTx, chatId: string, messageId: string) {
  return (
    await db.execute<{
      id: string;
      sender_label: string;
      body: string | null;
      sent_at: Date | null;
      state: string;
      direction: string;
      filler: boolean | null;
      title: string;
      reply_to: string | null;
      native_id: string;
      inferred_reply_to: string | null;
      inferred_at: Date | null;
    }>(sql`
      WITH mine AS (
        SELECT u.summary_bullets->>'title' AS title, u.assigned_topic_id FROM analysis_units u
        WHERE u.chat_id = ${chatId}::uuid AND u.message_refs @> jsonb_build_array(jsonb_build_object('m', ${messageId}::text))
        ORDER BY u.created_at DESC LIMIT 1
      ), units AS (
        SELECT u.message_refs FROM analysis_units u, mine
        WHERE u.chat_id = ${chatId}::uuid
          AND (u.message_refs @> jsonb_build_array(jsonb_build_object('m', ${messageId}::text))
            OR (mine.assigned_topic_id IS NOT NULL AND u.assigned_topic_id = mine.assigned_topic_id AND lower(u.summary_bullets->>'title') = lower(mine.title)))
      )
      SELECT DISTINCT ON (x.sent_at, x.id) x.id, x.sender_label, x.body, x.sent_at, x.state, x.direction, x.filler, (SELECT title FROM mine) AS title,
        x.reply_to_native_id AS reply_to, x.native_id, x.inferred_reply_to, x.inferred_at
      FROM units, jsonb_array_elements(units.message_refs) r JOIN messages x ON x.id = (r->>'m')::uuid
      WHERE x.chat_id = ${chatId}::uuid
      ORDER BY x.sent_at NULLS LAST, x.id
      LIMIT ${THREAD_MAX_MESSAGES}`)
  ).rows;
}

// A long discussion's thread is cut here; the rest stays reachable from the map.
const THREAD_MAX_MESSAGES = 400;
// Messages shown before a discussion starts, so a reply's lead-up is visible.
const THREAD_BEFORE_MESSAGES = 6;
// Chatroom: messages shown each side of an opened message, and per page when scrolling further.
const CHATROOM_PAGE = 15;
// Reply steps followed up and down a WhatsApp reply chain.
const REPLY_CHAIN_MAX = 20;

export async function getMessage(db: Db, ctx: AuthCtx, messageId: string) {
  if (!isUuid(messageId)) throw new SafeError('message not found', 404, 'not_found');
  const [m] = await db.select().from(s.messages).where(and(eq(s.messages.id, messageId), eq(s.messages.workspaceId, ctx.workspaceId)));
  if (!m) throw new SafeError('message not found', 404, 'not_found');
  const chat = await requireChat(db, ctx, m.chatId);
  const tree = await loadTree(db, m.chatId);
  const placements = await db.select({ topicId: s.placements.topicId, discussionId: s.placements.discussionId, isPrimary: s.placements.isPrimary }).from(s.placements).where(eq(s.placements.messageId, m.id));
  const atts = await db.select().from(s.attachments).where(eq(s.attachments.messageId, m.id)).orderBy(s.attachments.ordinal);
  const [rs] = await db.select().from(s.reviewState).where(and(eq(s.reviewState.userId, ctx.userId), eq(s.reviewState.messageId, m.id)));
  const ctxRows = m.sentAt
    ? await db.execute<{ id: string; sender_label: string; body: string | null; sent_at: Date | null; kind: string; state: string; direction: string }>(sql`
        (SELECT id, sender_label, body, sent_at, kind, state, direction FROM messages WHERE chat_id = ${m.chatId}::uuid AND (sent_at, id) < (${m.sentAt}, ${m.id}::uuid) ORDER BY sent_at DESC, id DESC LIMIT ${CHATROOM_PAGE})
        UNION ALL
        (SELECT id, sender_label, body, sent_at, kind, state, direction FROM messages WHERE chat_id = ${m.chatId}::uuid AND (sent_at, id) > (${m.sentAt}, ${m.id}::uuid) ORDER BY sent_at, id LIMIT ${CHATROOM_PAGE})`)
    : { rows: [] };
  const threadRows = await discussionRows(db, m.chatId, m.id);
  // What led up to the discussion (a reply is meaningless without it): the messages just before
  // its first one, whatever discussion they belong to, and every message a thread message quotes.
  type Near = { id: string; sender_label: string; body: string | null; sent_at: Date | null; state: string; direction: string; native_id: string };
  const first = threadRows.find((r) => r.sent_at);
  const beforeRows = first
    ? (
        await db.execute<Near>(sql`
          SELECT id, sender_label, body, sent_at, state, direction, native_id FROM messages
          WHERE chat_id = ${m.chatId}::uuid AND (sent_at, id) < (${first.sent_at}, ${first.id}::uuid) ORDER BY sent_at DESC, id DESC LIMIT ${THREAD_BEFORE_MESSAGES}`)
      ).rows.reverse()
    : [];
  const quotedNatives = [...new Set(threadRows.map((r) => r.reply_to).filter((x): x is string => !!x))];
  const quoted = quotedNatives.length
    ? new Map(
        (
          await db.execute<Near>(sql`
            SELECT id, sender_label, body, sent_at, state, direction, native_id FROM messages
            WHERE chat_id = ${m.chatId}::uuid AND native_id IN (${sql.join(quotedNatives.map((n) => sql`${n}`), sql`, `)})`)
        ).rows.map((q) => [q.native_id, q]),
      )
    : new Map<string, Near>();
  // Answers Nemotron found where no WhatsApp reply was used.
  const answeredIds = [...new Set(threadRows.map((r) => r.inferred_reply_to).filter((x): x is string => !!x))];
  const answered = answeredIds.length
    ? new Map(
        (
          await db.execute<Near>(sql`
            SELECT id, sender_label, body, sent_at, state, direction, native_id FROM messages
            WHERE chat_id = ${m.chatId}::uuid AND id IN (${sql.join(answeredIds.map((id) => sql`${id}::uuid`), sql`, `)})`)
        ).rows.map((q) => [q.id, q]),
      )
    : new Map<string, Near>();
  // The reply chain: what this message replies to (and what that replies to), and every reply to
  // it (and replies to those), wherever they sit in the chat. A step is a WhatsApp reply, or else
  // an answer Nemotron found (marked inferred).
  type Chained = Near & { reply_to_native_id: string | null; inferred_reply_to: string | null; depth: number; inferred: boolean };
  const above: Chained[] = [];
  let up: { native: string | null; id: string | null } = { native: m.replyToNativeId, id: m.inferredReplyTo };
  for (let depth = 1; (up.native || up.id) && depth <= REPLY_CHAIN_MAX; depth++) {
    const inferred = !up.native;
    const [q] = (
      await db.execute<Chained>(sql`
        SELECT id, sender_label, body, sent_at, state, direction, native_id, reply_to_native_id, inferred_reply_to, ${depth}::int AS depth, ${inferred}::boolean AS inferred FROM messages
        WHERE chat_id = ${m.chatId}::uuid AND ${up.native ? sql`native_id = ${up.native}` : sql`id = ${up.id}::uuid`} ORDER BY sent_at NULLS LAST LIMIT 1`)
    ).rows;
    if (!q || q.id === m.id || above.some((a) => a.id === q.id)) break;
    above.push(q);
    up = { native: q.reply_to_native_id, id: q.inferred_reply_to };
  }
  const below = (
    await db.execute<Chained>(sql`
      WITH RECURSIVE d AS (
        SELECT id, native_id, 1 AS depth, (reply_to_native_id IS DISTINCT FROM ${m.nativeId}) AS inferred FROM messages
        WHERE chat_id = ${m.chatId}::uuid AND (reply_to_native_id = ${m.nativeId} OR inferred_reply_to = ${m.id}::uuid) AND id <> ${m.id}::uuid
        UNION
        SELECT x.id, x.native_id, d.depth + 1, (x.reply_to_native_id IS DISTINCT FROM d.native_id) FROM messages x
        JOIN d ON x.reply_to_native_id = d.native_id OR x.inferred_reply_to = d.id
        WHERE x.chat_id = ${m.chatId}::uuid AND x.id <> ${m.id}::uuid AND d.depth < ${REPLY_CHAIN_MAX}
      )
      SELECT x.id, x.sender_label, x.body, x.sent_at, x.state, x.direction, x.native_id, x.reply_to_native_id, x.inferred_reply_to, min(d.depth)::int AS depth, bool_and(d.inferred) AS inferred
      FROM d JOIN messages x ON x.id = d.id
      GROUP BY x.id ORDER BY x.sent_at NULLS LAST, x.id LIMIT ${REPLY_CHAIN_MAX * 10}`)
  ).rows;
  const isRead = rs?.status === 'read' && rs.reviewedRevision === m.contentRevision;
  const tombstoned = m.state !== 'active';
  // In a one-to-one chat the other side is the chat itself, even when WhatsApp sent no name.
  const senderOf = (label: string, direction: string) => (label === 'Unknown sender' && chat.kind === 'direct' && direction === 'incoming' ? chat.title : label);
  const at = (d: Date | null) => (d ? new Date(d).getTime() : 0);
  return {
    message_id: m.id,
    chat: { id: chat.id, title: chat.title, kind: chat.kind },
    sender: senderOf(m.senderLabel, m.direction),
    direction: m.direction,
    kind: m.kind,
    state: m.state,
    body: tombstoned ? null : m.body,
    marker: m.kind === 'unsupported' ? 'Unsupported message type (content not captured)' : m.kind === 'system' ? 'System event' : tombstoned ? `Message ${m.state}` : null,
    sent_at: m.sentAt?.toISOString() ?? null,
    received_at: m.receivedAt.toISOString(),
    edited_at: m.editedAt?.toISOString() ?? null,
    content_revision: m.contentRevision,
    review: isRead ? 'read' : 'missed',
    reviewable: !tombstoned && (m.kind === 'text' || m.kind === 'media'),
    topic_paths: placements.filter((p) => tree.nodes.has(p.topicId)).map((p) => ({ primary: p.isPrimary, root: tree.nodes.get(p.topicId)!.root, path: pathOf(tree, p.topicId) })),
    attachments: tombstoned
      ? []
      : atts.map((a) => ({
          id: a.id,
          media_type: a.mediaType,
          mime: a.detectedMime ?? a.declaredMime,
          filename: a.filename,
          size: a.byteCount ?? a.declaredSize,
          availability: a.availability,
          has_preview: a.thumbnail !== null,
          description: a.aiDescription,
        })),
    // The conversation around this message, in order, with this message in its place.
    context: [
      ...ctxRows.rows.map((c) => ({ id: c.id, sender_label: c.sender_label, body: c.body, sent_at: c.sent_at, state: c.state, direction: c.direction, current: false })),
      ...(m.sentAt ? [{ id: m.id, sender_label: m.senderLabel, body: m.body, sent_at: m.sentAt, state: m.state, direction: m.direction, current: true }] : []),
    ]
      .sort((a, b) => at(a.sent_at) - at(b.sent_at) || (a.id < b.id ? -1 : 1))
      .map((c) => ({
        message_id: c.id,
        sender: senderOf(c.sender_label, c.direction),
        direction: c.direction,
        current: c.current,
        snippet: c.state === 'active' ? (c.body ?? '').slice(0, 500) : null,
        sent_at: c.sent_at ? new Date(c.sent_at).toISOString() : null,
      })),
    // Every message of its discussion in order, filler and your own messages included.
    thread: threadRows.length
      ? {
          title: threadRows[0].title,
          messages: threadRows.map((c) => ({
            message_id: c.id,
            sender: senderOf(c.sender_label, c.direction),
            direction: c.direction,
            current: c.id === m.id,
            filler: c.filler === true,
            snippet: c.state === 'active' ? (c.body ?? '').slice(0, 500) : null,
            sent_at: c.sent_at ? new Date(c.sent_at).toISOString() : null,
            // The message this one quotes (WhatsApp "reply"), wherever it sits.
            reply_to: (() => {
              const q = c.reply_to ? quoted.get(c.reply_to) : undefined;
              return q ? { message_id: q.id, sender: senderOf(q.sender_label, q.direction), snippet: q.state === 'active' ? (q.body ?? '').slice(0, 200) : null } : null;
            })(),
            // The earlier message it answers without a WhatsApp reply, as Nemotron read it.
            answers: (() => {
              const q = !c.reply_to && c.inferred_reply_to ? answered.get(c.inferred_reply_to) : undefined;
              return q ? { message_id: q.id, sender: senderOf(q.sender_label, q.direction), snippet: q.state === 'active' ? (q.body ?? '').slice(0, 200) : null } : null;
            })(),
          })),
          // Whether Nemotron has read this discussion for answers given without a WhatsApp reply.
          answers_checked: threadRows.every((r) => r.inferred_at !== null),
          // The messages just before the discussion starts, for context.
          before: beforeRows.map((c) => ({
            message_id: c.id,
            sender: senderOf(c.sender_label, c.direction),
            direction: c.direction,
            snippet: c.state === 'active' ? (c.body ?? '').slice(0, 300) : null,
            sent_at: c.sent_at ? new Date(c.sent_at).toISOString() : null,
          })),
        }
      : null,
    // The reply chain: replied-to messages (oldest first) and replies (in time order), each with
    // how many reply steps away from this message it is.
    reply_chain: (() => {
      const item = (c: Chained) => ({
        message_id: c.id,
        sender: senderOf(c.sender_label, c.direction),
        direction: c.direction,
        snippet: c.state === 'active' ? (c.body ?? '').slice(0, 500) : null,
        sent_at: c.sent_at ? new Date(c.sent_at).toISOString() : null,
        depth: c.depth,
        inferred: c.inferred,
      });
      return { before: [...above].reverse().map(item), after: below.map(item) };
    })(),
    route: `/chats/${m.chatId}/messages/${m.id}`,
  };
}

/**
 * Chatroom: the chat in time order, as in WhatsApp, a page at a time before or
 * after a message (`from`, exclusive), for scrolling further from an opened message.
 */
export async function chatroomPage(db: Db, ctx: AuthCtx, messageId: string, dir: string | null) {
  if (!isUuid(messageId)) throw new SafeError('message not found', 404, 'not_found');
  const [m] = await db.select().from(s.messages).where(and(eq(s.messages.id, messageId), eq(s.messages.workspaceId, ctx.workspaceId)));
  if (!m?.sentAt) throw new SafeError('message not found', 404, 'not_found');
  const chat = await requireChat(db, ctx, m.chatId);
  const before = dir === 'before';
  const rows = (
    await db.execute<{ id: string; sender_label: string; body: string | null; sent_at: Date | null; state: string; direction: string }>(sql`
      SELECT id, sender_label, body, sent_at, state, direction FROM messages
      WHERE chat_id = ${m.chatId}::uuid AND ${before ? sql`(sent_at, id) < (${m.sentAt}, ${m.id}::uuid)` : sql`(sent_at, id) > (${m.sentAt}, ${m.id}::uuid)`}
      ORDER BY ${before ? sql`sent_at DESC, id DESC` : sql`sent_at, id`} LIMIT ${CHATROOM_PAGE}`)
  ).rows;
  if (before) rows.reverse();
  const senderOf = (label: string, direction: string) => (label === 'Unknown sender' && chat.kind === 'direct' && direction === 'incoming' ? chat.title : label);
  return {
    messages: rows.map((c) => ({
      message_id: c.id,
      sender: senderOf(c.sender_label, c.direction),
      direction: c.direction,
      current: false,
      snippet: c.state === 'active' ? (c.body ?? '').slice(0, 500) : null,
      sent_at: c.sent_at ? new Date(c.sent_at).toISOString() : null,
    })),
    more: rows.length === CHATROOM_PAGE,
  };
}

export async function putViewPreferences(db: Db, ctx: AuthCtx, chatId: string, body: unknown) {
  await requireChat(db, ctx, chatId);
  const b = (body ?? {}) as { show_depth?: unknown; auto_read?: unknown; collapsed?: unknown };
  const depth = parseDisplayDepth(typeof b.show_depth === 'number' ? String(b.show_depth) : typeof b.show_depth === 'string' ? b.show_depth : undefined);
  if (depth === undefined) throw new SafeError('show_depth must be a nonnegative integer or "all"');
  const collapsed = Array.isArray(b.collapsed) ? (b.collapsed as unknown[]).filter(isUuid).slice(0, 500) : undefined;
  const [row] = await db
    .insert(s.userChatViewPreferences)
    .values({ userId: ctx.userId, chatId, showDepth: String(depth), autoReadEnabled: b.auto_read === undefined ? true : Boolean(b.auto_read), collapsedNodeIds: collapsed ?? [] })
    .onConflictDoUpdate({
      target: [s.userChatViewPreferences.userId, s.userChatViewPreferences.chatId],
      set: {
        showDepth: String(depth),
        ...(b.auto_read === undefined ? {} : { autoReadEnabled: Boolean(b.auto_read) }),
        ...(collapsed ? { collapsedNodeIds: collapsed } : {}),
        revision: sql`${s.userChatViewPreferences.revision} + 1`,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return { show_depth: parseDisplayDepth(row.showDepth), auto_read: row.autoReadEnabled, revision: row.revision };
}

export async function getViewPreferences(db: Db, ctx: AuthCtx, chatId: string) {
  await requireChat(db, ctx, chatId);
  const [row] = await db.select().from(s.userChatViewPreferences).where(and(eq(s.userChatViewPreferences.userId, ctx.userId), eq(s.userChatViewPreferences.chatId, chatId)));
  return { show_depth: row ? parseDisplayDepth(row.showDepth) : view().defaultTopicDepth, auto_read: row?.autoReadEnabled ?? true, saved: Boolean(row) };
}

export async function reviewOne(db: Db, ctx: AuthCtx, body: unknown) {
  const b = (body ?? {}) as { message_id?: unknown; status?: unknown; revision?: unknown; source?: unknown };
  if (!isUuid(b.message_id) || (b.status !== 'read' && b.status !== 'missed') || !Number.isSafeInteger(b.revision)) throw new SafeError('invalid review request');
  return setReview(db, ctx, { messageId: b.message_id, status: b.status, observedRevision: b.revision as number, source: b.source === 'dwell' ? 'dwell' : 'manual' });
}

export async function bulkPreview(db: Db, ctx: AuthCtx, chatId: string, body: unknown) {
  await requireChat(db, ctx, chatId);
  const b = (body ?? {}) as { node_id?: unknown; filter?: Record<string, string> };
  const filter = parseContentFilter(new URLSearchParams(b.filter ?? {}), { tz: view().defaultTimezone });
  const nodeId = isUuid(b.node_id) ? b.node_id : null;
  const { mapId } = await mapFor(db, chatId, new URLSearchParams(b.filter ?? {}));
  return createBulkSnapshot(db, ctx, chatId, nodeId, filter, mapId);
}

export async function bulkExecute(db: Db, ctx: AuthCtx, body: unknown) {
  const b = (body ?? {}) as { snapshot_id?: unknown; target?: unknown };
  if (!isUuid(b.snapshot_id) || (b.target !== 'read' && b.target !== 'missed')) throw new SafeError('invalid bulk request');
  return executeBulk(db, ctx, b.snapshot_id, b.target);
}

export async function patchTopic(db: Db, ctx: AuthCtx, topicId: string, body: unknown) {
  if (!isUuid(topicId)) throw new SafeError('topic not found', 404, 'not_found');
  const b = (body ?? {}) as { title?: unknown; parent_id?: unknown; merge_into_id?: unknown; expected_graph_version?: unknown };
  return db.transaction((tx) =>
    editTopic(tx, ctx, topicId, {
      title: typeof b.title === 'string' ? b.title : undefined,
      parentId: isUuid(b.parent_id) ? b.parent_id : undefined,
      mergeIntoId: isUuid(b.merge_into_id) ? b.merge_into_id : undefined,
      expectedGraphVersion: typeof b.expected_graph_version === 'number' ? b.expected_graph_version : undefined,
    }),
  );
}

export async function patchPlacement(db: Db, ctx: AuthCtx, body: unknown) {
  const b = (body ?? {}) as { message_id?: unknown; add_topic_id?: unknown; remove_topic_id?: unknown };
  if (!isUuid(b.message_id)) throw new SafeError('invalid placement request');
  return db.transaction((tx) =>
    correctPlacement(tx, ctx, { messageId: b.message_id as string, addTopicId: isUuid(b.add_topic_id) ? b.add_topic_id : undefined, removeTopicId: isUuid(b.remove_topic_id) ? b.remove_topic_id : undefined }),
  );
}

/** Unicode-aware substring search over text, sender, filename, URL and topic titles, under the shared filters. */
export async function search(db: Db, ctx: AuthCtx, params: URLSearchParams) {
  const q = normalizeSearch(params.get('q') ?? '');
  if (q.length < 1 || q.length > 200) throw new SafeError('search query must be 1–200 characters');
  const chatParam = params.get('chat');
  const chats = chatParam ? [await requireChat(db, ctx, chatParam)] : await db.select().from(s.chats).where(and(eq(s.chats.workspaceId, ctx.workspaceId), eq(s.chats.excluded, false)));
  if (!chats.length) return { query: q, results: [], topics: [] };
  const filter = parseContentFilter(params, { tz: view().defaultTimezone });
  const chatIds = chats.map((c) => c.id);
  const matching = matchingMessagesSql({ userId: ctx.userId, workspaceId: ctx.workspaceId, chatIds }, filter);
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await db.execute<{ id: string; chat_id: string; sender_label: string; body: string | null; sent_at: Date | null; is_read: boolean; content_revision: number }>(sql`
    WITH mt AS (${matching})
    SELECT m.id, m.chat_id, m.sender_label, m.body, m.sent_at, mt.is_read, m.content_revision
    FROM messages m JOIN mt ON mt.id = m.id
    WHERE m.search_text LIKE ${like}
       OR m.id IN (SELECT p.message_id FROM placements p JOIN topics t ON t.id = p.topic_id WHERE lower(t.title) LIKE ${like} AND t.workspace_id = ${ctx.workspaceId}::uuid)
    ORDER BY m.sent_at DESC NULLS LAST, m.id DESC LIMIT 100`);
  const trees = new Map(await Promise.all(chatIds.map(async (c) => [c, await loadTree(db, c)] as const)));
  const placementRows = rows.rows.length
    ? await db.select({ messageId: s.placements.messageId, topicId: s.placements.topicId }).from(s.placements).where(inArray(s.placements.messageId, rows.rows.map((r) => r.id)))
    : [];
  const topicHits = [...trees.entries()].flatMap(([chatId, tree]) =>
    [...tree.nodes.values()].filter((n) => normalizeSearch(n.title).includes(q)).map((n) => ({ chat_id: chatId, topic_id: n.id, path: pathOf(tree, n.id) })),
  );
  return {
    query: q,
    filter_fingerprint: filterFingerprint({ userId: ctx.userId, workspaceId: ctx.workspaceId, chatIds }, filter),
    results: rows.rows.map((r) => {
      const body = r.body ?? '';
      const idx = normalizeSearch(body).indexOf(q);
      const start = Math.max(0, idx - 60);
      return {
        message_id: r.id,
        chat_id: r.chat_id,
        sender: r.sender_label,
        snippet: body.slice(start, start + 200),
        sent_at: r.sent_at ? new Date(r.sent_at).toISOString() : null,
        review: r.is_read ? 'read' : 'missed',
        content_revision: r.content_revision,
        topic_paths: placementRows.filter((p) => p.messageId === r.id && trees.get(r.chat_id)?.nodes.has(p.topicId)).map((p) => pathOf(trees.get(r.chat_id)!, p.topicId)),
        route: `/chats/${r.chat_id}/messages/${r.id}`,
      };
    }),
    topics: topicHits.slice(0, 50),
  };
}

/** Resource cards (URLs/files) for matching messages, using the shared filter. */
export async function resourcesFor(db: Db, ctx: AuthCtx, chatId: string, params: URLSearchParams) {
  await requireChat(db, ctx, chatId);
  const filter = parseContentFilter(params, { tz: view().defaultTimezone });
  const matching = matchingMessagesSql({ userId: ctx.userId, workspaceId: ctx.workspaceId, chatIds: [chatId] }, filter);
  const r = await db.execute<{ id: string; kind: string; url: string | null; label: string | null; message_id: string; attachment_id: string | null }>(sql`
    WITH mt AS (${matching})
    SELECT r.id, r.kind, r.url, r.label, r.message_id, r.attachment_id FROM resources r JOIN mt ON mt.id = r.message_id
    WHERE r.chat_id = ${chatId}::uuid ORDER BY r.created_at DESC LIMIT 500`);
  return { items: r.rows, message_ids: [...new Set(r.rows.map((x) => x.message_id))] };
}

/** Up to five verified, non-dismissed related items for a topic (either side). */
export async function related(db: Db, ctx: AuthCtx, topicId: string) {
  if (!isUuid(topicId)) throw new SafeError('topic not found', 404, 'not_found');
  const [topic] = await db.select().from(s.topics).where(and(eq(s.topics.id, topicId), eq(s.topics.workspaceId, ctx.workspaceId)));
  if (!topic) throw new SafeError('topic not found', 404, 'not_found');
  const links = await db
    .select()
    .from(s.crossChatLinks)
    .where(and(eq(s.crossChatLinks.workspaceId, ctx.workspaceId), eq(s.crossChatLinks.status, 'verified'), eq(s.crossChatLinks.dismissed, false), or(eq(s.crossChatLinks.aTopicId, topicId), eq(s.crossChatLinks.bTopicId, topicId))))
    .orderBy(desc(s.crossChatLinks.createdAt))
    .limit(5);
  const out = [];
  for (const l of links) {
    const ta = await loadTree(db, l.aChatId);
    const tb = await loadTree(db, l.bChatId);
    const [ca] = await db.select({ title: s.chats.title }).from(s.chats).where(eq(s.chats.id, l.aChatId));
    const [cb] = await db.select({ title: s.chats.title }).from(s.chats).where(eq(s.chats.id, l.bChatId));
    const ev = async (list: { messageId: string; revision: number }[]) => {
      if (!list.length) return [];
      const rows = await db.select({ id: s.messages.id, body: s.messages.body, rev: s.messages.contentRevision, state: s.messages.state, sender: s.messages.senderLabel, chatId: s.messages.chatId }).from(s.messages).where(inArray(s.messages.id, list.map((x) => x.messageId)));
      // Evidence must still be the analyzed, current revision.
      return rows.filter((r) => r.state === 'active' && list.some((x) => x.messageId === r.id && x.revision === r.rev)).map((r) => ({ message_id: r.id, sender: r.sender, snippet: (r.body ?? '').slice(0, 200), route: `/chats/${r.chatId}/messages/${r.id}` }));
    };
    out.push({
      link_id: l.id,
      relation_type: l.relationType,
      reason: l.reason,
      a: { chat_id: l.aChatId, chat_title: ca?.title, topic_id: l.aTopicId, path: ta.nodes.has(l.aTopicId) ? pathOf(ta, l.aTopicId) : [], evidence: await ev(l.aEvidence) },
      b: { chat_id: l.bChatId, chat_title: cb?.title, topic_id: l.bTopicId, path: tb.nodes.has(l.bTopicId) ? pathOf(tb, l.bTopicId) : [], evidence: await ev(l.bEvidence) },
    });
  }
  return { topic_id: topicId, related: out.filter((x) => x.a.evidence.length && x.b.evidence.length) };
}

export async function dismissLink(db: Db, ctx: AuthCtx, linkId: string) {
  if (!isUuid(linkId)) throw new SafeError('link not found', 404, 'not_found');
  const r = await db
    .update(s.crossChatLinks)
    .set({ dismissed: true, dismissedBy: ctx.userId, updatedAt: sql`now()` })
    .where(and(eq(s.crossChatLinks.id, linkId), eq(s.crossChatLinks.workspaceId, ctx.workspaceId)))
    .returning({ id: s.crossChatLinks.id });
  if (!r.length) throw new SafeError('link not found', 404, 'not_found');
  return { dismissed: true };
}

export async function jobStatus(db: Db, ctx: AuthCtx, jobId: string) {
  if (!isUuid(jobId)) throw new SafeError('job not found', 404, 'not_found');
  const [j] = await db.select().from(s.analysisJobs).where(and(eq(s.analysisJobs.id, jobId), eq(s.analysisJobs.workspaceId, ctx.workspaceId)));
  if (!j) throw new SafeError('job not found', 404, 'not_found');
  const [ledger] = await db.select().from(s.budgetLedger).where(eq(s.budgetLedger.logicalJobId, j.logicalJobId));
  return {
    id: j.id,
    kind: j.kind,
    status: j.status,
    attempts: j.attempts,
    safe_error: j.safeError,
    created_at: j.createdAt.toISOString(),
    completed_at: j.completedAt?.toISOString() ?? null,
    budget: ledger ? { calls_used: ledger.callsUsed, max_calls: ledger.maxCalls, usd_used: ledger.usdMicrosUsed / 1e6, max_usd: ledger.maxUsdMicros / 1e6 } : null,
  };
}

/**
 * Messages the owner starred in WhatsApp, newest star first: in one chat, or in
 * every opened chat. Stars follow the phone; ThreadMap only lists them.
 */
export async function listStarred(db: Db, ctx: AuthCtx, params: URLSearchParams) {
  const chatParam = params.get('chat');
  const chats = chatParam
    ? [await requireChat(db, ctx, chatParam)]
    : await db.select().from(s.chats).where(and(eq(s.chats.workspaceId, ctx.workspaceId), eq(s.chats.excluded, false), eq(s.chats.selected, true)));
  if (!chats.length) return { messages: [] };
  const titleOf = new Map(chats.map((c) => [c.id, c.title]));
  const rows = await db.execute<{ id: string; chat_id: string; sender_label: string; body: string | null; kind: string; sent_at: Date | null; starred_at: Date | null; content_revision: number; read: boolean }>(sql`
    SELECT m.id, m.chat_id, m.sender_label, m.body, m.kind, m.sent_at, m.starred_at, m.content_revision,
      EXISTS (SELECT 1 FROM review_state r WHERE r.user_id = ${ctx.userId} AND r.message_id = m.id AND r.status = 'read' AND r.reviewed_revision = m.content_revision) AS read
    FROM messages m
    WHERE m.chat_id IN (${sql.join(chats.map((c) => sql`${c.id}::uuid`), sql`, `)}) AND m.starred AND m.state = 'active'
    ORDER BY m.starred_at DESC NULLS LAST, m.sent_at DESC NULLS LAST
    LIMIT 500`);
  const ids = rows.rows.map((r) => r.id);
  const placed = ids.length ? await db.select({ messageId: s.placements.messageId, topicId: s.placements.topicId }).from(s.placements).where(and(inArray(s.placements.messageId, ids), eq(s.placements.isPrimary, true))) : [];
  const trees = new Map(await Promise.all([...new Set(rows.rows.map((r) => r.chat_id))].map(async (c) => [c, await loadTree(db, c)] as const)));
  return {
    messages: rows.rows.map((r) => {
      const tree = trees.get(r.chat_id)!;
      const topic = placed.find((p) => p.messageId === r.id && tree.nodes.has(p.topicId));
      return {
        message_id: r.id,
        chat_id: r.chat_id,
        chat_title: titleOf.get(r.chat_id) ?? '',
        sender: r.sender_label,
        snippet: (r.body ?? (r.kind === 'media' ? '[media]' : '')).slice(0, 280),
        sent_at: r.sent_at ? new Date(r.sent_at).toISOString() : null,
        review: r.read ? 'read' : 'missed',
        topic_path: topic ? pathOf(tree, topic.topicId).map((p) => p.title) : [],
      };
    }),
  };
}

/**
 * The small talk left off a chat's map ("ok", "lol", throwaway quips), newest first, a page at
 * a time, so the owner can check that nothing important was screened out.
 */
export async function listSmallTalk(db: Db, ctx: AuthCtx, chatId: string, params: URLSearchParams) {
  const chat = await requireChat(db, ctx, chatId);
  const PAGE = 200;
  const offset = Math.max(0, Math.min(1_000_000, Number(params.get('offset')) || 0));
  const rows = await db.execute<{ id: string; sender_label: string; body: string | null; kind: string; sent_at: Date | null; read: boolean; total: number }>(sql`
    SELECT m.id, m.sender_label, m.body, m.kind, m.sent_at,
      EXISTS (SELECT 1 FROM review_state r WHERE r.user_id = ${ctx.userId} AND r.message_id = m.id AND r.status = 'read' AND r.reviewed_revision = m.content_revision) AS read,
      count(*) OVER ()::int AS total
    FROM messages m
    WHERE m.chat_id = ${chat.id}::uuid AND m.filler AND m.state = 'active'
    ORDER BY m.sent_at DESC NULLS LAST, m.id DESC
    LIMIT ${PAGE} OFFSET ${offset}`);
  const total = rows.rows[0]?.total ?? 0;
  return {
    total,
    next_offset: offset + rows.rows.length < total ? offset + rows.rows.length : null,
    messages: rows.rows.map((r) => ({
      message_id: r.id,
      chat_id: chat.id,
      sender: r.sender_label,
      snippet: (r.body ?? (r.kind === 'media' ? '[media]' : '')).slice(0, 280),
      sent_at: r.sent_at ? new Date(r.sent_at).toISOString() : null,
      review: r.read ? ('read' as const) : ('missed' as const),
    })),
  };
}

/**
 * How many messages a chat holds on each day (in the viewer's time zone, the days the map's
 * date filter uses), oldest first: the date slider spans exactly these days.
 */
export async function listChatDays(db: Db, ctx: AuthCtx, chatId: string, params: URLSearchParams) {
  const chat = await requireChat(db, ctx, chatId);
  const asked = params.get('tz');
  const tz = asked && validTimezone(asked) ? asked : loadViewConfig().defaultTimezone;
  const rows = await db.execute<{ day: string; n: number }>(sql`
    SELECT to_char((m.sent_at AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS day, count(*)::int AS n
    FROM messages m
    WHERE m.chat_id = ${chat.id}::uuid AND m.state = 'active' AND m.kind IN ('text', 'media') AND m.sent_at IS NOT NULL
    GROUP BY 1 ORDER BY 1`);
  return { tz, days: rows.rows };
}

