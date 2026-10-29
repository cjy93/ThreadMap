// Concept map: a study guide built from one opened message. Nemotron Ultra reads
// the message's discussion, its reply chain (questions and their answers) and
// every message of its topic branch from the opened topic back up to the root
// category, from everyone in the chat; then searches the web for documentation
// when the chat does not explain enough (Tavily), and links the concepts into a
// map with a study guide. Only Knowledge and Resources messages have one.
// The build runs in the worker (which holds the keys) and is saved, so it is
// built once and reopened instantly.
import crypto from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import * as s from '../../db/schema';
import type { LlmConfig } from '../../lib/config';
import { studyMapPrompt, studyPlanPrompt, type StudyDiscussion, type StudyMessage } from '../ai/prompts';
import type { ModelProvider } from '../ai/provider';
import { BudgetExceededError, callModel, ensureLedger, estimateTokens } from '../ai/router';
import { JSON_SCHEMAS, StudyMapSchema, StudyPlanSchema } from '../ai/schemas';
import { cleanQuery, type WebResult, type WebSearch } from '../ai/websearch';
import type { Db } from '../db';
import { ancestors, descendantIds, loadTree, type RootEnum } from '../graph/tree';
import { ASK_CHANNEL } from '../notify';
import { isUuid, SafeError } from '../util';
import { modelProblem } from './ask';
import { discussionRows, requireChat, type AuthCtx } from './service';

/** Roots whose messages have a concept map: study material, not chat or plans. */
export const STUDY_ROOTS: readonly RootEnum[] = ['KNOWLEDGE', 'RESOURCES'];

// What Ultra reads: at most this many messages, each cut to this length.
const MAX_MESSAGES = 220;
const MESSAGE_CHARS = 500;
const MAX_DISCUSSIONS = 40;
const REPLY_STEPS = 10;
// The read may use this many times the usual per-call input limit (Ultra has a long context).
const INPUT_MULTIPLE = 3;
const PLAN_OUTPUT_TOKENS = 6000;
const MAP_OUTPUT_TOKENS = 8000;
const ULTRA_TIMEOUT_MS = 300_000;
const MAX_WEB_RESULTS = 16;
// A build not finished by then has died with its worker.
const STALE_MS = 15 * 60_000;

type Row = {
  id: string;
  sender_label: string;
  body: string | null;
  sent_at: Date | string | null;
  native_id: string;
  reply_to_native_id: string | null;
  inferred_reply_to: string | null;
  seen: string | null;
};

const rowCols = sql`m.id, m.sender_label, m.body, m.sent_at, m.native_id, m.reply_to_native_id, m.inferred_reply_to,
  (SELECT string_agg(a.ai_description, ' ') FROM attachments a WHERE a.message_id = m.id AND a.ai_description IS NOT NULL) AS seen`;
const timeOf = (d: Date | string | null) => (d ? new Date(d).getTime() : 0);
const usable = sql`m.state = 'active' AND m.kind IN ('text','media') AND (m.expires_at IS NULL OR m.expires_at > now())`;

/** The topic a message sits in on the chat's own map (its primary placement first) and that topic's root. */
async function placementOf(db: Db, chatId: string, messageId: string) {
  const tree = await loadTree(db, chatId);
  const pls = await db
    .select({ topicId: s.placements.topicId, isPrimary: s.placements.isPrimary })
    .from(s.placements)
    .where(and(eq(s.placements.messageId, messageId), eq(s.placements.chatId, chatId)));
  pls.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  const p = pls.find((x) => tree.nodes.has(x.topicId));
  return { tree, topicId: p?.topicId ?? null, root: p ? tree.nodes.get(p.topicId)!.root : null };
}

/**
 * Everything the concept map reads, most relevant first: the opened message, its
 * reply chain and discussion; then its topic and everything beneath it; then each
 * broader topic on the way up to the root category. Messages from everyone.
 */
export async function studyContext(db: Db, chatId: string, messageId: string, cfg: LlmConfig) {
  const { tree, topicId, root } = await placementOf(db, chatId, messageId);
  if (!topicId || !root) throw new SafeError('This message is not on the map yet.', 409, 'not_analysed');
  const chain = ancestors(tree, topicId);
  const topicPath = chain.map((n) => n.title).join(' › ');
  const rowsOf = async (where: ReturnType<typeof sql>, limit = MAX_MESSAGES) =>
    (await db.execute<Row>(sql`SELECT ${rowCols} FROM messages m WHERE m.chat_id = ${chatId}::uuid AND ${usable} AND ${where} ORDER BY m.sent_at NULLS LAST, m.id LIMIT ${limit}`)).rows;
  const ids = (xs: string[]) => sql.join(xs.map((x) => sql`${x}::uuid`), sql`, `);

  // 1. The opened message, what it replies to (step by step) and every reply below it.
  const [opened] = await rowsOf(sql`m.id = ${messageId}::uuid`, 1);
  if (!opened) throw new SafeError('message not found', 404, 'not_found');
  const first: Row[] = [opened];
  let up = { native: opened.reply_to_native_id, id: opened.inferred_reply_to };
  for (let i = 0; i < REPLY_STEPS && (up.native || up.id); i++) {
    const [q] = await rowsOf(up.native ? sql`m.native_id = ${up.native}` : sql`m.id = ${up.id}::uuid`, 1);
    if (!q || first.some((r) => r.id === q.id)) break;
    first.push(q);
    up = { native: q.reply_to_native_id, id: q.inferred_reply_to };
  }
  const below = await db.execute<{ id: string }>(sql`
    WITH RECURSIVE d AS (
      SELECT id, native_id, 1 AS depth FROM messages WHERE chat_id = ${chatId}::uuid AND (reply_to_native_id = ${opened.native_id} OR inferred_reply_to = ${opened.id}::uuid)
      UNION
      SELECT x.id, x.native_id, d.depth + 1 FROM messages x JOIN d ON x.reply_to_native_id = d.native_id OR x.inferred_reply_to = d.id
      WHERE x.chat_id = ${chatId}::uuid AND d.depth < ${REPLY_STEPS})
    SELECT DISTINCT id FROM d LIMIT 80`);
  const discussion = (await discussionRows(db, chatId, messageId)).filter((r) => r.state === 'active' && !r.filler).map((r) => r.id);
  const nearIds = [...new Set([...below.rows.map((r) => r.id), ...discussion])].filter((id) => !first.some((r) => r.id === id));
  if (nearIds.length) first.push(...(await rowsOf(sql`m.id IN (${ids(nearIds)})`)));

  // 2. Its topic and everything beneath it; 3. each broader topic up to (not including) the root category.
  const placedIn = async (topicIds: string[]) =>
    topicIds.length
      ? rowsOf(sql`NOT COALESCE(m.filler, false) AND EXISTS (SELECT 1 FROM placements p WHERE p.message_id = m.id AND p.topic_id IN (${ids(topicIds)}))`)
      : [];
  const groups: Row[][] = [first, await placedIn([topicId]), await placedIn(descendantIds(tree, topicId).filter((t) => t !== topicId))];
  const broader = chain.slice(1, -1).reverse(); // nearest first; chain[0] is the root category
  for (const t of broader) groups.push(await placedIn([t.id]));

  // Fill the read in that order, within the size Ultra is given.
  const budget = cfg.LLM_MAX_INPUT_TOKENS_PER_CALL * INPUT_MULTIPLE * 0.7;
  const textOf = (r: Row) => [r.body ?? '', r.seen ? `[image: ${r.seen}]` : ''].filter(Boolean).join(' ').slice(0, MESSAGE_CHARS);
  const chosen = new Map<string, Row>();
  let used = 0;
  for (const g of groups) {
    for (const r of g) {
      if (chosen.has(r.id) || chosen.size >= MAX_MESSAGES) continue;
      const cost = estimateTokens(textOf(r)) + 25;
      if (used + cost > budget && chosen.size) continue;
      chosen.set(r.id, r);
      used += cost;
    }
  }
  const rows = [...chosen.values()].sort((a, b) => timeOf(a.sent_at) - timeOf(b.sent_at) || (a.id < b.id ? -1 : 1));
  const refOf = new Map(rows.map((r, i) => [r.id, `m${i + 1}`]));
  const refOfNative = new Map(rows.map((r) => [r.native_id, refOf.get(r.id)!]));
  // A quoted message outside the read still shows what was asked.
  const missingNatives = [...new Set(rows.map((r) => r.reply_to_native_id).filter((n): n is string => !!n && !refOfNative.has(n)))];
  const quoted = missingNatives.length
    ? new Map(
        (await db.execute<{ native_id: string; body: string | null }>(sql`SELECT native_id, body FROM messages WHERE chat_id = ${chatId}::uuid AND state = 'active' AND native_id IN (${sql.join(missingNatives.map((n) => sql`${n}`), sql`, `)})`)).rows.map(
          (q) => [q.native_id, q.body],
        ),
      )
    : new Map<string, string | null>();
  const messages: StudyMessage[] = rows.map((r) => {
    const replyTo = r.reply_to_native_id
      ? (refOfNative.get(r.reply_to_native_id) ?? (quoted.get(r.reply_to_native_id) ? `quote: ${quoted.get(r.reply_to_native_id)!.slice(0, 160)}` : null))
      : r.inferred_reply_to
        ? (refOf.get(r.inferred_reply_to) ?? null)
        : null;
    return { ref: refOf.get(r.id)!, sender: r.sender_label, time: r.sent_at ? new Date(r.sent_at).toISOString().slice(0, 16) : null, text: textOf(r), ...(replyTo ? { reply_to: replyTo } : {}), ...(r.id === messageId ? { opened: true } : {}) };
  });

  // Nemotron's discussion summaries in the same branch, nearest topic first.
  const branch = [topicId, ...descendantIds(tree, topicId).filter((t) => t !== topicId), ...broader.map((t) => t.id)];
  const units = await db
    .select({ topicId: s.analysisUnits.assignedTopicId, meta: s.analysisUnits.summaryBullets })
    .from(s.analysisUnits)
    .where(and(eq(s.analysisUnits.chatId, chatId), inArray(s.analysisUnits.assignedTopicId, branch)));
  units.sort((a, b) => branch.indexOf(a.topicId!) - branch.indexOf(b.topicId!));
  const discussions: StudyDiscussion[] = units.slice(0, MAX_DISCUSSIONS).map((u) => {
    const meta = u.meta as { title?: string; bullets?: { text: string }[] };
    return { topic: tree.nodes.get(u.topicId!)?.title ?? '', title: meta.title ?? '', points: (meta.bullets ?? []).slice(0, 3).map((b) => b.text.slice(0, 200)) };
  });
  const senders = [...new Set(rows.map((r) => r.sender_label))];
  return { root, topicPath, messages, discussions, idOfRef: new Map([...refOf].map(([id, ref]) => [ref, id])), senders };
}

/** What is saved and shown: concepts and guide sections cite message ids and web page numbers. */
export interface StudyMapResult {
  title: string;
  summary: string;
  subject: string;
  topic_path: string;
  concepts: { key: string; label: string; kind: 'core' | 'concept' | 'detail' | 'example' | 'question'; explanation: string; messages: string[]; web: number[] }[];
  relations: { from: string; to: string; label: string }[];
  guide: { heading: string; text: string; messages: string[]; web: number[] }[];
  gaps: string[];
  web: { enabled: boolean; queries: string[]; results: { title: string; url: string }[]; note: string | null };
  read: { messages: number; discussions: number };
}

const KINDS = new Set(['core', 'concept', 'detail', 'example', 'question']);

/** Runs in the worker: claim a waiting concept map and build it. Never throws; a failure is saved on the row. */
export async function buildStudyMap(deps: { db: Db; provider: ModelProvider; cfg: LlmConfig }, studyMapId: string, search: WebSearch | null): Promise<void> {
  const { db } = deps;
  if (!isUuid(studyMapId)) return;
  const claimed = await db.execute<{ workspace_id: string; chat_id: string; message_id: string }>(sql`
    UPDATE study_maps SET status = 'reading', updated_at = now() WHERE id = ${studyMapId}::uuid AND status = 'pending'
    RETURNING workspace_id, chat_id, message_id`);
  const job = claimed.rows[0];
  if (!job) return;
  const stage = (status: 'searching' | 'building') => db.execute(sql`UPDATE study_maps SET status = ${status}, updated_at = now() WHERE id = ${studyMapId}::uuid`);
  try {
    const limit = deps.cfg.LLM_MAX_INPUT_TOKENS_PER_CALL * INPUT_MULTIPLE;
    const cfg = { ...deps.cfg, LLM_MAX_INPUT_TOKENS_PER_CALL: limit, LLM_MAX_OUTPUT_TOKENS_PER_CALL: Math.max(deps.cfg.LLM_MAX_OUTPUT_TOKENS_PER_CALL, MAP_OUTPUT_TOKENS) };
    const ctx = await studyContext(db, job.chat_id, job.message_id, deps.cfg);
    const logicalJobId = crypto.randomUUID();
    await ensureLedger(db, job.workspace_id, logicalJobId, cfg);
    const scope = { workspaceId: job.workspace_id, logicalJobId };
    const maxSearches = search ? deps.cfg.STUDY_MAP_MAX_SEARCHES : 0;

    // Step 1: Ultra reads the branch, works out the questions and answers, and decides what to look up.
    const plan = (
      await callModel({ ...deps, cfg }, scope, {
        role: 'reasoning',
        operation: 'study_plan',
        ...studyPlanPrompt(ctx.topicPath, ctx.messages, ctx.discussions, maxSearches),
        schema: StudyPlanSchema,
        schemaName: 'study_plan',
        jsonSchema: JSON_SCHEMAS.study_plan,
        maxOutputTokens: PLAN_OUTPUT_TOKENS,
        timeoutMs: ULTRA_TIMEOUT_MS,
      })
    ).value;

    // Web search, only for what Ultra asked, with anything personal removed from each query.
    const queries = [...new Set(plan.searches.map((q) => cleanQuery(q.query, ctx.senders)).filter(Boolean))].slice(0, maxSearches);
    const results: WebResult[] = [];
    let webNote: string | null = search ? null : 'Web search is off (no Tavily API key), so this map is built from the chat alone.';
    if (search && queries.length) {
      await stage('searching');
      const found = await Promise.allSettled(queries.map((q) => search(q)));
      for (const f of found) {
        if (f.status !== 'fulfilled') continue;
        for (const r of f.value) if (results.length < MAX_WEB_RESULTS && !results.some((x) => x.url === r.url)) results.push(r);
      }
      if (found.every((f) => f.status === 'rejected')) webNote = 'Web search failed, so this map is built from the chat alone.';
    }
    const web = results.map((r, i) => ({ ref: `w${i + 1}`, ...r }));

    // Step 2: Ultra links the concepts and writes the study guide.
    await stage('building');
    const shown = (
      await callModel({ ...deps, cfg }, scope, {
        role: 'reasoning',
        operation: 'study_map',
        ...studyMapPrompt(ctx.topicPath, plan, ctx.messages, ctx.discussions, web),
        schema: StudyMapSchema,
        schemaName: 'study_map',
        jsonSchema: JSON_SCHEMAS.study_map,
        maxOutputTokens: MAP_OUTPUT_TOKENS,
        // The reasoning was done in step 1; a second trace would only slow this long answer down.
        thinking: false,
        timeoutMs: ULTRA_TIMEOUT_MS,
      })
    ).value;

    // Keep only refs that exist; links only between concepts that exist; exactly one core.
    const cites = (refs: string[]) => ({
      messages: [...new Set(refs.flatMap((r) => (ctx.idOfRef.has(r) ? [ctx.idOfRef.get(r)!] : [])))],
      web: [...new Set(refs.flatMap((r) => (/^w\d+$/.test(r) && Number(r.slice(1)) <= web.length ? [Number(r.slice(1)) - 1] : [])))],
    });
    const seenKeys = new Set<string>();
    const concepts = shown.concepts
      .filter((c) => !seenKeys.has(c.key) && seenKeys.add(c.key))
      .map((c) => ({ key: c.key, label: c.label, kind: (KINDS.has(c.kind) ? c.kind : 'concept') as StudyMapResult['concepts'][number]['kind'], explanation: c.explanation, ...cites(c.refs) }));
    const cores = concepts.filter((c) => c.kind === 'core');
    for (const c of cores.slice(1)) c.kind = 'concept';
    if (!cores.length) concepts[0].kind = 'core';
    const relations = shown.relations.filter((r) => r.from !== r.to && seenKeys.has(r.from) && seenKeys.has(r.to));
    const result: StudyMapResult = {
      title: shown.title,
      summary: shown.summary,
      subject: plan.subject,
      topic_path: ctx.topicPath,
      concepts,
      relations,
      guide: shown.guide.map((g) => ({ heading: g.heading, text: g.text, ...cites(g.refs) })),
      gaps: shown.gaps,
      web: { enabled: Boolean(search), queries, results: web.map((w) => ({ title: w.title, url: w.url })), note: webNote },
      read: { messages: ctx.messages.length, discussions: ctx.discussions.length },
    };
    await db.update(s.studyMaps).set({ status: 'done', result, safeError: null, updatedAt: new Date() }).where(eq(s.studyMaps.id, studyMapId));
  } catch (e) {
    if (process.env.DEBUG_MODEL_VALIDATION) console.error('study map failed', e);
    // Saved for the page; no chat content in it.
    const reason = e instanceof SafeError ? e.message : e instanceof BudgetExceededError ? modelProblem(`budget_${e.scope}`) : modelProblem('error');
    await db.update(s.studyMaps).set({ status: 'failed', safeError: reason, updatedAt: new Date() }).where(eq(s.studyMaps.id, studyMapId));
  }
}

const IN_PROGRESS = ['pending', 'reading', 'searching', 'building'];

async function latest(db: Db, workspaceId: string, messageId: string) {
  const [row] = await db
    .select()
    .from(s.studyMaps)
    .where(and(eq(s.studyMaps.messageId, messageId), eq(s.studyMaps.workspaceId, workspaceId)))
    .orderBy(desc(s.studyMaps.createdAt))
    .limit(1);
  if (row && IN_PROGRESS.includes(row.status) && Date.now() - row.updatedAt.getTime() > STALE_MS) return { ...row, status: 'failed' as const, safeError: 'The build stopped before finishing; build it again.' };
  return row ?? null;
}

async function requireMessage(db: Db, ctx: AuthCtx, messageId: string) {
  if (!isUuid(messageId)) throw new SafeError('message not found', 404, 'not_found');
  const [m] = await db.select({ chatId: s.messages.chatId }).from(s.messages).where(and(eq(s.messages.id, messageId), eq(s.messages.workspaceId, ctx.workspaceId)));
  if (!m) throw new SafeError('message not found', 404, 'not_found');
  await requireChat(db, ctx, m.chatId);
  return m;
}

/** GET /api/messages/:id/concept-map — the latest concept map for this message, with its sources. */
export async function getStudyMap(db: Db, ctx: AuthCtx, messageId: string) {
  await requireMessage(db, ctx, messageId);
  const row = await latest(db, ctx.workspaceId, messageId);
  if (!row) return { state: 'none' as const };
  if (row.status !== 'done') return { state: row.status, id: row.id, note: row.safeError ?? null, started_at: row.createdAt.toISOString() };
  const map = row.result as StudyMapResult;
  // Each cited message as a clickable source; a message deleted since drops out.
  const ids = [...new Set([...map.concepts.flatMap((c) => c.messages), ...map.guide.flatMap((g) => g.messages)])];
  const srcRows = ids.length
    ? await db
        .select({ id: s.messages.id, chatId: s.messages.chatId, sender: s.messages.senderLabel, body: s.messages.body, sentAt: s.messages.sentAt })
        .from(s.messages)
        .where(and(inArray(s.messages.id, ids), eq(s.messages.workspaceId, ctx.workspaceId), eq(s.messages.state, 'active')))
    : [];
  return {
    state: 'done' as const,
    id: row.id,
    built_at: row.updatedAt.toISOString(),
    map,
    sources: Object.fromEntries(srcRows.map((m) => [m.id, { message_id: m.id, chat_id: m.chatId, sender: m.sender, snippet: (m.body ?? '').slice(0, 200), sent_at: m.sentAt?.toISOString() ?? null }])),
  };
}

/** POST /api/messages/:id/concept-map — start building (or rebuilding, with {rebuild: true}); returns the current state. */
export async function startStudyMap(db: Db, ctx: AuthCtx, messageId: string, body: unknown) {
  const m = await requireMessage(db, ctx, messageId);
  const { root } = await placementOf(db, m.chatId, messageId);
  if (!root) throw new SafeError('This message is not on the map yet; concept maps need its topic.', 409, 'not_analysed');
  if (!STUDY_ROOTS.includes(root)) throw new SafeError('Concept maps are for messages under Knowledge or Resources.', 409, 'not_study_material');
  const rebuild = (body as { rebuild?: unknown } | null)?.rebuild === true;
  const row = await latest(db, ctx.workspaceId, messageId);
  if (row && IN_PROGRESS.includes(row.status)) return getStudyMap(db, ctx, messageId);
  if (row?.status === 'done' && !rebuild) return getStudyMap(db, ctx, messageId);
  const [created] = await db.insert(s.studyMaps).values({ workspaceId: ctx.workspaceId, chatId: m.chatId, messageId }).returning({ id: s.studyMaps.id });
  // The worker builds it; if it is restarting, it picks waiting maps up on its own.
  await db.execute(sql`SELECT pg_notify(${ASK_CHANNEL}, ${JSON.stringify({ id: created.id, kind: 'study', studyMapId: created.id })})`);
  return getStudyMap(db, ctx, messageId);
}
