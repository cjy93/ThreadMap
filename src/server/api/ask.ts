// Ask: describe what you are looking for in plain words. Nemotron Nano turns the
// request into search terms (synonyms, related words, other languages) and the
// map topics that fit; messages are ranked by how well they match. Matches also
// cover what the vision model saw in images. Only the worker holds the model key,
// so the web process asks it over PostgreSQL notifications; if no answer arrives
// in time, plain word search still answers.
import crypto from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as s from '../../db/schema';
import { loadViewConfig, type LlmConfig } from '../../lib/config';
import { answerPrompt, askPrompt } from '../ai/prompts';
import type { ModelProvider } from '../ai/provider';
import { callModel, ensureLedger, estimateTokens } from '../ai/router';
import { AnswerSchema, AskSchema, JSON_SCHEMAS } from '../ai/schemas';
import type { Db } from '../db';
import { filterFingerprint, matchingMessagesSql, parseContentFilter } from '../graph/filters';
import { ancestors, loadTree, pathOf, type Tree } from '../graph/tree';
import { ASK_CHANNEL } from '../notify';
import { normalizeSearch, SafeError } from '../util';
import { requireChat, type AuthCtx } from './service';

const MAX_TOPICS_SHOWN_TO_MODEL = 300;
const ASK_TIMEOUT_MS = 10_000;
// Answering reads far more than interpreting: the matches plus the chats' discussion summaries.
const ANSWER_TIMEOUT_MS = 120_000;
const ANSWER_MAX_MESSAGES = 60;
// The answer call may be this many times the usual per-call input limit.
const ANSWER_INPUT_MULTIPLE = 3;
// PostgreSQL notifications carry at most 8000 bytes; the reply stays well under.
const ANSWER_REPLY_BYTES = 7000;

export interface Interpretation {
  interpretation: string;
  terms: string[];
  topicIds: string[];
}
export type Interpreter = (workspaceId: string, chatIds: string[], question: string) => Promise<Interpretation | null>;

/**
 * Topics offered to the model, broad levels first, within a fixed share of the
 * prompt: a long chat's full topic list would make the request too large and
 * Ask would fall back to plain word search.
 */
function topicListOf(trees: Map<string, Tree>, cfg: LlmConfig) {
  const all: { id: string; path: string; depth: number }[] = [];
  for (const tree of trees.values()) {
    for (const n of tree.nodes.values()) {
      if (n.kind !== 'TOPIC') continue;
      const chain = ancestors(tree, n.id);
      all.push({ id: n.id, path: chain.map((a) => a.title).join(' > '), depth: chain.length });
    }
  }
  all.sort((a, b) => a.depth - b.depth);
  const budget = cfg.LLM_MAX_INPUT_TOKENS_PER_CALL * 0.5;
  const out: { key: string; id: string; path: string }[] = [];
  let used = 0;
  for (const t of all) {
    const item = { key: `t${out.length + 1}`, id: t.id, path: t.path };
    used += estimateTokens(JSON.stringify({ id: item.key, path: item.path, locked: false }));
    if (used > budget || out.length >= MAX_TOPICS_SHOWN_TO_MODEL) break;
    out.push(item);
  }
  return out;
}

/** Runs where the model key lives (the worker): question → terms and fitting topic ids. */
export async function interpretRequest(deps: { db: Db; provider: ModelProvider; cfg: LlmConfig }, workspaceId: string, chatIds: string[], question: string): Promise<Interpretation> {
  const trees = new Map(await Promise.all(chatIds.map(async (c) => [c, await loadTree(deps.db, c)] as const)));
  // Topics are offered under short keys (t1…), as in every model call.
  const topics = topicListOf(trees, deps.cfg);
  const logicalJobId = crypto.randomUUID();
  await ensureLedger(deps.db, workspaceId, logicalJobId, deps.cfg);
  const p = askPrompt(question, topics.map((t) => ({ id: t.key, path: t.path, locked: false })));
  const r = await callModel(deps, { workspaceId, logicalJobId }, { role: 'fast', operation: 'ask', ...p, schema: AskSchema, schemaName: 'ask', jsonSchema: JSON_SCHEMAS.ask, maxOutputTokens: 800, thinking: false });
  const byKey = new Map(topics.map((t) => [t.key, t.id]));
  return {
    interpretation: r.value.interpretation,
    terms: r.value.terms.map(normalizeSearch).filter((t) => t.length > 1),
    topicIds: r.value.topic_keys.flatMap((k) => (byKey.has(k) ? [byKey.get(k)!] : [])),
  };
}

/** Default interpreter for the web process: ask the worker and wait briefly for its answer. */
export const viaWorker =
  (db: Db): Interpreter =>
  async (workspaceId, chatIds, question) => {
    const { prepareAskReply } = await import('../events-hub');
    const id = crypto.randomUUID();
    const { reply } = await prepareAskReply(id, ASK_TIMEOUT_MS);
    await db.execute(sql`SELECT pg_notify(${ASK_CHANNEL}, ${JSON.stringify({ id, workspaceId, chatIds, question })})`);
    return (await reply) as Interpretation | null;
  };

const descendants = (tree: Tree, id: string): string[] => {
  const n = tree.nodes.get(id);
  return n ? [id, ...n.childIds.flatMap((c) => descendants(tree, c))] : [];
};

export async function ask(db: Db, ctx: AuthCtx, params: URLSearchParams, interpret: Interpreter = viaWorker(db)) {
  const question = (params.get('q') ?? '').trim();
  if (question.length < 1 || question.length > 300) throw new SafeError('ask in 1–300 characters');
  const chatParam = params.get('chat');
  const chats = chatParam ? [await requireChat(db, ctx, chatParam)] : await db.select().from(s.chats).where(and(eq(s.chats.workspaceId, ctx.workspaceId), eq(s.chats.excluded, false), eq(s.chats.selected, true)));
  const chatIds = chats.map((c) => c.id);
  const filter = parseContentFilter(params, { tz: loadViewConfig().defaultTimezone });
  const trees = new Map(await Promise.all(chatIds.map(async (c) => [c, await loadTree(db, c)] as const)));

  let terms = normalizeSearch(question).split(/\s+/).filter((w) => w.length > 1);
  let interpretation: string | null = null;
  let chosen: string[] = [];
  if (chatIds.length) {
    const r = await interpret(ctx.workspaceId, chatIds, question).catch(() => null);
    if (r) {
      interpretation = r.interpretation;
      // Nemotron's terms replace the raw words, so filler ("show me ... to") stops matching.
      if (r.terms.length) terms = [...new Set(r.terms)].slice(0, 24);
      chosen = r.topicIds.filter((id) => [...trees.values()].some((t) => t.nodes.has(id)));
    }
  }
  const topicIds = chosen.flatMap((id) => [...trees.values()].flatMap((t) => descendants(t, id)));
  if (!chatIds.length || (!terms.length && !topicIds.length)) return { query: question, interpretation, terms, results: [], topics: [] };

  const matching = matchingMessagesSql({ userId: ctx.userId, workspaceId: ctx.workspaceId, chatIds }, filter);
  const patterns = terms.map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const termValues = patterns.length ? sql.join(patterns.map((p) => sql`(${p})`), sql`, `) : sql`(NULL::text)`;
  const topicArray = topicIds.length ? sql`ARRAY[${sql.join(topicIds.map((id) => sql`${id}::uuid`), sql`, `)}]` : sql`ARRAY[]::uuid[]`;
  const rows = await db.execute<{ id: string; chat_id: string; sender_label: string; body: string | null; sent_at: Date | null; is_read: boolean; content_revision: number; score: number }>(sql`
    WITH mt AS (${matching}), terms(p) AS (VALUES ${termValues}),
    scored AS (
      SELECT m.id,
        (SELECT count(*) FROM terms WHERE terms.p IS NOT NULL AND (m.search_text LIKE terms.p
          OR EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND lower(a.ai_description) LIKE terms.p)))::int
        + CASE WHEN EXISTS (SELECT 1 FROM placements pl WHERE pl.message_id = m.id AND pl.topic_id = ANY(${topicArray})) THEN 2 ELSE 0 END AS score
      FROM messages m JOIN mt ON mt.id = m.id)
    SELECT m.id, m.chat_id, m.sender_label, m.body, m.sent_at, mt.is_read, m.content_revision, scored.score
    FROM scored JOIN messages m ON m.id = scored.id JOIN mt ON mt.id = m.id
    WHERE scored.score > 0
    ORDER BY scored.score DESC, m.sent_at DESC NULLS LAST, m.id DESC LIMIT 100`);

  const placementRows = rows.rows.length
    ? await db.select({ messageId: s.placements.messageId, topicId: s.placements.topicId }).from(s.placements).where(inArray(s.placements.messageId, rows.rows.map((r) => r.id)))
    : [];
  return {
    query: question,
    interpretation,
    terms,
    filter_fingerprint: filterFingerprint({ userId: ctx.userId, workspaceId: ctx.workspaceId, chatIds }, filter),
    results: rows.rows.map((r) => {
      const body = r.body ?? '';
      const norm = normalizeSearch(body);
      const hit = terms.map((t) => norm.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
      const start = Math.max(0, hit - 60);
      return {
        message_id: r.id,
        chat_id: r.chat_id,
        sender: r.sender_label,
        snippet: body.slice(start, start + 200),
        sent_at: r.sent_at ? new Date(r.sent_at).toISOString() : null,
        review: r.is_read ? 'read' : 'missed',
        content_revision: r.content_revision,
        score: r.score,
        topic_paths: placementRows.filter((p) => p.messageId === r.id && trees.get(r.chat_id)?.nodes.has(p.topicId)).map((p) => pathOf(trees.get(r.chat_id)!, p.topicId)),
        route: `/chats/${r.chat_id}/messages/${r.id}`,
      };
    }),
    // The topics the model judged relevant.
    topics: [...trees.entries()].flatMap(([chatId, tree]) => chosen.filter((id) => tree.nodes.has(id)).map((id) => ({ chat_id: chatId, topic_id: id, path: pathOf(tree, id) }))),
  };
}

export interface AnswerReply {
  answer: string;
  enough: boolean;
  points: { text: string; message_ids: string[] }[];
}

/**
 * Ask, second step (runs in the worker): Nemotron Super answers the question
 * from the messages Ask matched, best first, plus the chats' discussion
 * summaries (titles, topic words and first finding), which reach items no
 * search word matched. Every point cites messages; a discussion cited stands
 * for its first message.
 */
export async function answerQuestion(
  deps: { db: Db; provider: ModelProvider; cfg: LlmConfig },
  workspaceId: string,
  chatIds: string[],
  question: string,
  messageIds: string[],
): Promise<AnswerReply> {
  const { db } = deps;
  const chats = chatIds.length
    ? await db.select({ id: s.chats.id, title: s.chats.title }).from(s.chats).where(and(eq(s.chats.workspaceId, workspaceId), inArray(s.chats.id, chatIds), eq(s.chats.excluded, false)))
    : [];
  if (!chats.length) return { answer: '', enough: false, points: [] };
  const ids = chats.map((c) => c.id);
  const titleOf = new Map(chats.map((c) => [c.id, c.title]));
  const wanted = messageIds.slice(0, ANSWER_MAX_MESSAGES);
  const rows = wanted.length
    ? await db
        .select({ id: s.messages.id, chatId: s.messages.chatId, sender: s.messages.senderLabel, body: s.messages.body, sentAt: s.messages.sentAt })
        .from(s.messages)
        .where(and(inArray(s.messages.id, wanted), inArray(s.messages.chatId, ids), eq(s.messages.state, 'active')))
    : [];
  const rank = new Map(wanted.map((id, i) => [id, i]));
  rows.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  // What the vision model saw counts as message text.
  const seen = rows.length ? await db.select({ messageId: s.attachments.messageId, desc: s.attachments.aiDescription }).from(s.attachments).where(inArray(s.attachments.messageId, rows.map((r) => r.id))) : [];
  const descOf = new Map(seen.filter((a) => a.desc).map((a) => [a.messageId, a.desc!]));
  const units = await db.select({ chatId: s.analysisUnits.chatId, meta: s.analysisUnits.summaryBullets, terms: s.analysisUnits.topicTerms, refs: s.analysisUnits.messageRefs }).from(s.analysisUnits).where(inArray(s.analysisUnits.chatId, ids));

  const limit = deps.cfg.LLM_MAX_INPUT_TOKENS_PER_CALL * ANSWER_INPUT_MULTIPLE;
  let used = estimateTokens(question) + 600; // instructions
  const fits = (x: unknown) => {
    const t = estimateTokens(JSON.stringify(x));
    if (used + t > limit) return false;
    used += t;
    return true;
  };
  const refToMessage = new Map<string, string>();
  const messages: Parameters<typeof answerPrompt>[1] = [];
  for (const r of rows) {
    const text = [r.body ?? '', descOf.get(r.id) ? `[image: ${descOf.get(r.id)}]` : ''].filter(Boolean).join(' ').slice(0, 400);
    const m = { ref: `m${messages.length + 1}`, chat: titleOf.get(r.chatId)!, sender: r.sender, time: r.sentAt ? r.sentAt.toISOString().slice(0, 16) : null, text };
    if (!fits(m)) break;
    messages.push(m);
    refToMessage.set(m.ref, r.id);
  }
  const discussions: Parameters<typeof answerPrompt>[2] = [];
  for (const u of units) {
    const meta = u.meta as { title?: string; bullets?: { text: string }[] };
    const first = u.refs[0]?.m;
    if (!first) continue;
    const d = { ref: `d${discussions.length + 1}`, chat: titleOf.get(u.chatId)!, title: meta.title ?? '', terms: u.terms.slice(0, 6), summary: (meta.bullets?.[0]?.text ?? '').slice(0, 160) };
    if (!fits(d)) break;
    discussions.push(d);
    refToMessage.set(d.ref, first);
  }

  const logicalJobId = crypto.randomUUID();
  const cfg = { ...deps.cfg, LLM_MAX_INPUT_TOKENS_PER_CALL: limit };
  await ensureLedger(db, workspaceId, logicalJobId, cfg);
  const p = answerPrompt(question, messages, discussions);
  const r = await callModel({ ...deps, cfg }, { workspaceId, logicalJobId }, { role: 'balanced', operation: 'answer', ...p, schema: AnswerSchema, schemaName: 'answer', jsonSchema: JSON_SCHEMAS.answer, maxOutputTokens: 1500 });
  const out: AnswerReply = {
    answer: r.value.answer.slice(0, 1200),
    enough: r.value.enough,
    points: r.value.points.slice(0, 12).map((pt) => ({
      text: pt.text.slice(0, 240),
      message_ids: [...new Set(pt.refs.flatMap((ref) => (refToMessage.has(ref) ? [refToMessage.get(ref)!] : [])))].slice(0, 3),
    })),
  };
  // Keep the reply inside one notification.
  while (out.points.length && Buffer.byteLength(JSON.stringify(out)) > ANSWER_REPLY_BYTES) out.points.pop();
  return out;
}

type AnswerRunner = (chatIds: string[], question: string, messageIds: string[]) => Promise<AnswerReply | null>;

/** Web side: ask the worker for the answer, then attach each cited message's sender and snippet. */
export async function answer(db: Db, ctx: AuthCtx, body: unknown, run: AnswerRunner = answerViaWorker(db, ctx.workspaceId)) {
  const b = (body ?? {}) as { q?: unknown; chat?: unknown; message_ids?: unknown };
  const question = typeof b.q === 'string' ? b.q.trim() : '';
  if (question.length < 1 || question.length > 300) throw new SafeError('ask in 1–300 characters');
  const messageIds = Array.isArray(b.message_ids) ? b.message_ids.filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)).slice(0, ANSWER_MAX_MESSAGES) : [];
  const chats = typeof b.chat === 'string' ? [await requireChat(db, ctx, b.chat)] : await db.select().from(s.chats).where(and(eq(s.chats.workspaceId, ctx.workspaceId), eq(s.chats.excluded, false), eq(s.chats.selected, true)));
  if (!chats.length) return { answer: null, note: 'Open a chat first.' };
  const r = await run(chats.map((c) => c.id), question, messageIds);
  if (!r) return { answer: null, note: 'Nemotron did not answer in time; the matching messages are listed below.' };
  return { answer: await withSources(db, ctx.workspaceId, r) };
}

/** Each cited message as a clickable source: sender, chat and a short snippet. */
export async function withSources(db: Db, workspaceId: string, r: AnswerReply) {
  const ids = [...new Set(r.points.flatMap((p) => p.message_ids))];
  const rows = ids.length
    ? await db
        .select({ id: s.messages.id, chatId: s.messages.chatId, sender: s.messages.senderLabel, body: s.messages.body })
        .from(s.messages)
        .where(and(inArray(s.messages.id, ids), eq(s.messages.workspaceId, workspaceId)))
    : [];
  const byId = new Map(rows.map((m) => [m.id, m]));
  return {
    text: r.answer,
    enough: r.enough,
    points: r.points.map((p) => ({
      text: p.text,
      sources: p.message_ids.flatMap((id) => {
        const m = byId.get(id);
        return m ? [{ message_id: id, chat_id: m.chatId, sender: m.sender, snippet: (m.body ?? '').slice(0, 140) }] : [];
      }),
    })),
  };
}

const answerViaWorker =
  (db: Db, workspaceId: string): AnswerRunner =>
  async (chatIds, question, messageIds) => {
    const { prepareAskReply } = await import('../events-hub');
    const id = crypto.randomUUID();
    const { reply } = await prepareAskReply(id, ANSWER_TIMEOUT_MS);
    await db.execute(sql`SELECT pg_notify(${ASK_CHANNEL}, ${JSON.stringify({ id, kind: 'answer', workspaceId, chatIds, question, messageIds })})`);
    const r = (await reply) as (AnswerReply & { ok?: boolean }) | null;
    return r && r.ok !== false ? r : null;
  };
