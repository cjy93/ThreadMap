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
import { aliasPrompt, answerMergePrompt, answerPrompt, askPrompt, type AnswerDiscussion } from '../ai/prompts';
import type { ModelProvider } from '../ai/provider';
import { callModel, ensureLedger, estimateTokens } from '../ai/router';
import { AliasSchema, AnswerSchema, AskSchema, JSON_SCHEMAS } from '../ai/schemas';
import type { Db } from '../db';
import { filterFingerprint, matchingMessagesSql, parseContentFilter } from '../graph/filters';
import { ancestors, loadTree, pathOf, type Tree } from '../graph/tree';
import { ASK_CHANNEL } from '../notify';
import { normalizeSearch, SafeError } from '../util';
import { requireChat, type AuthCtx } from './service';

const MAX_TOPICS_SHOWN_TO_MODEL = 300;
// Two quick Nano calls: the request's terms, then other names found in the first matches.
const ASK_TIMEOUT_MS = 20_000;
// Fuzzy matching ("davincci" finds "Davinci"): trigram word similarity at least this, for terms this long.
const FUZZY_MIN_SIMILARITY = 0.6;
const FUZZY_MIN_TERM_LENGTH = 5;
// Messages Nano reads to find other names for what is asked about.
const ALIAS_SAMPLE_MESSAGES = 30;
// Answering reads far more than interpreting: the matches plus every discussion summary,
// in parts for a long chat, then a merge.
const ANSWER_TIMEOUT_MS = 180_000;
// Parts of a long chat read at once, and at most this many parts.
const ANSWER_PARTS_AT_ONCE = 3;
const ANSWER_MAX_PARTS = 9;
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
/** Still working (collect it later by this id), or could not answer (why). */
export type NotYet = { pending: string } | { failed: string };
export type Interpreter = (workspaceId: string, chatIds: string[], question: string) => Promise<Interpretation | NotYet | null>;

/** Why Nemotron could not answer, in words for the page. */
export function modelProblem(reason: string): string {
  if (reason === 'budget_user') return 'Your NVIDIA Nemotron allowance for this account is used up, so Nemotron cannot answer.';
  if (reason === 'budget_day') return "Today's NVIDIA Nemotron budget is used up; it resets tomorrow.";
  if (reason === 'budget_job') return 'This request reached its limit of model calls.';
  return 'NVIDIA Nemotron could not answer (the model service returned an error).';
}

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

/**
 * Whether a message matches one search term: the term as written, or a close
 * spelling of it (a typo, a missing or doubled letter), in the text or in what
 * the vision model saw in its images. `t` is the term, `p` its LIKE pattern.
 */
const termMatchSql = (t: ReturnType<typeof sql>, p: ReturnType<typeof sql>) => sql`(m.search_text LIKE ${p}
  OR (length(${t}) >= ${FUZZY_MIN_TERM_LENGTH} AND word_similarity(${t}, m.search_text) >= ${FUZZY_MIN_SIMILARITY})
  OR EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND lower(a.ai_description) LIKE ${p}))`;
const likePattern = (t: string) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Other names for what is asked about: Nano reads the messages that mention it
 * and lists the renames, codenames and spellings they use ("davinci = Elucidex").
 * Read from the chat itself, so a name only this chat uses is found too.
 */
async function aliasesFrom(deps: { db: Db; provider: ModelProvider; cfg: LlmConfig }, scope: { workspaceId: string; logicalJobId: string }, chatIds: string[], question: string, terms: string[]): Promise<string[]> {
  if (!terms.length || !chatIds.length) return [];
  const values = sql.join(terms.map((t) => sql`(${t}, ${likePattern(t)})`), sql`, `);
  const rows = await deps.db.execute<{ body: string }>(sql`
    WITH terms(t, p) AS (VALUES ${values})
    SELECT m.body FROM messages m
    WHERE m.chat_id IN (${sql.join(chatIds.map((c) => sql`${c}::uuid`), sql`, `)}) AND m.state = 'active' AND m.body IS NOT NULL
      AND EXISTS (SELECT 1 FROM terms WHERE ${termMatchSql(sql`terms.t`, sql`terms.p`)})
    ORDER BY m.sent_at DESC NULLS LAST LIMIT ${ALIAS_SAMPLE_MESSAGES}`);
  if (!rows.rows.length) return [];
  const r = await callModel(deps, scope, {
    role: 'fast',
    operation: 'ask_alias',
    ...aliasPrompt(question, rows.rows.map((x) => x.body.slice(0, 300))),
    schema: AliasSchema,
    schemaName: 'alias',
    jsonSchema: JSON_SCHEMAS.alias,
    maxOutputTokens: 300,
    thinking: false,
  });
  return r.value.aliases.map(normalizeSearch).filter((t) => t.length > 1);
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
  const terms = r.value.terms.map(normalizeSearch).filter((t) => t.length > 1);
  // Then the chat's own other names for it; without them the terms still search.
  const aliases = await aliasesFrom(deps, { workspaceId, logicalJobId }, chatIds, question, terms).catch(() => []);
  return {
    interpretation: r.value.interpretation,
    terms: [...new Set([...terms, ...aliases])],
    topicIds: r.value.topic_keys.flatMap((k) => (byKey.has(k) ? [byKey.get(k)!] : [])),
  };
}

/** Default interpreter for the web process: ask the worker and wait briefly for its answer. */
export const viaWorker =
  (db: Db): Interpreter =>
  async (workspaceId, chatIds, question) => {
    const { prepareAskReply } = await import('../events-hub');
    const id = crypto.randomUUID();
    const { reply } = await prepareAskReply(id, ASK_TIMEOUT_MS, { ws: workspaceId, kind: 'ask' });
    await db.execute(sql`SELECT pg_notify(${ASK_CHANNEL}, ${JSON.stringify({ id, workspaceId, chatIds, question })})`);
    const r = await reply;
    if (!r) return { pending: id };
    return r.ok ? (r as unknown as Interpretation) : { failed: r.reason };
  };

/** Nemotron's reading of a question that arrived after the search had gone ahead without it. */
async function lateInterpretation(workspaceId: string, id: string): Promise<Interpretation | null> {
  const { lateAskReply } = await import('../events-hub');
  const r = lateAskReply(id, workspaceId);
  return r?.state === 'done' && r.kind === 'ask' ? (r.reply as unknown as Interpretation) : null;
}

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
  // Nemotron may add a name's variants and the chat's other names for it (up to 8 of those).
  const MAX_TERMS = 32;
  let interpretation: string | null = null;
  let chosen: string[] = [];
  // Without Nemotron's reading the search goes ahead on the plain words; the page is told why,
  // and when Nemotron is merely slow it searches again with its reading once that arrives.
  let note: string | null = null;
  let pending: string | null = null;
  if (chatIds.length) {
    const lateId = params.get('interp');
    const got = lateId ? await lateInterpretation(ctx.workspaceId, lateId) : await interpret(ctx.workspaceId, chatIds, question).catch(() => null);
    let r: Interpretation | null = null;
    if (got && 'pending' in got) {
      pending = got.pending;
      note = 'NVIDIA Nemotron is still reading your question; showing plain word matches until it does.';
    } else if (got && 'failed' in got) note = `${modelProblem(got.failed)} Showing plain word matches.`;
    else if (!got) note = 'NVIDIA Nemotron was not available; showing plain word matches.';
    else r = got;
    if (r) {
      interpretation = r.interpretation;
      // Nemotron's terms replace the raw words, so filler ("show me ... to") stops matching.
      if (r.terms.length) terms = [...new Set(r.terms)].slice(0, MAX_TERMS);
      chosen = r.topicIds.filter((id) => [...trees.values()].some((t) => t.nodes.has(id)));
    }
  }
  const topicIds = chosen.flatMap((id) => [...trees.values()].flatMap((t) => descendants(t, id)));
  if (!chatIds.length || (!terms.length && !topicIds.length)) return { query: question, interpretation, note, interpretation_pending: pending, terms, results: [], topics: [] };

  const matching = matchingMessagesSql({ userId: ctx.userId, workspaceId: ctx.workspaceId, chatIds }, filter);
  const termValues = terms.length ? sql.join(terms.map((t) => sql`(${t}, ${likePattern(t)})`), sql`, `) : sql`(NULL::text, NULL::text)`;
  const topicArray = topicIds.length ? sql`ARRAY[${sql.join(topicIds.map((id) => sql`${id}::uuid`), sql`, `)}]` : sql`ARRAY[]::uuid[]`;
  const rows = await db.execute<{ id: string; chat_id: string; sender_label: string; body: string | null; sent_at: Date | null; is_read: boolean; content_revision: number; score: number }>(sql`
    WITH mt AS (${matching}), terms(t, p) AS (VALUES ${termValues}),
    scored AS (
      SELECT m.id,
        (SELECT count(*) FROM terms WHERE terms.p IS NOT NULL AND ${termMatchSql(sql`terms.t`, sql`terms.p`)})::int
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
    note,
    interpretation_pending: pending,
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
  /** How much Nemotron read: matching messages and discussion summaries. */
  read?: { messages: number; discussions: number };
}

/**
 * Ask, second step (runs in the worker): Nemotron Super answers the question
 * from the messages Ask matched and from every discussion summary in the chats.
 * Each summary point keeps the messages it was drawn from, so an answer cites
 * the original messages. A long chat's summaries are read in parts (a few at a
 * time) and the findings merged into one answer, so nothing is left unread.
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
  if (!chats.length) return { answer: '', enough: false, points: [], read: { messages: 0, discussions: 0 } };
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
  const units = await db
    .select({ chatId: s.analysisUnits.chatId, meta: s.analysisUnits.summaryBullets, terms: s.analysisUnits.topicTerms, refs: s.analysisUnits.messageRefs })
    .from(s.analysisUnits)
    .where(inArray(s.analysisUnits.chatId, ids))
    .orderBy(s.analysisUnits.createdAt, s.analysisUnits.id);

  const limit = deps.cfg.LLM_MAX_INPUT_TOKENS_PER_CALL * ANSWER_INPUT_MULTIPLE;
  const base = estimateTokens(question) + 900; // instructions
  const cost = (x: unknown) => estimateTokens(JSON.stringify(x));
  // Every ref the model may cite, mapped to the original messages it stands for.
  const refToMessages = new Map<string, string[]>();
  const messages: Parameters<typeof answerPrompt>[1] = [];
  let used = base;
  for (const r of rows) {
    const text = [r.body ?? '', descOf.get(r.id) ? `[image: ${descOf.get(r.id)}]` : ''].filter(Boolean).join(' ').slice(0, 400);
    const m = { ref: `m${messages.length + 1}`, chat: titleOf.get(r.chatId)!, sender: r.sender, time: r.sentAt ? r.sentAt.toISOString().slice(0, 16) : null, text };
    // The matches take at most half of the first part; the summaries need the rest.
    if (used + cost(m) > base + limit / 2) break;
    used += cost(m);
    messages.push(m);
    refToMessages.set(m.ref, [r.id]);
  }
  // Discussion summaries, split into parts that each fit one call.
  const parts: AnswerDiscussion[][] = [[]];
  let pointSeq = 0;
  let read = 0;
  for (const u of units) {
    const meta = u.meta as { title?: string; bullets?: { text: string; evidence?: { m: string }[] }[] };
    const first = u.refs[0]?.m;
    if (!first) continue;
    const points = (meta.bullets ?? []).slice(0, 4).map((b) => {
      const ref = `p${++pointSeq}`;
      const from = (b.evidence ?? []).map((e) => e.m).slice(0, 3);
      refToMessages.set(ref, from.length ? from : [first]);
      return { ref, text: b.text.slice(0, 200) };
    });
    if (!points.length) {
      // No summary points: the discussion's title stands for it, citing its first message.
      const ref = `p${++pointSeq}`;
      refToMessages.set(ref, [first]);
      points.push({ ref, text: meta.title ?? '' });
    }
    const d: AnswerDiscussion = { chat: titleOf.get(u.chatId)!, title: meta.title ?? '', terms: u.terms.slice(0, 6), points };
    if (used + cost(d) > limit && parts[parts.length - 1].length) {
      if (parts.length >= ANSWER_MAX_PARTS) break;
      parts.push([]);
      used = base;
    }
    parts[parts.length - 1].push(d);
    used += cost(d);
    read++;
  }

  const logicalJobId = crypto.randomUUID();
  const cfg = { ...deps.cfg, LLM_MAX_INPUT_TOKENS_PER_CALL: limit };
  await ensureLedger(db, workspaceId, logicalJobId, cfg);
  const ask = (p: { system: string; user: string }, operation: string) =>
    callModel({ ...deps, cfg }, { workspaceId, logicalJobId }, { role: 'balanced', operation, ...p, schema: AnswerSchema, schemaName: 'answer', jsonSchema: JSON_SCHEMAS.answer, maxOutputTokens: 2000 }).then((r) => r.value);
  const cite = (refs: string[], from: Map<string, string[]>) => [...new Set(refs.flatMap((ref) => from.get(ref) ?? []))].slice(0, 3);

  // Each part on its own, a few at a time.
  const answers: Awaited<ReturnType<typeof ask>>[] = [];
  for (let i = 0; i < parts.length; i += ANSWER_PARTS_AT_ONCE) {
    const batch = parts.slice(i, i + ANSWER_PARTS_AT_ONCE);
    answers.push(...(await Promise.all(batch.map((part, j) => ask(answerPrompt(question, i + j === 0 ? messages : [], part), 'answer')))));
  }
  const counts = { messages: messages.length, discussions: read };
  let out: AnswerReply;
  if (answers.length === 1) {
    const a = answers[0];
    out = { answer: a.answer, enough: a.enough, points: a.points.map((pt) => ({ text: pt.text, message_ids: cite(pt.refs, refToMessages) })), read: counts };
  } else {
    // A long chat: merge what each part found into one answer.
    const findings = answers.flatMap((a) => a.points).map((pt, i) => ({ ref: `f${i + 1}`, text: pt.text, ids: cite(pt.refs, refToMessages) }));
    if (!findings.length) {
      out = { answer: answers.find((a) => a.answer)?.answer ?? '', enough: false, points: [], read: counts };
    } else {
      const merged = await ask(answerMergePrompt(question, findings.map((f) => ({ ref: f.ref, text: f.text }))), 'answer:merge');
      const byFinding = new Map(findings.map((f) => [f.ref, f.ids]));
      out = { answer: merged.answer, enough: merged.enough, points: merged.points.map((pt) => ({ text: pt.text, message_ids: cite(pt.refs, byFinding) })), read: counts };
    }
  }
  out = { ...out, answer: out.answer.slice(0, 1200), points: out.points.slice(0, 16).map((p) => ({ ...p, text: p.text.slice(0, 240) })) };
  // Keep the reply inside one notification.
  while (out.points.length && Buffer.byteLength(JSON.stringify(out)) > ANSWER_REPLY_BYTES) out.points.pop();
  return out;
}

type AnswerRunner = (chatIds: string[], question: string, messageIds: string[]) => Promise<AnswerReply | NotYet | null>;

/** Web side: ask the worker for the answer, then attach each cited message's sender and snippet. */
export async function answer(db: Db, ctx: AuthCtx, body: unknown, run: AnswerRunner = answerViaWorker(db, ctx.workspaceId)) {
  const b = (body ?? {}) as { q?: unknown; chat?: unknown; message_ids?: unknown };
  const question = typeof b.q === 'string' ? b.q.trim() : '';
  if (question.length < 1 || question.length > 300) throw new SafeError('ask in 1–300 characters');
  const messageIds = Array.isArray(b.message_ids) ? b.message_ids.filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)).slice(0, ANSWER_MAX_MESSAGES) : [];
  const chats = typeof b.chat === 'string' ? [await requireChat(db, ctx, b.chat)] : await db.select().from(s.chats).where(and(eq(s.chats.workspaceId, ctx.workspaceId), eq(s.chats.excluded, false), eq(s.chats.selected, true)));
  if (!chats.length) return { answer: null, note: 'Open a chat first.' };
  const r = await run(chats.map((c) => c.id), question, messageIds);
  if (!r) return { answer: null, note: 'Nemotron did not answer; the matching messages are listed below.' };
  // Still working: the page collects the answer from /api/ask/late/:id when it is ready.
  if ('pending' in r) return { answer: null, pending: r.pending, note: 'NVIDIA Nemotron is still working on the answer; it appears here when ready.' };
  if ('failed' in r) return { answer: null, note: `${modelProblem(r.failed)} The matching messages are listed below.` };
  return { answer: await withSources(db, ctx.workspaceId, r) };
}

/** GET /api/ask/late/:id — a slow Nemotron reply, once it has arrived. */
export async function lateReply(db: Db, ctx: AuthCtx, id: string) {
  const { lateAskReply } = await import('../events-hub');
  const r = lateAskReply(id, ctx.workspaceId);
  if (!r) return { state: 'unknown' as const, note: 'This answer is no longer available; ask again.' };
  if (r.state === 'pending') return { state: 'pending' as const };
  if (r.state === 'failed') return { state: 'failed' as const, note: modelProblem(r.reason ?? 'error') };
  if (r.kind === 'answer') return { state: 'done' as const, answer: await withSources(db, ctx.workspaceId, r.reply as unknown as AnswerReply) };
  return { state: 'done' as const };
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
    read: r.read ?? null,
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
    const { reply } = await prepareAskReply(id, ANSWER_TIMEOUT_MS, { ws: workspaceId, kind: 'answer' });
    await db.execute(sql`SELECT pg_notify(${ASK_CHANNEL}, ${JSON.stringify({ id, kind: 'answer', workspaceId, chatIds, question, messageIds })})`);
    const r = await reply;
    if (!r) return { pending: id };
    return r.ok ? (r as unknown as AnswerReply) : { failed: r.reason };
  };
