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
export type Interpreter = (workspaceId: string, chatIds: string[], question: string, found?: string[]) => Promise<Interpretation | NotYet | null>;

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

// A word the owner typed outweighs the variants Nemotron adds: asked "Clip", the messages
// saying "LiceClip" must not be pushed out by ones matching many added hackathon terms.
const TYPED_TERM_WEIGHT = 5;
// Results per page; the page asks for the next one (same terms, no new model call) as you scroll.
export const ASK_PAGE_SIZE = 100;

/** The pieces of the question searched inside words ("clip" in "LiceClip"): typed words of 3+ letters. */
export const fragmentsOf = (question: string) => {
  const words = normalizeSearch(question).split(/\s+/).filter(Boolean);
  // A keyword search (up to 3 words); in a sentence ("show me ... about refresh") most words are filler.
  return words.length > 3 ? [] : [...new Set(words.filter((w) => w.length >= 3))];
};

export interface WordHits {
  fragment: string;
  /** Words in the searched messages that contain the fragment, rarest first. */
  words: { word: string; messages: number }[];
}

/**
 * Before any model call: every distinct word in the searched messages that contains what was
 * typed ("clip" -> "liceclip", "clips"), with how many messages use it, rarest first. Someone
 * who half-remembers a name types part of it; these are the names it could be.
 */
export async function wordsContaining(db: Db, matching: ReturnType<typeof sql>, fragments: string[]): Promise<WordHits[]> {
  const out: WordHits[] = [];
  for (const f of fragments) {
    const pattern = `[[:alnum:]_]*${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[[:alnum:]_]*`;
    const rows = await db.execute<{ word: string; n: number }>(sql`
      WITH mt AS (${matching})
      SELECT r.arr[1] AS word, count(DISTINCT m.id)::int AS n
      FROM messages m JOIN mt ON mt.id = m.id CROSS JOIN LATERAL regexp_matches(m.search_text, ${pattern}, 'g') AS r(arr)
      WHERE m.search_text LIKE ${likePattern(f)} AND length(r.arr[1]) <= 40
      GROUP BY 1 ORDER BY 2, 1 LIMIT 12`);
    out.push({ fragment: f, words: rows.rows.map((r) => ({ word: r.word, messages: r.n })) });
  }
  return out;
}

export interface ContextLine {
  sender: string;
  text: string;
  /** How it relates to the matched message. */
  rel: 'replying to' | 'before' | 'reply' | 'after';
}

/**
 * What surrounds each message, so a bare "LiceClip" says what it was about: the message
 * it replies to (or else the one just before) and the first reply to it (or else the one
 * just after). Small talk is skipped as a neighbour; an empty side is left out.
 */
export async function messageContext(db: Db, ids: string[]): Promise<Map<string, { before?: ContextLine; after?: ContextLine }>> {
  const out = new Map<string, { before?: ContextLine; after?: ContextLine }>();
  if (!ids.length) return out;
  const usable = sql`p.chat_id = m.chat_id AND p.id <> m.id AND p.state = 'active' AND coalesce(p.body, '') <> ''`;
  const rows = await db.execute<{ id: string; b_sender: string | null; b_body: string | null; b_rel: string | null; a_sender: string | null; a_body: string | null; a_rel: string | null }>(sql`
    SELECT m.id, bf.sender_label AS b_sender, bf.body AS b_body, bf.rel AS b_rel, af.sender_label AS a_sender, af.body AS a_body, af.rel AS a_rel
    FROM messages m
    LEFT JOIN LATERAL (
      SELECT x.sender_label, x.body, x.rel FROM (
        (SELECT p.sender_label, p.body, 'replying to' AS rel, 0 AS o FROM messages p
          WHERE ${usable} AND (p.id = m.inferred_reply_to OR (m.reply_to_native_id IS NOT NULL AND p.native_id = m.reply_to_native_id)) LIMIT 1)
        UNION ALL
        (SELECT p.sender_label, p.body, 'before', 1 FROM messages p
          WHERE ${usable} AND p.filler IS NOT TRUE AND p.sent_at < m.sent_at ORDER BY p.sent_at DESC LIMIT 1)
      ) x ORDER BY x.o LIMIT 1) bf ON true
    LEFT JOIN LATERAL (
      SELECT x.sender_label, x.body, x.rel FROM (
        (SELECT p.sender_label, p.body, 'reply' AS rel, 0 AS o FROM messages p
          WHERE ${usable} AND (p.inferred_reply_to = m.id OR p.reply_to_native_id = m.native_id) ORDER BY p.sent_at LIMIT 1)
        UNION ALL
        (SELECT p.sender_label, p.body, 'after', 1 FROM messages p
          WHERE ${usable} AND p.filler IS NOT TRUE AND p.sent_at > m.sent_at ORDER BY p.sent_at LIMIT 1)
      ) x ORDER BY x.o LIMIT 1) af ON true
    WHERE m.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`);
  const line = (sender: string | null, body: string | null, rel: string | null): ContextLine | undefined =>
    sender !== null && body ? { sender, text: body.slice(0, 200), rel: rel as ContextLine['rel'] } : undefined;
  for (const r of rows.rows) out.set(r.id, { before: line(r.b_sender, r.b_body, r.b_rel), after: line(r.a_sender, r.a_body, r.a_rel) });
  return out;
}

/**
 * Other names for what is asked about: Nano reads the messages that mention it
 * and lists the renames, codenames and spellings they use ("davinci = Elucidex").
 * Read from the chat itself, so a name only this chat uses is found too.
 */
async function aliasesFrom(deps: { db: Db; provider: ModelProvider; cfg: LlmConfig }, scope: { workspaceId: string; logicalJobId: string }, chatIds: string[], question: string, terms: string[], known: string[] = terms): Promise<string[]> {
  if (!terms.length || !chatIds.length) return [];
  const values = sql.join(terms.map((t) => sql`(${t}, ${likePattern(t)})`), sql`, `);
  const rows = await deps.db.execute<{ id: string; body: string }>(sql`
    WITH terms(t, p) AS (VALUES ${values})
    SELECT m.id, m.body FROM messages m
    WHERE m.chat_id IN (${sql.join(chatIds.map((c) => sql`${c}::uuid`), sql`, `)}) AND m.state = 'active' AND m.body IS NOT NULL
      AND EXISTS (SELECT 1 FROM terms WHERE ${termMatchSql(sql`terms.t`, sql`terms.p`)})
    ORDER BY m.sent_at DESC NULLS LAST LIMIT ${ALIAS_SAMPLE_MESSAGES}`);
  if (!rows.rows.length) return [];
  // With the messages around each one: a name is often explained in the reply ("Conquercourse
  // become Dojo?" -> "Dojo is just slow area of the game"), which need not repeat the name.
  const around = await messageContext(deps.db, rows.rows.map((x) => x.id));
  const withContext = rows.rows.map((x) => {
    const c = around.get(x.id);
    const line = (l?: ContextLine) => (l ? ` | ${l.rel} · ${l.sender}: ${l.text.slice(0, 160)}` : '');
    return `${x.body.slice(0, 300)}${line(c?.before)}${line(c?.after)}`;
  });
  const r = await callModel(deps, scope, {
    role: 'fast',
    operation: 'ask_alias',
    ...aliasPrompt(question, withContext, known),
    schema: AliasSchema,
    schemaName: 'alias',
    jsonSchema: JSON_SCHEMAS.alias,
    maxOutputTokens: 300,
    thinking: false,
  });
  return [...new Set([...r.value.aliases, ...r.value.parts].map(normalizeSearch).filter((t) => t.length > 1))];
}

/** Runs where the model key lives (the worker): question → terms and fitting topic ids. */
export async function interpretRequest(deps: { db: Db; provider: ModelProvider; cfg: LlmConfig }, workspaceId: string, chatIds: string[], question: string, found: string[] = []): Promise<Interpretation> {
  const trees = new Map(await Promise.all(chatIds.map(async (c) => [c, await loadTree(deps.db, c)] as const)));
  // Topics are offered under short keys (t1…), as in every model call.
  const topics = topicListOf(trees, deps.cfg);
  const logicalJobId = crypto.randomUUID();
  await ensureLedger(deps.db, workspaceId, logicalJobId, deps.cfg);
  const p = askPrompt(question, topics.map((t) => ({ id: t.key, path: t.path, locked: false })), found);
  const r = await callModel(deps, { workspaceId, logicalJobId }, { role: 'fast', operation: 'ask', ...p, schema: AskSchema, schemaName: 'ask', jsonSchema: JSON_SCHEMAS.ask, maxOutputTokens: 800, thinking: false });
  const byKey = new Map(topics.map((t) => [t.key, t.id]));
  const terms = r.value.terms.map(normalizeSearch).filter((t) => t.length > 1);
  // Then the chat's own other names for it, and the names of its parts; without them the terms still search.
  const scope = { workspaceId, logicalJobId };
  const first = await aliasesFrom(deps, scope, chatIds, question, terms).catch(() => []);
  // One step further: a name found that way can have other names of its own, mentioned only
  // next to it ("ninja" -> "conquercourse"; "Conquercourse become Dojo?" -> "dojo").
  const fresh = first.filter((a) => !terms.includes(a));
  const second = fresh.length ? await aliasesFrom(deps, scope, chatIds, question, fresh, [...terms, ...fresh]).catch(() => []) : [];
  const aliases = [...new Set([...first, ...second])];
  return {
    interpretation: r.value.interpretation,
    // The main words first, then the chat's own names (specific, so kept), then the broader ones.
    terms: [...new Set([...terms.slice(0, 4), ...aliases, ...terms.slice(4)])],
    topicIds: r.value.topic_keys.flatMap((k) => (byKey.has(k) ? [byKey.get(k)!] : [])),
  };
}

/** Default interpreter for the web process: ask the worker and wait briefly for its answer. */
export const viaWorker =
  (db: Db): Interpreter =>
  async (workspaceId, chatIds, question, found = []) => {
    const { prepareAskReply } = await import('../events-hub');
    const id = crypto.randomUUID();
    const { reply } = await prepareAskReply(id, ASK_TIMEOUT_MS, { ws: workspaceId, kind: 'ask' });
    await db.execute(sql`SELECT pg_notify(${ASK_CHANNEL}, ${JSON.stringify({ id, workspaceId, chatIds, question, found })})`);
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
  const matching = matchingMessagesSql({ userId: ctx.userId, workspaceId: ctx.workspaceId, chatIds }, filter);
  // First, plain text: the words in these chats that contain what was typed (no model involved).
  const fragments = fragmentsOf(question);
  const wordHits = chatIds.length && params.get('terms_json') === null ? await wordsContaining(db, matching, fragments) : [];
  const foundWords = [...new Set(wordHits.flatMap((h) => h.words.map((w) => w.word)))];
  // A further page of the same search: the page sends back the terms and topics already used.
  const offset = Math.max(0, Math.min(1_000_000, Number(params.get('offset')) || 0));
  const given = params.get('terms_json');
  if (given !== null && chatIds.length) {
    const parsed = (() => {
      try {
        const v = JSON.parse(given) as unknown;
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
      } catch {
        return [];
      }
    })();
    terms = [...new Set(parsed.map(normalizeSearch).filter((t) => t.length > 1))].slice(0, 32);
    chosen = (params.get('topics') ?? '').split(',').filter((id) => [...trees.values()].some((t) => t.nodes.has(id)));
  } else if (chatIds.length) {
    const lateId = params.get('interp');
    const got = lateId ? await lateInterpretation(ctx.workspaceId, lateId) : await interpret(ctx.workspaceId, chatIds, question, foundWords).catch(() => null);
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
    // The words found inside the chats always search, whatever Nemotron made of the question.
    terms = [...new Set([...foundWords, ...terms])].slice(0, MAX_TERMS + 12);
  }
  const topicIds = chosen.flatMap((id) => [...trees.values()].flatMap((t) => descendants(t, id)));
  if (!chatIds.length || (!terms.length && !topicIds.length)) return { query: question, interpretation, note, interpretation_pending: pending, terms, word_hits: wordHits, results: [], topics: [], total: 0, next_offset: null };

  // Typed weight for a typed word and for any term containing one ("liceclip" for "clip").
  const typed = new Set(normalizeSearch(question).split(/\s+/));
  const isTyped = (t: string) => typed.has(t) || fragments.some((f) => t.includes(f));
  const termValues = terms.length ? sql.join(terms.map((t) => sql`(${t}, ${likePattern(t)}, ${isTyped(t) ? TYPED_TERM_WEIGHT : 1}::int)`), sql`, `) : sql`(NULL::text, NULL::text, 0)`;
  const topicArray = topicIds.length ? sql`ARRAY[${sql.join(topicIds.map((id) => sql`${id}::uuid`), sql`, `)}]` : sql`ARRAY[]::uuid[]`;
  // Rare terms count more: someone searching usually wants a name or a term, not a common word.
  // A term's weight is scaled from 1x (in every message searched) up to 2x (in just one), by how
  // many of the searched messages it matches; a typed word still outweighs Nemotron's additions.
  const rows = await db.execute<{ id: string; chat_id: string; sender_label: string; body: string | null; sent_at: Date | null; is_read: boolean; content_revision: number; score: number; total: number }>(sql`
    WITH mt AS (${matching}), terms(t, p, w) AS (VALUES ${termValues}),
    n AS (SELECT greatest(count(*), 2)::float AS n FROM mt),
    ts AS (
      SELECT terms.t, terms.p, terms.w,
        greatest((SELECT count(*) FROM messages m JOIN mt ON mt.id = m.id WHERE ${termMatchSql(sql`terms.t`, sql`terms.p`)}), 1)::float AS df
      FROM terms WHERE terms.p IS NOT NULL),
    scored AS (
      SELECT m.id,
        (SELECT coalesce(sum(ts.w * (1 + ln(n.n / least(ts.df, n.n)) / ln(n.n))), 0) FROM ts, n WHERE ${termMatchSql(sql`ts.t`, sql`ts.p`)})
        + CASE WHEN EXISTS (SELECT 1 FROM placements pl WHERE pl.message_id = m.id AND pl.topic_id = ANY(${topicArray})) THEN 2 ELSE 0 END AS score
      FROM messages m JOIN mt ON mt.id = m.id)
    SELECT m.id, m.chat_id, m.sender_label, m.body, m.sent_at, mt.is_read, m.content_revision, scored.score::float AS score, count(*) OVER ()::int AS total
    FROM scored JOIN messages m ON m.id = scored.id JOIN mt ON mt.id = m.id
    WHERE scored.score > 0
    ORDER BY scored.score DESC, m.sent_at DESC NULLS LAST, m.id DESC LIMIT ${ASK_PAGE_SIZE} OFFSET ${offset}`);
  const total = rows.rows[0]?.total ?? (offset ? offset : 0);
  const nextOffset = offset + rows.rows.length < total ? offset + rows.rows.length : null;

  const context = await messageContext(db, rows.rows.map((r) => r.id));
  const placementRows = rows.rows.length
    ? await db.select({ messageId: s.placements.messageId, topicId: s.placements.topicId }).from(s.placements).where(inArray(s.placements.messageId, rows.rows.map((r) => r.id)))
    : [];
  return {
    query: question,
    interpretation,
    note,
    interpretation_pending: pending,
    terms,
    word_hits: wordHits,
    filter_fingerprint: filterFingerprint({ userId: ctx.userId, workspaceId: ctx.workspaceId, chatIds }, filter),
    // Every match counts; this page holds ASK_PAGE_SIZE of them from `offset`.
    total,
    offset,
    next_offset: nextOffset,
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
        context: context.get(r.id) ?? {},
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
  /** Words in the chats containing what was typed ("liceclip" for "clip"); see wordsContaining. */
  words: string[] = [],
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
  // The messages around each match, so a short reply or a bare name can be understood.
  const around = await messageContext(db, rows.map((r) => r.id));
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
    const ctx = around.get(r.id);
    const context = [ctx?.before, ctx?.after].filter((c): c is ContextLine => !!c).map((c) => `(${c.rel}) ${c.sender}: ${c.text.slice(0, 160)}`);
    const m = { ref: `m${messages.length + 1}`, chat: titleOf.get(r.chatId)!, sender: r.sender, time: r.sentAt ? r.sentAt.toISOString().slice(0, 16) : null, text, ...(context.length ? { context } : {}) };
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
    answers.push(...(await Promise.all(batch.map((part, j) => ask(answerPrompt(question, i + j === 0 ? messages : [], part, words), 'answer')))));
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

type AnswerRunner = (chatIds: string[], question: string, messageIds: string[], words?: string[]) => Promise<AnswerReply | NotYet | null>;

/** Web side: ask the worker for the answer, then attach each cited message's sender and snippet. */
export async function answer(db: Db, ctx: AuthCtx, body: unknown, run: AnswerRunner = answerViaWorker(db, ctx.workspaceId)) {
  const b = (body ?? {}) as { q?: unknown; chat?: unknown; message_ids?: unknown; words?: unknown };
  const words = Array.isArray(b.words) ? b.words.filter((x): x is string => typeof x === 'string' && x.length <= 40).map(normalizeSearch).slice(0, 24) : [];
  const question = typeof b.q === 'string' ? b.q.trim() : '';
  if (question.length < 1 || question.length > 300) throw new SafeError('ask in 1–300 characters');
  const messageIds = Array.isArray(b.message_ids) ? b.message_ids.filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)).slice(0, ANSWER_MAX_MESSAGES) : [];
  const chats = typeof b.chat === 'string' ? [await requireChat(db, ctx, b.chat)] : await db.select().from(s.chats).where(and(eq(s.chats.workspaceId, ctx.workspaceId), eq(s.chats.excluded, false), eq(s.chats.selected, true)));
  if (!chats.length) return { answer: null, note: 'Open a chat first.' };
  const r = await run(chats.map((c) => c.id), question, messageIds, words);
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
  async (chatIds, question, messageIds, words = []) => {
    const { prepareAskReply } = await import('../events-hub');
    const id = crypto.randomUUID();
    const { reply } = await prepareAskReply(id, ANSWER_TIMEOUT_MS, { ws: workspaceId, kind: 'answer' });
    await db.execute(sql`SELECT pg_notify(${ASK_CHANNEL}, ${JSON.stringify({ id, kind: 'answer', workspaceId, chatIds, question, messageIds, words })})`);
    const r = await reply;
    if (!r) return { pending: id };
    return r.ok ? (r as unknown as AnswerReply) : { failed: r.reason };
  };
