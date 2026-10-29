// Durable analysis pipeline. Jobs are rows in analysis_jobs executed by the
// pg-boss worker; every model output is validated and published atomically,
// with generation/revision checks so stale work cannot overwrite newer state.
import crypto from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import * as s from '../../db/schema';
import type { LlmConfig } from '../../lib/config';
import type { Db, Tx } from '../db';
import { citedMessagesSql } from '../graph/filters';
import { ancestors, ensureRoots, loadTree, lockChat, ROOT_LABELS, type RootEnum, type Tree, type TreeNode } from '../graph/tree';
import { notifyChange } from '../notify';
import { getStorage } from '../storage';
import { sha256, sniffMime } from '../util';
import { courtesyOnlySql } from './smalltalk';
import { assignmentPrompt, describePrompt, extractionPrompt, fillerPrompt, linkPrompt, rootReviewPrompt, MAX_CHILD_TOPICS, refinementPrompt, regroupPrompt, splitPrompt, taxonomyPrompt, type PromptMessage, type TreeDigestNode, type UnitDigest } from './prompts';
import type { FixtureHints } from './provider';
import { BudgetExceededError, callModel, ensureLedger, estimateTokens, InvalidOutputError, type RouterDeps } from './router';
import { AssignmentSchema, DescribeSchema, ExtractionSchema, FillerSchema, JSON_SCHEMAS, RootReviewSchema, LinkVerdictSchema, PIPELINE_VERSION, RegroupSchema, SplitSchema, TaxonomySchema, type Assignment } from './schemas';
import { isTopicTitle, overlappingSubject, sameSubject, validateTaxonomy, type UnitInfo } from './taxonomy';

export interface PipelineDeps extends RouterDeps {
  cfg: LlmConfig;
}

type Job = typeof s.analysisJobs.$inferSelect;
type MsgRef = { m: string; r: number };

const SUGGESTED_KNOWLEDGE = 'Software, Programming, Music, Art, History';
const REFINE_MIN_UNITS = 2;
const MAX_TAXONOMY_UNITS_PER_CALL = 40;
// When Super's answer for a window is cut off at the output limit (on a busy chat 40 discussions
// often are, even after a repair), the build carries on with half as many per call, down to this.
const MIN_TAXONOMY_UNITS_PER_CALL = 5;
const MAX_ASSIGN_UNITS_PER_CALL = 40;
// Share of the input limit the existing topic list may take; the rest is for discussions.
const TOPIC_LIST_SHARE = 0.5;
// Placing a big backlog continues in a follow-up job rather than outliving the
// 10-minute stale-job reset.
const ASSIGN_TIME_BUDGET_MS = 4 * 60_000;
// Filler screening: only short plain-text messages can be filler; longer ones are content without asking.
const FILLER_MAX_CHARS = 80;
const FILLER_PER_CALL = 150;
const FILLER_TIME_BUDGET_MS = 3 * 60_000;
// Keeps an IN (...) list non-empty when nothing was flagged.
const NIL_ID = '00000000-0000-0000-0000-000000000000';

/**
 * The largest leading slice of `items` whose prompt fits one model call (the
 * router refuses anything over 1.5x the input limit). A long chat yields far
 * more units than one call can hold; the rest are placed by later calls.
 */
async function fitBatch<U>(cfg: LlmConfig, items: U[], cap: number, render: (batch: U[]) => Promise<string>): Promise<U[]> {
  const limit = cfg.LLM_MAX_INPUT_TOKENS_PER_CALL * 1.4;
  let n = Math.min(items.length, cap);
  for (;;) {
    const est = estimateTokens(await render(items.slice(0, n)));
    if (est <= limit || n <= 1) return items.slice(0, n);
    n = Math.max(1, Math.min(n - 1, Math.floor(((n * limit) / est) * 0.9)));
  }
}
const MAX_QUOTED_PER_CHUNK = 20;
const ROOT_SHORT: Record<RootEnum, string> = { KNOWLEDGE: 'K', GENERAL_CHAT: 'G', EVENTS_ACTIVITIES: 'E', RESOURCES: 'R' };

export const fingerprintOf = (kind: string, refs: MsgRef[], extra = '') =>
  sha256(`${PIPELINE_VERSION}|${kind}|${extra}|${[...refs].sort((a, b) => (a.m < b.m ? -1 : 1)).map((x) => `${x.m}:${x.r}`).join(',')}`);

// --------------------------------------------------------------------------
// Dispatch: coalesce committed outbox rows into bounded microbatch jobs.
// --------------------------------------------------------------------------
// Nemotron runs on demand, not continuously: new messages of a chat are only
// dispatched while its analysis window is open (just after it is first opened,
// and after Refresh). force (tests, demo seeding, scripts) ignores the window.
// Images in a waiting batch are still downloading (the companion fetches them for opened chats):
// hold the batch so the vision model can read them, but never for longer than this.
const IMAGE_WAIT_MS = 2 * 60 * 1000;
async function awaitingImages(db: Db, chatId: string, oldest: Date): Promise<boolean> {
  if (Date.now() - oldest.getTime() >= IMAGE_WAIT_MS) return false;
  const r = await db.execute(sql`
    SELECT 1 FROM analysis_outbox o JOIN attachments a ON a.message_id = o.message_id
    WHERE o.chat_id = ${chatId}::uuid AND o.dispatched_job_id IS NULL AND a.media_type = 'image'
      AND a.availability IN ('available', 'fetching') AND NOT a.view_once LIMIT 1`);
  return r.rows.length > 0;
}

export async function dispatchOutbox(db: Db, cfg: LlmConfig, opts: { force?: boolean } = {}): Promise<string[]> {
  const pending = await db.execute<{ chat_id: string; n: number; oldest: Date }>(sql`
    SELECT o.chat_id, count(*)::int AS n, min(o.created_at) AS oldest FROM analysis_outbox o
    JOIN chats c ON c.id = o.chat_id
    WHERE o.dispatched_job_id IS NULL ${opts.force ? sql`` : sql`AND c.auto_analyze_until > now()`}
    GROUP BY o.chat_id`);
  const created: string[] = [];
  for (const p of pending.rows) {
    const ready = opts.force || p.n >= cfg.LLM_MICROBATCH_MAX_MESSAGES || Date.now() - new Date(p.oldest).getTime() >= cfg.LLM_MICROBATCH_MAX_WAIT_MS;
    if (ready && !opts.force && (await awaitingImages(db, p.chat_id, new Date(p.oldest)))) continue;
    if (!ready) continue;
    const ids = await db.transaction(async (tx) => {
      const chat = await lockChat(tx, p.chat_id);
      const rows = await tx
        .select()
        .from(s.analysisOutbox)
        .where(and(eq(s.analysisOutbox.chatId, p.chat_id), isNull(s.analysisOutbox.dispatchedJobId)))
        .orderBy(s.analysisOutbox.id)
        .for('update', { skipLocked: true });
      // Withdrawn selection or deletion invalidates not-yet-dispatched analysis.
      const stale = rows.filter((r) => r.deletionGeneration !== chat.deletionGeneration || r.selectionEpoch !== chat.selectionEpoch || !chat.selected);
      if (stale.length) await tx.delete(s.analysisOutbox).where(inArray(s.analysisOutbox.id, stale.map((r) => r.id)));
      const live = rows.filter((r) => !stale.includes(r));
      const out: string[] = [];
      for (let i = 0; i < live.length; i += cfg.LLM_MICROBATCH_MAX_MESSAGES) {
        const batch = live.slice(i, i + cfg.LLM_MICROBATCH_MAX_MESSAGES);
        const refs = batch.map((b) => ({ m: b.messageId, r: b.revision }));
        const fp = fingerprintOf('microbatch', refs);
        const [job] = await tx
          .insert(s.analysisJobs)
          .values({
            workspaceId: chat.workspaceId,
            chatId: chat.id,
            kind: 'microbatch',
            logicalJobId: crypto.randomUUID(),
            inputFingerprint: fp,
            inputMessages: refs,
            pipelineVersion: PIPELINE_VERSION,
            deletionGeneration: chat.deletionGeneration,
            selectionEpoch: chat.selectionEpoch,
          })
          .onConflictDoNothing()
          .returning({ id: s.analysisJobs.id });
        // Identical input already analyzed (replay): link outbox rows, no new inference.
        const jobId = job?.id ?? (await tx.select({ id: s.analysisJobs.id }).from(s.analysisJobs).where(and(eq(s.analysisJobs.chatId, chat.id), eq(s.analysisJobs.inputFingerprint, fp))))[0].id;
        await tx.update(s.analysisOutbox).set({ dispatchedJobId: jobId }).where(inArray(s.analysisOutbox.id, batch.map((b) => b.id)));
        if (job) out.push(job.id);
      }
      return out;
    });
    created.push(...ids);
  }
  return created;
}

// --------------------------------------------------------------------------
// Job execution
// --------------------------------------------------------------------------
export interface JobOutcome {
  status: Job['status'];
  followUps: string[];
  detail?: Record<string, unknown>;
}

export async function runJob(deps: PipelineDeps, jobId: string): Promise<JobOutcome> {
  const { db } = deps;
  const [job] = await db.select().from(s.analysisJobs).where(eq(s.analysisJobs.id, jobId));
  if (!job) return { status: 'failed', followUps: [] };
  if (job.status === 'completed' || job.status === 'cancelled' || job.status === 'superseded') return { status: job.status, followUps: [] };
  await db.update(s.analysisJobs).set({ status: 'running', startedAt: new Date(), attempts: sql`${s.analysisJobs.attempts} + 1` }).where(eq(s.analysisJobs.id, jobId));
  await ensureLedger(db, job.workspaceId, job.logicalJobId, deps.cfg);
  try {
    const chat = await currentChat(db, job);
    if (!chat) return await finish(db, job, 'cancelled', [], { reason: 'chat deselected or deleted' });
    let outcome: JobOutcome;
    if (job.kind === 'microbatch') outcome = await runMicrobatch(deps, job, chat);
    else if (job.kind === 'rebuild') outcome = await runRebuild(deps, job, chat);
    else if (job.kind === 'refine') outcome = await runRefine(deps, job, chat);
    else outcome = await runLinks(deps, job);
    return await finish(db, job, outcome.status, outcome.followUps, outcome.detail);
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      return finish(db, job, 'budget_paused', [], { reason: e.message });
    }
    const safe = e instanceof InvalidOutputError ? `invalid model output: ${e.message.slice(0, 200)}` : e instanceof Error ? e.message.slice(0, 200) : 'job failed';
    await db.update(s.analysisJobs).set({ status: 'failed', safeError: safe, completedAt: new Date() }).where(eq(s.analysisJobs.id, job.id));
    await notifyChange(db, { ws: job.workspaceId, kind: 'analysis', chatId: job.chatId });
    throw e;
  }
}

async function finish(db: Db, job: Job, status: Job['status'], followUps: string[], detail?: Record<string, unknown>): Promise<JobOutcome> {
  await db
    .update(s.analysisJobs)
    .set({ status, completedAt: new Date(), result: { ...((job.result as Record<string, unknown> | null) ?? {}), ...(detail ?? {}) }, safeError: status === 'budget_paused' ? String(detail?.reason ?? 'budget paused') : null })
    .where(eq(s.analysisJobs.id, job.id));
  await notifyChange(db, { ws: job.workspaceId, kind: 'analysis', chatId: job.chatId });
  return { status, followUps, detail };
}

/** The chat whose messages a map is built from: itself, or for a one-sided map the chat it maps. */
export const messageChatOf = (chat: { id: string; mapOf: string | null }) => chat.mapOf ?? chat.id;

/** Whether a map may still be built: its chat is open in ThreadMap (for a one-sided map, the chat it maps). */
async function mapIsLive(db: Db | Tx, chat: Chat): Promise<boolean> {
  if (!chat.mapOf) return chat.selected && !chat.excluded;
  const [of] = await db.select({ selected: s.chats.selected, excluded: s.chats.excluded }).from(s.chats).where(eq(s.chats.id, chat.mapOf));
  return Boolean(of?.selected && !of.excluded);
}

async function currentChat(db: Db | Tx, job: Job) {
  const [chat] = await db.select().from(s.chats).where(eq(s.chats.id, job.chatId));
  if (!chat || !(await mapIsLive(db, chat)) || chat.deletionGeneration !== job.deletionGeneration) return null;
  if (job.kind === 'microbatch' && chat.selectionEpoch !== job.selectionEpoch) return null;
  return chat;
}

type Chat = typeof s.chats.$inferSelect;

interface LoadedMessage {
  id: string;
  rev: number;
  sender: string;
  sentAt: Date | null;
  body: string | null;
  files: string[];
  urls: string[];
  nativeId: string;
  /** Native id of the quoted message, when this one is a reply. */
  replyTo: string | null;
  /** Vision descriptions of attached images / video frames ("image: …"). */
  media?: string[];
}

type MessageRow = { id: string; content_revision: number; sender_label: string; sent_at: Date | null; body: string | null; native_id: string; reply_to_native_id: string | null };
const contextMessage = (r: MessageRow): LoadedMessage => ({ id: r.id, rev: r.content_revision, sender: r.sender_label, sentAt: r.sent_at ? new Date(r.sent_at) : null, body: r.body, files: [], urls: [], nativeId: r.native_id, replyTo: r.reply_to_native_id });

async function loadCurrent(db: Db | Tx, refs: MsgRef[]): Promise<LoadedMessage[]> {
  if (!refs.length) return [];
  const rows = await db.execute<MessageRow & { files: string[]; urls: string[]; media: string[] }>(sql`
    SELECT m.id, m.content_revision, m.sender_label, m.sent_at, m.body, m.native_id, m.reply_to_native_id,
      ARRAY(SELECT COALESCE(a.filename, a.media_type) FROM attachments a WHERE a.message_id = m.id) AS files,
      ARRAY(SELECT a.media_type || ': ' || a.ai_description FROM attachments a WHERE a.message_id = m.id AND a.ai_description IS NOT NULL) AS media,
      ARRAY(SELECT r.url FROM resources r WHERE r.message_id = m.id AND r.kind = 'url') AS urls
    FROM messages m
    WHERE m.id IN (${sql.join(refs.map((r) => sql`${r.m}::uuid`), sql`, `)})
      AND m.state = 'active' AND m.kind IN ('text','media') AND (m.expires_at IS NULL OR m.expires_at > now())
    ORDER BY m.sent_at NULLS LAST, m.id`);
  const want = new Map(refs.map((r) => [r.m, r.r]));
  // A newer revision has its own outbox entry; skip stale revisions here.
  return rows.rows
    .filter((r) => want.get(r.id) === r.content_revision)
    .map((r) => ({ ...contextMessage(r), files: r.files, urls: r.urls, media: r.media }));
}

const promptText = (m: LoadedMessage, limit = 1200) => {
  const b = m.body ?? '';
  const text = b.length > limit ? `${b.slice(0, limit)} [truncated]` : b;
  // What the vision model saw in attached images / video frames, so they are categorised by content.
  const media = (m.media ?? []).map((d) => `[${d}]`).join(' ');
  return media ? (text ? `${text} ${media}` : media) : text;
};

async function nativeIdsFor(db: Db | Tx, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const r = await db.select({ id: s.messages.id, n: s.messages.nativeId }).from(s.messages).where(inArray(s.messages.id, ids));
  return new Map(r.map((x) => [x.id, x.n]));
}

// --------------------------------------------------------------------------
// Microbatch: Nano extraction, then incremental assignment once a taxonomy exists.
// --------------------------------------------------------------------------
async function runMicrobatch(deps: PipelineDeps, job: Job, chat: Chat): Promise<JobOutcome> {
  const { db, cfg } = deps;
  await describeMedia(deps, job);
  const msgs = await loadCurrent(db, job.inputMessages);
  if (!msgs.length) return { status: 'completed', followUps: [], detail: { skipped: 'no current messages' } };
  const fixture = deps.provider.kind === 'fixture';

  // Bounded chunks (message count and estimated tokens) with preceding context.
  const chunks: LoadedMessage[][] = [];
  let cur: LoadedMessage[] = [];
  let tokens = 0;
  for (const m of msgs) {
    const t = estimateTokens(promptText(m)) + 30;
    if (cur.length && (cur.length >= cfg.LLM_EXTRACT_MAX_MESSAGES || tokens + t > cfg.LLM_MAX_INPUT_TOKENS_PER_CALL * 0.6)) {
      chunks.push(cur);
      cur = [];
      tokens = 0;
    }
    cur.push(m);
    tokens += t;
  }
  if (cur.length) chunks.push(cur);

  let unitSeq = 0;
  const filler = new Set<string>();
  const units: { unitKey: string; primaryRoot: RootEnum; title: string; terms: string[]; refs: MsgRef[]; bullets: { text: string; evidence: MsgRef[] }[]; resources: string[]; needsReview: boolean }[] = [];
  for (const chunk of chunks) {
    // A one-sided map reads the other side's messages too, as context only.
    const context = await precedingContext(db, messageChatOf(chat), chunk[0], 10);
    // A reply is read with the message it quotes, even when that message is
    // far outside the chunk and its preceding window.
    // A one-sided map's batch holds only that side's messages: what the other side said in
    // between (what "ok sure" answers) is read with them, as context only.
    if (chat.mapOf && chat.mapSide) {
      const seen = new Set(context.map((m) => m.id));
      context.push(...(await otherSideBetween(db, chat.mapOf, chat.mapSide, chunk)).filter((m) => !seen.has(m.id)));
    }
    context.sort((a, b) => (a.sentAt?.getTime() ?? 0) - (b.sentAt?.getTime() ?? 0));
    const nearby = new Set([...chunk, ...context].map((m) => m.nativeId));
    // Reply chains: the message each reply quotes, and what that one quotes in turn.
    const quoted: LoadedMessage[] = [];
    let want = chunk.map((m) => m.replyTo);
    for (let hop = 0; hop < REPLY_CHAIN_HOPS && quoted.length < MAX_QUOTED_PER_CHUNK; hop++) {
      const natives = [...new Set(want.filter((n): n is string => !!n && !nearby.has(n)))].slice(0, MAX_QUOTED_PER_CHUNK - quoted.length);
      if (!natives.length) break;
      const got = await quotedMessages(db, messageChatOf(chat), natives);
      for (const q of got) nearby.add(q.nativeId);
      quoted.push(...got);
      want = got.map((q) => q.replyTo);
    }
    quoted.sort((a, b) => (a.sentAt?.getTime() ?? 0) - (b.sentAt?.getTime() ?? 0));
    const ctxRefs = new Map<string, LoadedMessage>([...quoted.map((m, i) => [`q${i + 1}`, m] as const), ...context.map((m, i) => [`c${i + 1}`, m] as const)]);
    let remaining = chunk;
    for (let pass = 0; pass < 2 && remaining.length; pass++) {
      const refMap = new Map<string, LoadedMessage>(remaining.map((m, i) => [`m${i + 1}`, m]));
      const refOfNative = new Map([...ctxRefs, ...refMap].map(([ref, m]) => [m.nativeId, ref]));
      const replyRef = (m: LoadedMessage) => (m.replyTo ? refOfNative.get(m.replyTo) : undefined);
      const pm: PromptMessage[] = [...refMap].map(([ref, m]) => ({ ref, sender: m.sender, time: m.sentAt?.toISOString() ?? null, text: promptText(m), has_file: m.files[0] ?? null, urls: m.urls, reply_to: replyRef(m) }));
      const ctx: PromptMessage[] = [...ctxRefs].map(([ref, m]) => ({ ref, sender: m.sender, time: m.sentAt?.toISOString() ?? null, text: promptText(m, 200), reply_to: replyRef(m) }));
      const p = extractionPrompt(chat.title, pm, ctx);
      const hints: FixtureHints | undefined = fixture ? { refs: Object.fromEntries([...ctxRefs, ...refMap].map(([k, v]) => [k, v.nativeId])) } : undefined;
      // Nano segments first; messages it leaves uncovered escalate once to Super.
      const res = await callModel(deps, { workspaceId: job.workspaceId, logicalJobId: job.logicalJobId, jobId: job.id }, {
        role: pass === 0 ? 'fast' : 'balanced',
        operation: pass === 0 ? 'extract' : 'extract:escalate',
        thinking: false,
        ...p,
        schema: ExtractionSchema,
        schemaName: 'extraction',
        jsonSchema: JSON_SCHEMAS.extraction,
        hints,
      });
      const covered = new Set<string>();
      for (const u of res.value.units) {
        // Only supplied refs are admissible; each message joins at most one unit.
        const refs = [...new Set(u.message_refs)].filter((r) => refMap.has(r) && !covered.has(r));
        if (!refs.length) continue;
        refs.forEach((r) => covered.add(r));
        const refSet = new Set(refs);
        // A summary's source is never filler, whatever the model said.
        const cited = new Set(u.summary_bullets.flatMap((b) => b.evidence_refs));
        for (const r of u.filler_refs) if (refSet.has(r) && !cited.has(r)) filler.add(refMap.get(r)!.id);
        const bullets = u.summary_bullets
          .map((b) => ({ text: b.text, evidence: b.evidence_refs.filter((r) => refSet.has(r)).map((r) => ({ m: refMap.get(r)!.id, r: refMap.get(r)!.rev })) }))
          .filter((b) => b.evidence.length > 0);
        units.push({
          unitKey: `u${++unitSeq}`,
          primaryRoot: u.primary_root,
          title: u.discussion_title,
          terms: u.topic_terms,
          refs: refs.map((r) => ({ m: refMap.get(r)!.id, r: refMap.get(r)!.rev })),
          bullets,
          resources: u.resource_refs.filter((r) => refSet.has(r)).map((r) => refMap.get(r)!.id),
          needsReview: u.needs_review,
        });
      }
      remaining = remaining.filter((_, i) => !covered.has(`m${i + 1}`));
    }
    if (remaining.length) {
      // Still uncovered after one retry: keep visibly in Needs review.
      units.push({ unitKey: `u${++unitSeq}`, primaryRoot: 'GENERAL_CHAT', title: 'Unclassified messages', terms: [], refs: remaining.map((m) => ({ m: m.id, r: m.rev })), bullets: [], resources: [], needsReview: true });
    }
  }

  await db.transaction(async (tx) => {
    for (const u of units) {
      await tx
        .insert(s.analysisUnits)
        .values({
          workspaceId: job.workspaceId,
          chatId: chat.id,
          jobId: job.id,
          unitKey: u.unitKey,
          primaryRoot: u.primaryRoot,
          topicTerms: u.terms,
          messageRefs: u.refs,
          summaryBullets: { title: u.title, bullets: u.bullets },
          resourceRefs: u.resources,
          needsReview: u.needsReview,
        })
        .onConflictDoNothing();
    }
    // Filler stays in its discussion's thread but off the map. (A one-sided map leaves this to the chat's own map.)
    if (!chat.mapOf) {
      await tx
        .update(s.messages)
        .set({ filler: sql`(${s.messages.id} IN (${sql.join([...filler, NIL_ID].map((id) => sql`${id}::uuid`), sql`, `)}) OR ${courtesyOnlySql(sql`${s.messages}`)})` })
        // A message the owner moved keeps the owner's choice.
        .where(and(inArray(s.messages.id, msgs.map((m) => m.id)), isNull(s.messages.fillerOverride)));
    }
  });

  await joinReplyFragments(db, chat.id);
  const [fresh] = await db.select().from(s.chats).where(eq(s.chats.id, chat.id));
  if (fresh.taxonomyVersion === 0) {
    const rebuild = await maybeScheduleInitialTaxonomy(db, chat.id, job.id);
    return { status: 'completed', followUps: rebuild ? [rebuild] : [], detail: { units: units.length, awaiting: 'initial_taxonomy' } };
  }
  const assigned = await assignIncremental(deps, job, chat);
  return { status: 'completed', followUps: assigned.followUps, detail: { units: units.length, ...assigned.detail } };
}

async function precedingContext(db: Db | Tx, chatId: string, first: LoadedMessage, n: number): Promise<LoadedMessage[]> {
  if (!first.sentAt) return [];
  const rows = await db.execute<MessageRow>(sql`
    SELECT id, content_revision, sender_label, sent_at, body, native_id, reply_to_native_id FROM messages
    WHERE chat_id = ${chatId}::uuid AND state = 'active' AND kind IN ('text','media') AND sent_at < ${first.sentAt}
    ORDER BY sent_at DESC LIMIT ${n}`);
  return rows.rows.reverse().map(contextMessage);
}

/** Quoted messages by native id; revoked, expired or deleted sources are never offered as context. */
// How far up a reply chain the extraction reads: the quoted message, and the one it quotes.
const REPLY_CHAIN_HOPS = 2;
// Other-side messages read as context for each message of a one-sided batch, and in all.
const OTHER_SIDE_PER_MESSAGE = 3;
const OTHER_SIDE_MAX = 40;

/**
 * For a one-sided map: the other side's messages just before each message of
 * the batch (up to a few each), so a reply like "yes, Friday works" is read
 * with the question it answers.
 */
async function otherSideBetween(db: Db | Tx, chatId: string, side: MapSide, chunk: LoadedMessage[]): Promise<LoadedMessage[]> {
  const ids = chunk.filter((m) => m.sentAt).map((m) => m.id);
  if (!ids.length) return [];
  const rows = await db.execute<MessageRow>(sql`
    SELECT DISTINCT o.id, o.content_revision, o.sender_label, o.sent_at, o.body, o.native_id, o.reply_to_native_id
    FROM messages c CROSS JOIN LATERAL (
      SELECT * FROM messages o
      WHERE o.chat_id = ${chatId}::uuid AND ${sideSql(side === 'mine' ? 'others' : 'mine', 'o')} AND o.state = 'active' AND o.kind IN ('text','media')
        AND o.sent_at < c.sent_at ORDER BY o.sent_at DESC LIMIT ${OTHER_SIDE_PER_MESSAGE}) o
    WHERE c.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
    ORDER BY o.sent_at DESC LIMIT ${OTHER_SIDE_MAX}`);
  return rows.rows.map(contextMessage);
}

async function quotedMessages(db: Db | Tx, chatId: string, natives: string[]): Promise<LoadedMessage[]> {
  if (!natives.length) return [];
  const rows = await db.execute<MessageRow>(sql`
    SELECT DISTINCT ON (native_id) id, content_revision, sender_label, sent_at, body, native_id, reply_to_native_id FROM messages
    WHERE chat_id = ${chatId}::uuid AND native_id IN (${sql.join(natives.map((n) => sql`${n}`), sql`, `)})
      AND state = 'active' AND kind IN ('text','media') AND (expires_at IS NULL OR expires_at > now())
    ORDER BY native_id, sent_at NULLS LAST, id`);
  return rows.rows.map(contextMessage).sort((a, b) => (a.sentAt?.getTime() ?? 0) - (b.sentAt?.getTime() ?? 0));
}

/** Per unit: same-root topics already holding the primary placement of a message its messages quote. */
async function replyTopicsFor(db: Db | Tx, chat: Chat, units: UnitRow[], tree: Tree): Promise<Map<string, string[]>> {
  const ids = [...new Set(units.flatMap((u) => u.messageRefs.map((r) => r.m)))];
  if (!ids.length) return new Map();
  const rows = await db.execute<{ message_id: string; topic_id: string }>(sql`
    SELECT DISTINCT r.id AS message_id, p.topic_id FROM messages r
    JOIN messages q ON q.chat_id = r.chat_id AND q.native_id = r.reply_to_native_id AND q.state = 'active'
    JOIN placements p ON p.message_id = q.id AND p.is_primary AND p.chat_id = ${chat.id}::uuid
    WHERE r.chat_id = ${messageChatOf(chat)}::uuid AND r.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`);
  const byMsg = new Map<string, string[]>();
  for (const r of rows.rows) byMsg.set(r.message_id, [...(byMsg.get(r.message_id) ?? []), r.topic_id]);
  return new Map(units.map((u) => [u.id, [...new Set(u.messageRefs.flatMap((r) => byMsg.get(r.m) ?? []))].filter((t) => tree.nodes.get(t)?.root === u.primaryRoot)]));
}

export type MapSide = 'mine' | 'others';
// Messages per analysis job of a one-sided map (like a chat's own microbatches).
const SIDE_BATCH_MESSAGES = 60;

/** A chat's one-sided map, if it has been built (or started). */
export async function sideMapOf(db: Db | Tx, chatId: string, side: MapSide): Promise<Chat | null> {
  const [m] = await db.select().from(s.chats).where(and(eq(s.chats.mapOf, chatId), eq(s.chats.mapSide, side)));
  return m ?? null;
}

/** Messages of one side of a chat: sent by the owner ("mine") or by everyone else ("others"). */
export const sideSql = (side: MapSide, alias = 'm') => sql.raw(`${alias}.direction = '${side === 'mine' ? 'outgoing' : 'incoming'}'`);

/**
 * "Map from: You / Others": a separate map built only from one side's messages,
 * so what the others said never shapes the owner's map, and the reverse. The
 * map lives in a hidden companion chat row (map_of); messages stay with the
 * chat. Nano reads that side's messages, with the other side's as context only,
 * then the map is built top-down like any other. Started on first use, and
 * brought up to date like the chat's own map (on Refresh). Returns the map's
 * chat id and the analysis jobs queued (the worker picks them up).
 */
export async function analyseSide(db: Db, chatId: string, side: MapSide, batchSize = SIDE_BATCH_MESSAGES): Promise<{ mapChatId: string; jobs: string[] }> {
  return db.transaction(async (tx) => {
    const chat = await lockChat(tx, chatId);
    let map = await sideMapOf(tx, chat.id, side);
    if (!map) {
      [map] = await tx
        .insert(s.chats)
        .values({
          workspaceId: chat.workspaceId,
          linkedAccountId: chat.linkedAccountId,
          sourceKind: chat.sourceKind,
          // Never a real WhatsApp address, so nothing from WhatsApp is ever routed here.
          nativeJid: `${chat.nativeJid}#map:${side}`,
          kind: chat.kind,
          title: chat.title,
          // Hidden from every chat list; whether it may be built follows the chat it maps.
          excluded: true,
          selectionEpoch: 1,
          mapOf: chat.id,
          mapSide: side,
        })
        .returning();
      await ensureRoots(tx, chat.workspaceId, map.id);
    }
    const busy = await tx.execute(sql`SELECT 1 FROM analysis_jobs WHERE chat_id = ${map.id}::uuid AND status IN ('pending','running') LIMIT 1`);
    if (busy.rows.length) return { mapChatId: map.id, jobs: [] };
    // This side's messages that the map has not read yet.
    const unread = await tx.execute<{ id: string; rev: number }>(sql`
      SELECT m.id, m.content_revision AS rev FROM messages m
      WHERE m.chat_id = ${chat.id}::uuid AND ${sideSql(side)} AND m.state = 'active' AND m.kind IN ('text','media') AND (m.expires_at IS NULL OR m.expires_at > now())
        AND NOT EXISTS (SELECT 1 FROM analysis_units u WHERE u.chat_id = ${map.id}::uuid AND u.message_refs @> jsonb_build_array(jsonb_build_object('m', m.id::text)))
      ORDER BY m.sent_at NULLS LAST, m.id`);
    const jobs: string[] = [];
    for (let i = 0; i < unread.rows.length; i += batchSize) {
      const refs = unread.rows.slice(i, i + batchSize).map((r) => ({ m: r.id, r: r.rev }));
      const [job] = await tx
        .insert(s.analysisJobs)
        .values({
          workspaceId: map.workspaceId,
          chatId: map.id,
          kind: 'microbatch',
          logicalJobId: crypto.randomUUID(),
          inputFingerprint: fingerprintOf('microbatch', refs, `side:${side}`),
          inputMessages: refs,
          pipelineVersion: PIPELINE_VERSION,
          deletionGeneration: map.deletionGeneration,
          selectionEpoch: map.selectionEpoch,
        })
        .onConflictDoNothing()
        .returning({ id: s.analysisJobs.id });
      if (job) jobs.push(job.id);
    }
    return { mapChatId: map.id, jobs };
  }).then(async (r) => {
    // Read but not yet placed (a build was interrupted), or nothing new but the map needs tidying.
    if (!r.jobs.length) {
      const [{ n }] = (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM analysis_units WHERE chat_id = ${r.mapChatId}::uuid AND assigned_topic_id IS NULL`)).rows;
      const id = n || (await mapNeedsTidy(db, r.mapChatId)) ? await requestRebuild(db, r.mapChatId) : null;
      if (id) r.jobs.push(id);
    }
    return r;
  });
}

/** Debounced initial taxonomy: only once no extraction for the chat is pending. */
export async function maybeScheduleInitialTaxonomy(db: Db, chatId: string, excludeJobId?: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    const chat = await lockChat(tx, chatId);
    if (chat.taxonomyVersion !== 0) return null;
    const busy = await tx.execute(sql`
      SELECT 1 FROM analysis_jobs WHERE chat_id = ${chatId}::uuid AND kind IN ('microbatch','rebuild')
        AND status IN ('pending','running') ${excludeJobId ? sql`AND id <> ${excludeJobId}::uuid` : sql``} LIMIT 1`);
    const outbox = await tx.execute(sql`SELECT 1 FROM analysis_outbox WHERE chat_id = ${chatId}::uuid AND dispatched_job_id IS NULL LIMIT 1`);
    // Messages waiting for a Refresh must not hold back the first map of what was already analysed.
    const windowOpen = Boolean(chat.autoAnalyzeUntil && chat.autoAnalyzeUntil > new Date());
    if (busy.rows.length || (outbox.rows.length && windowOpen)) return null;
    const units = await tx.select({ id: s.analysisUnits.id }).from(s.analysisUnits).where(and(eq(s.analysisUnits.chatId, chatId), isNull(s.analysisUnits.assignedTopicId)));
    if (!units.length) return null;
    const fp = sha256(`rebuild|${PIPELINE_VERSION}|${units.map((u) => u.id).sort().join(',')}`);
    const [job] = await tx
      .insert(s.analysisJobs)
      .values({ workspaceId: chat.workspaceId, chatId, kind: 'rebuild', logicalJobId: crypto.randomUUID(), inputFingerprint: fp, inputMessages: [], pipelineVersion: PIPELINE_VERSION, deletionGeneration: chat.deletionGeneration, selectionEpoch: chat.selectionEpoch })
      .onConflictDoNothing()
      .returning({ id: s.analysisJobs.id });
    return job?.id ?? null;
  });
}

/** Explicit, budget-checked rebuild request (preserves overrides). */
export async function requestRebuild(db: Db, chatId: string): Promise<string | null> {
  const [chat] = await db.select().from(s.chats).where(eq(s.chats.id, chatId));
  if (!chat) return null;
  // One queued rebuild per chat is enough: it places everything still unplaced.
  const [queued] = await db.select({ id: s.analysisJobs.id }).from(s.analysisJobs).where(and(eq(s.analysisJobs.chatId, chatId), eq(s.analysisJobs.kind, 'rebuild'), eq(s.analysisJobs.status, 'pending'))).limit(1);
  if (queued) return null;
  const [job] = await db
    .insert(s.analysisJobs)
    .values({ workspaceId: chat.workspaceId, chatId, kind: 'rebuild', logicalJobId: crypto.randomUUID(), inputFingerprint: sha256(`rebuild|manual|${Date.now()}|${crypto.randomUUID()}`), inputMessages: [], pipelineVersion: PIPELINE_VERSION, deletionGeneration: chat.deletionGeneration, selectionEpoch: chat.selectionEpoch })
    .returning({ id: s.analysisJobs.id });
  return job.id;
}

/**
 * Rebuild a chat's map from scratch: every topic (and with it every placement,
 * discussion, link and refinement frontier) is removed, the discussions Nemotron
 * already read are kept, and one fresh build places them all again under the
 * current rules. Messages and Read/Missed state are untouched. Returns the job id,
 * or null while analysis is running (a running job would publish into the old map).
 */
export async function rebuildMapFromScratch(db: Db, chatId: string): Promise<string | null> {
  const running = await db.execute(sql`SELECT 1 FROM analysis_jobs WHERE chat_id = ${chatId}::uuid AND status = 'running' LIMIT 1`);
  if (running.rows.length) return null;
  await db.transaction(async (tx) => {
    await lockChat(tx, chatId);
    await tx.execute(sql`UPDATE analysis_jobs SET status = 'cancelled' WHERE chat_id = ${chatId}::uuid AND kind IN ('rebuild', 'refine', 'links') AND status IN ('pending', 'budget_paused')`);
    await tx.execute(sql`UPDATE user_chat_view_preferences SET focus_node_id = NULL WHERE chat_id = ${chatId}::uuid`);
    await tx.delete(s.topicMergeMap).where(eq(s.topicMergeMap.chatId, chatId));
    // Category roots stay; everything beneath them goes (placements, discussions, links and frontiers cascade).
    await tx.delete(s.topics).where(and(eq(s.topics.chatId, chatId), eq(s.topics.kind, 'TOPIC')));
    await tx.update(s.analysisUnits).set({ assignedTopicId: null }).where(eq(s.analysisUnits.chatId, chatId));
    const [g] = await tx.update(s.chats).set({ graphVersion: sql`${s.chats.graphVersion} + 1` }).where(eq(s.chats.id, chatId)).returning({ v: s.chats.graphVersion, ws: s.chats.workspaceId });
    await notifyChange(tx, { ws: g.ws, kind: 'graph', chatId, version: g.v });
  });
  return requestRebuild(db, chatId);
}

/**
 * Re-read a chat from scratch: like rebuildMapFromScratch, but the discussions are
 * read again too, under the current reading rules (e.g. one subject per discussion).
 * Every topic and every discussion goes; every message is queued again as if the chat
 * had just been opened, and the first build runs when the reading is done. Messages,
 * Read/Missed and stars are untouched. Returns false while analysis is running.
 */
export async function rereadChatFromScratch(db: Db, chatId: string): Promise<boolean> {
  const running = await db.execute(sql`SELECT 1 FROM analysis_jobs WHERE chat_id = ${chatId}::uuid AND status = 'running' LIMIT 1`);
  if (running.rows.length) return false;
  await db.transaction(async (tx) => {
    const chat = await lockChat(tx, chatId);
    await tx.execute(sql`UPDATE analysis_jobs SET status = 'cancelled' WHERE chat_id = ${chatId}::uuid AND status IN ('pending', 'budget_paused')`);
    await tx.execute(sql`UPDATE user_chat_view_preferences SET focus_node_id = NULL WHERE chat_id = ${chatId}::uuid`);
    await tx.delete(s.topicMergeMap).where(eq(s.topicMergeMap.chatId, chatId));
    // Category roots stay; everything beneath them goes (placements, discussions, links and frontiers cascade).
    await tx.delete(s.topics).where(and(eq(s.topics.chatId, chatId), eq(s.topics.kind, 'TOPIC')));
    await tx.delete(s.analysisUnits).where(eq(s.analysisUnits.chatId, chatId));
    // Every message waits to be read again (the outbox is unique per message revision).
    await tx.delete(s.analysisOutbox).where(eq(s.analysisOutbox.chatId, chatId));
    await tx.execute(sql`
      INSERT INTO analysis_outbox (workspace_id, chat_id, message_id, revision, deletion_generation, selection_epoch)
      SELECT m.workspace_id, m.chat_id, m.id, m.content_revision, ${chat.deletionGeneration}, ${chat.selectionEpoch}
      FROM messages m WHERE m.chat_id = ${chatId}::uuid AND m.state = 'active' AND m.kind IN ('text', 'media')`);
    // Never mapped: the first build runs once the reading is done; the window lets the reading start now.
    const [g] = await tx
      .update(s.chats)
      .set({ taxonomyVersion: 0, graphVersion: sql`${s.chats.graphVersion} + 1`, autoAnalyzeUntil: new Date(Date.now() + 2 * 60_000) })
      .where(eq(s.chats.id, chatId))
      .returning({ v: s.chats.graphVersion, ws: s.chats.workspaceId });
    await notifyChange(tx, { ws: g.ws, kind: 'graph', chatId, version: g.v });
  });
  return true;
}

/** Failed map builds retried automatically before the chat waits for Refresh. */
const MAX_AUTO_RESUMES = 3;

/**
 * Resumes map building for chats left partial by a failed rebuild (e.g. a
 * provider error), so unplaced messages still reach the map without a Refresh.
 * Waits two minutes after the failure and gives up after MAX_AUTO_RESUMES
 * failed attempts within an hour, so a chat that keeps failing does not spend budget.
 */
export async function resumeStrandedBuilds(db: Db): Promise<string[]> {
  const r = await db.execute<{ id: string }>(sql`
    SELECT c.id FROM chats c JOIN workspaces w ON w.id = c.workspace_id
    WHERE c.selected AND NOT c.excluded AND w.mode = 'private'
      AND EXISTS (SELECT 1 FROM analysis_units u WHERE u.chat_id = c.id AND u.assigned_topic_id IS NULL)
      AND NOT EXISTS (SELECT 1 FROM analysis_jobs j WHERE j.chat_id = c.id AND j.status IN ('pending', 'running'))
      AND (SELECT j.status FROM analysis_jobs j WHERE j.chat_id = c.id AND j.kind = 'rebuild' ORDER BY j.created_at DESC LIMIT 1) = 'failed'
      AND (SELECT max(coalesce(j.completed_at, j.started_at, j.created_at)) FROM analysis_jobs j WHERE j.chat_id = c.id) < now() - interval '2 minutes'
      AND (SELECT count(*) FROM analysis_jobs j WHERE j.chat_id = c.id AND j.kind = 'rebuild' AND j.status = 'failed' AND j.created_at > now() - interval '1 hour'
             AND j.created_at > coalesce((SELECT max(k.created_at) FROM analysis_jobs k WHERE k.chat_id = c.id AND k.kind = 'rebuild' AND k.status = 'completed'), 'epoch'::timestamptz)) < ${MAX_AUTO_RESUMES}
    LIMIT 20`);
  const ids: string[] = [];
  for (const row of r.rows) {
    const id = await requestRebuild(db, row.id);
    if (id) ids.push(id);
  }
  return ids;
}

type UnitRow = typeof s.analysisUnits.$inferSelect;

function topicPathKey(tree: Tree, id: string): string {
  const chain = ancestors(tree, id);
  return [ROOT_SHORT[chain[0].root], ...chain.slice(1).map((n) => n.title)].join('/');
}

/**
 * The topic list sent with a window, within a fixed share of the prompt: broad
 * levels first, then deeper ones while room remains. A long chat's full tree no
 * longer fits one call; units go under the broad topics and refinement files
 * them deeper later. `keep` ids (e.g. topics a reply points at) are always sent.
 */
function fitTopics(cfg: LlmConfig, nodes: TreeDigestNode[], keep: Set<string> = new Set()): TreeDigestNode[] {
  const budget = cfg.LLM_MAX_INPUT_TOKENS_PER_CALL * TOPIC_LIST_SHARE;
  const depth = (n: TreeDigestNode) => n.path.split(' > ').length;
  const ordered = [...nodes].sort((a, b) => Number(keep.has(b.id)) - Number(keep.has(a.id)) || depth(a) - depth(b));
  const out: TreeDigestNode[] = [];
  let used = 0;
  for (const n of ordered) {
    const t = estimateTokens(JSON.stringify(n));
    if (used + t > budget && !keep.has(n.id)) break;
    out.push(n);
    used += t;
  }
  return out;
}

function treeDigest(tree: Tree, locked: Set<string>, rootFilter?: RootEnum): TreeDigestNode[] {
  return [...tree.nodes.values()]
    .filter((n) => n.kind === 'TOPIC' && (!rootFilter || n.root === rootFilter))
    .map((n) => ({ id: n.id, path: ancestors(tree, n.id).map((a) => a.title).join(' > '), locked: locked.has(n.id) }));
}

async function lockedTopicIds(db: Db | Tx, chatId: string): Promise<Set<string>> {
  const r = await db.select({ id: s.topics.id }).from(s.topics).where(and(eq(s.topics.chatId, chatId), sql`(${s.topics.titleLocked} OR ${s.topics.parentLocked})`));
  return new Set(r.map((x) => x.id));
}

/**
 * Models abbreviate long UUIDs (e.g. to their first 8 characters), which then fail
 * validation and strand every unit in Needs review. Units and topics are therefore
 * sent as short keys (u1…, t1…) and mapped back before validation.
 */
class ShortKeys {
  private toShort = new Map<string, string>();
  private toLong = new Map<string, string>();
  constructor(private prefix: string) {}
  short(id: string): string {
    let k = this.toShort.get(id);
    if (!k) {
      k = `${this.prefix}${this.toShort.size + 1}`;
      this.toShort.set(id, k);
      this.toLong.set(k, id);
    }
    return k;
  }
  long(key: string): string {
    return this.toLong.get(key) ?? key;
  }
}

type TaxonomyValue = { nodes: { key: string; parent: string }[]; assignments: { unit_key: string; topic: string }[]; secondary_placements: { message_ref: string; topic: string }[] };
function taxonomyFromModel<T extends TaxonomyValue>(v: T, units: ShortKeys, topics: ShortKeys): T {
  return {
    ...v,
    nodes: v.nodes.map((n) => ({ ...n, parent: topics.long(n.parent) })),
    assignments: v.assignments.map((a) => ({ ...a, unit_key: units.long(a.unit_key), topic: topics.long(a.topic) })),
    secondary_placements: v.secondary_placements.map((x) => ({ ...x, topic: topics.long(x.topic) })),
  };
}

const shortTopics = (nodes: TreeDigestNode[], topics: ShortKeys): TreeDigestNode[] => nodes.map((n) => ({ ...n, id: topics.short(n.id) }));

function digestUnit(u: UnitRow, sampleOf: Map<string, string>, refOf: Map<string, string>, units: ShortKeys): UnitDigest {
  const meta = u.summaryBullets as { title: string };
  return {
    unit_key: units.short(u.id),
    primary_root: u.primaryRoot,
    discussion_title: meta.title,
    topic_terms: u.topicTerms,
    size: u.messageRefs.length,
    sample: sampleOf.get(u.messageRefs[0]?.m ?? '') ?? '',
    resource_message_refs: u.resourceRefs.map((id) => refOf.get(id)!).filter(Boolean),
  };
}

async function sampleTexts(db: Db | Tx, units: UnitRow[]) {
  const ids = [...new Set(units.flatMap((u) => [...u.messageRefs.map((r) => r.m), ...u.resourceRefs]))];
  const rows = ids.length
    ? await db.select({ id: s.messages.id, body: s.messages.body, nativeId: s.messages.nativeId }).from(s.messages).where(inArray(s.messages.id, ids))
    : [];
  const sample = new Map(rows.map((r) => [r.id, (r.body ?? '').slice(0, 160)]));
  const native = new Map(rows.map((r) => [r.id, r.nativeId]));
  // Short refs for messages carrying resources (for secondary placements).
  const refOf = new Map<string, string>();
  ids.forEach((id, i) => refOf.set(id, `r${i + 1}`));
  return { sample, native, refOf };
}

// --------------------------------------------------------------------------
// Vision: images and video preview frames are described before categorisation
// (Token Factory offers no audio model, so voice clips rely on surrounding text).
// --------------------------------------------------------------------------
const MAX_DESCRIBE_PER_JOB = 24;
const MAX_VISION_BYTES = 5 * 1024 * 1024;

async function describeMedia(deps: PipelineDeps, job: Job): Promise<number> {
  const refs = job.inputMessages;
  if (!refs.length) return 0;
  const rows = await deps.db.execute<{ id: string; media_type: 'image' | 'video'; object_key: string | null; availability: string; thumbnail: Buffer | null; mime: string | null; caption: string | null }>(sql`
    SELECT a.id, a.media_type, a.object_key, a.availability, a.thumbnail, COALESCE(a.detected_mime, a.declared_mime) AS mime, m.body AS caption
    FROM attachments a JOIN messages m ON m.id = a.message_id
    WHERE a.message_id IN (${sql.join(refs.map((r) => sql`${r.m}::uuid`), sql`, `)}) AND m.state = 'active' AND a.ai_description IS NULL AND NOT a.view_once
      AND ((a.media_type = 'image' AND a.availability = 'cached' AND a.object_key IS NOT NULL) OR (a.media_type IN ('image', 'video') AND a.thumbnail IS NOT NULL))
    LIMIT ${MAX_DESCRIBE_PER_JOB}`);
  let n = 0;
  for (const a of rows.rows) {
    // The downloaded image when available, otherwise WhatsApp's embedded preview (always the case for video).
    const full = a.media_type === 'image' && a.availability === 'cached' && a.object_key ? await getStorage().get(a.object_key) : null;
    const usable = full && full.length <= MAX_VISION_BYTES && (sniffMime(full) ?? '').startsWith('image/') ? full : null;
    const bytes = usable ?? a.thumbnail;
    if (!bytes) continue;
    const mime = usable ? sniffMime(usable)! : 'image/jpeg';
    try {
      const res = await callModel(deps, { workspaceId: job.workspaceId, logicalJobId: job.logicalJobId, jobId: job.id }, {
        role: 'vision',
        operation: 'describe',
        ...describePrompt(a.media_type, a.caption),
        schema: DescribeSchema,
        schemaName: 'describe',
        jsonSchema: JSON_SCHEMAS.describe,
        maxOutputTokens: 600,
        images: [{ mime, b64: Buffer.from(bytes).toString('base64') }],
      });
      await deps.db
        .update(s.attachments)
        .set({ aiDescription: res.value.description, aiDescribedBy: res.modelId, updatedAt: new Date() })
        .where(and(eq(s.attachments.id, a.id), isNull(s.attachments.aiDescription)));
      n++;
    } catch (e) {
      if (e instanceof BudgetExceededError) throw e;
      // One unreadable image must not block the chat's categorisation.
    }
  }
  return n;
}

// --------------------------------------------------------------------------
// Initial/explicit taxonomy (Super)
// --------------------------------------------------------------------------
/**
 * Builds the map in windows of up to 40 discussions. Each call sees only the
 * existing topic names plus one window, and either reuses those topics or adds
 * new ones (at any depth), so a long chat never needs one oversized prompt.
 */
async function runRebuild(deps: PipelineDeps, job: Job, chat: Chat): Promise<JobOutcome> {
  const { db } = deps;
  const started = Date.now();
  const followUps: string[] = [];
  const detail = { units: 0, windows: 0, newTopics: 0, rejected: [] as unknown[], model: null as string | null, frontiers: 0 };
  let before = Infinity;
  let continued = false;
  let cap = MAX_TAXONOMY_UNITS_PER_CALL;
  await allowRebuildCalls(deps, job, chat);
  // Also repairs discussions read before this check existed, when the map is rebuilt from scratch.
  await joinReplyFragments(db, chat.id);
  const screened = await screenFiller(deps, job, chat);
  const rerooted = await reviewRoots(deps, job, chat);
  for (;;) {
    const all = await db.select().from(s.analysisUnits).where(and(eq(s.analysisUnits.chatId, chat.id), isNull(s.analysisUnits.assignedTopicId)));
    // Done, or the last window placed nothing (avoid spinning on units the model will not place).
    if (!all.length || all.length >= before) break;
    if (Date.now() - started > ASSIGN_TIME_BUDGET_MS) {
      const next = await requestRebuild(db, chat.id);
      if (next) followUps.push(next);
      continued = true;
      break;
    }
    let w;
    try {
      w = await taxonomyWindow(deps, job, chat, all, cap);
    } catch (e) {
      // An answer cut off at the output limit: retry the window smaller instead of failing the build.
      if (!(e instanceof InvalidOutputError) || cap <= MIN_TAXONOMY_UNITS_PER_CALL) throw e;
      cap = Math.max(MIN_TAXONOMY_UNITS_PER_CALL, Math.floor(cap / 2));
      continue;
    }
    before = all.length;
    // The answer only fitted after a repair call: send fewer discussions from now on, so each
    // window costs one call instead of two.
    if (w.repaired) cap = Math.max(MIN_TAXONOMY_UNITS_PER_CALL, Math.floor(cap / 2));
    // Keep every level at six or fewer while the map is still being built, not only at the end:
    // each window adds topics, and the map is on screen the whole time.
    await keepLevelsReadable(deps, job, chat);
    followUps.push(...w.followUps);
    detail.units += w.units;
    detail.windows++;
    detail.newTopics += w.newTopics;
    detail.rejected.push(...w.rejected);
    detail.model = w.model;
    detail.frontiers += w.frontiers;
  }
  // Nothing new to place: only a map breaking the readability rules (e.g. built under older ones) needs tidying.
  if (!detail.windows && !(await mapNeedsTidy(db, chat.id))) return { status: 'completed', followUps: [], detail: { units: 0, screened, rerooted } };
  // With everything placed, tidy the map: group related siblings, split crowded topics.
  const reshaped = continued ? null : await reshapeTree(deps, job, chat);
  if (reshaped) followUps.push(...reshaped.followUps);
  followUps.push(...(await scheduleLinks(db, chat.workspaceId)));
  return { status: 'completed', followUps: [...new Set(followUps)], detail: { ...detail, rejected: detail.rejected.slice(0, 20), continued, screened, reshaped: reshaped?.detail ?? null } };
}

// A discussion this small that replies into another is a fragment of that one.
const FRAGMENT_MAX_MESSAGES = 3;

/**
 * Nano often splits a reply off into a discussion of its own ("October 24 at
 * 5:00AM is latest time", quoting a message in "Hackathon platform links and
 * deadlines"), despite being told replies belong with what they quote: about
 * half of a long chat's discussions had one or two messages. A small, not yet
 * placed discussion containing a WhatsApp reply to a message of another
 * discussion joins that one. If the other is already on the map, the fragment
 * takes its title, root and terms so it is placed (and threaded) alongside it.
 * Returns how many fragments were joined or aligned.
 */
export async function joinReplyFragments(db: Db, chatId: string): Promise<number> {
  const units = await db.select().from(s.analysisUnits).where(eq(s.analysisUnits.chatId, chatId)).orderBy(s.analysisUnits.createdAt);
  const unitOf = new Map<string, UnitRow>();
  for (const u of units) for (const r of u.messageRefs) unitOf.set(r.m, u); // latest unit wins
  const small = units.filter((u) => !u.assignedTopicId && u.messageRefs.length <= FRAGMENT_MAX_MESSAGES);
  const ids = small.flatMap((u) => u.messageRefs.map((r) => r.m));
  if (!ids.length) return 0;
  const replies = await db.execute<{ id: string; quoted: string }>(sql`
    SELECT m.id, q.id AS quoted FROM messages m JOIN messages q ON q.chat_id = m.chat_id AND q.native_id = m.reply_to_native_id
    WHERE m.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}) ORDER BY m.sent_at, m.id`);
  // Follow joins already made, so a chain of fragments ends in one discussion.
  const into = new Map<string, string>();
  const find = (id: string) => {
    while (into.has(id)) id = into.get(id)!;
    return id;
  };
  const byId = new Map(units.map((u) => [u.id, u]));
  let n = 0;
  for (const r of replies.rows) {
    const from = unitOf.get(r.id);
    const target = unitOf.get(r.quoted);
    if (!from || !target) continue;
    const a = find(from.id);
    const b = find(target.id);
    if (a === b || into.has(from.id)) continue;
    const frag = byId.get(a)!;
    const host = byId.get(b)!;
    if (frag.assignedTopicId || frag.messageRefs.length > FRAGMENT_MAX_MESSAGES) continue;
    if (host.assignedTopicId) {
      // Already on the map: line the fragment up with it instead of rewriting a placed discussion.
      const title = (host.summaryBullets as { title?: string }).title;
      await db
        .update(s.analysisUnits)
        .set({ primaryRoot: host.primaryRoot, topicTerms: host.topicTerms, summaryBullets: { ...(frag.summaryBullets as object), ...(title ? { title } : {}) } })
        .where(eq(s.analysisUnits.id, frag.id));
      n++;
      continue;
    }
    const hb = host.summaryBullets as { title: string; bullets: unknown[] };
    const fb = frag.summaryBullets as { title: string; bullets: unknown[] };
    const merged = {
      messageRefs: [...host.messageRefs, ...frag.messageRefs.filter((x) => !host.messageRefs.some((y) => y.m === x.m))],
      summaryBullets: { ...hb, bullets: [...(hb.bullets ?? []), ...(fb.bullets ?? [])].slice(0, 8) },
      resourceRefs: [...new Set([...host.resourceRefs, ...frag.resourceRefs])],
    };
    await db.transaction(async (tx) => {
      await tx.update(s.analysisUnits).set(merged).where(eq(s.analysisUnits.id, host.id));
      await tx.delete(s.analysisUnits).where(eq(s.analysisUnits.id, frag.id));
    });
    byId.set(host.id, { ...host, ...merged });
    for (const x of frag.messageRefs) unitOf.set(x.m, byId.get(host.id)!);
    into.set(frag.id, host.id);
    n++;
  }
  return n;
}

/**
 * The per-job call cap guards against runaway loops, but a long chat's build
 * legitimately needs more: one call per window of discussions, plus tidying
 * (about one call per six topics) and filler screening. Raise this build's
 * allowance to fit its size; continuations reuse it.
 */
async function allowRebuildCalls(deps: PipelineDeps, job: Job, chat: Chat) {
  const [u] = (await deps.db.execute<{ unplaced: number; topics: number; unscreened: number }>(sql`
    SELECT (SELECT count(*) FROM analysis_units WHERE chat_id = ${chat.id}::uuid AND assigned_topic_id IS NULL)::int AS unplaced,
      (SELECT count(*) FROM topics WHERE chat_id = ${chat.id}::uuid AND retired_into IS NULL)::int AS topics,
      (SELECT count(*) FROM messages WHERE chat_id = ${chat.id}::uuid AND filler IS NULL)::int AS unscreened`)).rows;
  const need =
    deps.cfg.LLM_MAX_CALLS_PER_JOB +
    2 * Math.ceil(u.unplaced / MIN_TAXONOMY_UNITS_PER_CALL) +
    2 * Math.ceil(u.topics / MAX_CHILD_TOPICS) +
    Math.ceil(u.unscreened / FILLER_PER_CALL);
  await deps.db.execute(sql`UPDATE budget_ledger SET max_calls = GREATEST(max_calls, ${need}) WHERE logical_job_id = ${job.logicalJobId}::uuid`);
}

// Discussions per root re-check call.
const ROOT_REVIEW_PER_CALL = 60;

/**
 * Re-checks which root each discussion belongs to, before a map is built from
 * scratch (Rebuild map). Roots are first chosen when messages are read; under
 * an older rubric technical talk in a chatty tone ("32 gb ram to test unity")
 * went to General Chat. Nano reads each discussion's title, terms and a sample
 * and moves the ones filed under the wrong root. Only for a map with no topics
 * yet (a fresh build), so an existing map is never reshuffled. Returns how many moved.
 */
async function reviewRoots(deps: PipelineDeps, job: Job, chat: Chat): Promise<number> {
  const { db } = deps;
  const tree = await loadTree(db, chat.id);
  if ([...tree.nodes.values()].some((n) => n.kind === 'TOPIC' && !n.needsReview)) return 0;
  const units = await db.select().from(s.analysisUnits).where(and(eq(s.analysisUnits.chatId, chat.id), isNull(s.analysisUnits.assignedTopicId)));
  if (!units.length) return 0;
  const { sample } = await sampleTexts(db, units);
  let moved = 0;
  for (let i = 0; i < units.length; i += ROOT_REVIEW_PER_CALL) {
    const part = units.slice(i, i + ROOT_REVIEW_PER_CALL);
    const keyOf = new Map(part.map((u, k) => [`d${k + 1}`, u]));
    try {
      const r = await callModel(deps, { workspaceId: job.workspaceId, logicalJobId: job.logicalJobId, jobId: job.id }, {
        role: 'fast',
        operation: 'roots',
        ...rootReviewPrompt(
          chat.title,
          [...keyOf].map(([key, u]) => ({ key, title: (u.summaryBullets as { title?: string }).title ?? '', terms: u.topicTerms, sample: sample.get(u.messageRefs[0]?.m ?? '') ?? '', root: u.primaryRoot })),
        ),
        schema: RootReviewSchema,
        schemaName: 'roots',
        jsonSchema: JSON_SCHEMAS.roots,
        maxOutputTokens: 1500,
        thinking: false,
      });
      for (const c of r.value.roots) {
        const u = keyOf.get(c.key);
        if (!u || u.primaryRoot === c.root) continue;
        await db.update(s.analysisUnits).set({ primaryRoot: c.root }).where(eq(s.analysisUnits.id, u.id));
        moved++;
      }
    } catch (e) {
      if (e instanceof BudgetExceededError) throw e;
      // An unreadable answer leaves these discussions where they were.
    }
  }
  return moved;
}

/** Messages already read into discussions but never screened for filler (read before screening existed). */
const unscreenedSql = (chatId: string) => sql`
  SELECT m.id, m.body, u.summary_bullets->>'title' AS discussion
  FROM messages m
  JOIN LATERAL (
    SELECT summary_bullets FROM analysis_units u
    WHERE u.chat_id = m.chat_id AND u.message_refs @> jsonb_build_array(jsonb_build_object('m', m.id::text))
    ORDER BY u.created_at DESC LIMIT 1
  ) u ON true
  WHERE m.chat_id = ${chatId}::uuid AND m.filler IS NULL`;

/**
 * Screens a chat's already-read messages for filler ("ok", "lol", "is fake
 * comment"): Nano reads the short ones with their discussion's title; longer
 * messages, links and files are content without a model call. Filler stays in
 * its thread but leaves the map's counts and lists. Bounded per job; whatever
 * is left is screened on the next Refresh. Returns how many were screened.
 */
export async function screenFiller(deps: PipelineDeps, job: Job, chat: Chat): Promise<number> {
  const { db } = deps;
  // Filler belongs to the messages; the chat's own map screens them.
  if (chat.mapOf) return 0;
  const started = Date.now();
  // Small talk without asking: courtesy-only messages ("Done", "Thank you"), even when cited.
  await db.execute(sql`UPDATE messages m SET filler = true WHERE m.chat_id = ${chat.id}::uuid AND m.filler IS NOT TRUE AND m.filler_override IS NULL AND ${courtesyOnlySql()}`);
  // Content without asking: long messages, links, files, and anything a summary cites.
  await db.execute(sql`
    UPDATE messages m SET filler = false
    WHERE m.chat_id = ${chat.id}::uuid AND m.filler IS NOT FALSE AND m.filler_override IS NULL AND NOT ${courtesyOnlySql()}
      AND (m.id IN (${citedMessagesSql(sql`${chat.id}::uuid`)}) OR (m.filler IS NULL AND (m.kind <> 'text' OR length(COALESCE(m.body, '')) > ${FILLER_MAX_CHARS}
        OR EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)
        OR EXISTS (SELECT 1 FROM resources r WHERE r.message_id = m.id))))`);
  let n = 0;
  while (Date.now() - started < FILLER_TIME_BUDGET_MS) {
    const rows = (await db.execute<{ id: string; body: string | null; discussion: string | null }>(sql`${unscreenedSql(chat.id)} ORDER BY m.sent_at NULLS LAST, m.id LIMIT ${FILLER_PER_CALL}`)).rows;
    if (!rows.length) break;
    const refs = new Map(rows.map((r, i) => [`f${i + 1}`, r.id]));
    let flagged: string[] = [];
    try {
      const res = await callModel(deps, { workspaceId: job.workspaceId, logicalJobId: job.logicalJobId, jobId: job.id }, {
        role: 'fast',
        operation: 'filler',
        thinking: false,
        ...fillerPrompt(
          chat.title,
          rows.map((r, i) => ({ ref: `f${i + 1}`, discussion: r.discussion ?? '', text: r.body ?? '' })),
        ),
        schema: FillerSchema,
        schemaName: 'filler',
        jsonSchema: JSON_SCHEMAS.filler,
        maxOutputTokens: 2000,
      });
      flagged = res.value.filler.map((r) => refs.get(r)).filter((id): id is string => !!id);
    } catch (e) {
      if (e instanceof BudgetExceededError) throw e;
      // Unreadable answer: count these as content rather than hide anything by mistake.
    }
    await db
      .update(s.messages)
      .set({ filler: sql`${s.messages.id} IN (${sql.join([...flagged, NIL_ID].map((id) => sql`${id}::uuid`), sql`, `)})` })
      .where(and(inArray(s.messages.id, [...refs.values()]), isNull(s.messages.fillerOverride)));
    n += refs.size;
  }
  if (n) await notifyChange(db, { ws: chat.workspaceId, kind: 'analysis', chatId: chat.id });
  return n;
}

/** One window: the existing topic names plus as many unplaced discussions as fit one call. */
async function taxonomyWindow(deps: PipelineDeps, job: Job, chat: Chat, all: UnitRow[], cap = MAX_TAXONOMY_UNITS_PER_CALL) {
  const { db } = deps;
  const tree = await loadTree(db, chat.id);
  const locked = await lockedTopicIds(db, chat.id);
  const render = async (units: UnitRow[]) => {
    const { sample, native, refOf } = await sampleTexts(db, units);
    const unitKeys = new ShortKeys('u');
    const topicKeys = new ShortKeys('t');
    const digests = units.map((u) => digestUnit(u, sample, refOf, unitKeys));
    return { p: taxonomyPrompt(chat.title, digests, shortTopics(fitTopics(deps.cfg, treeDigest(tree, locked)), topicKeys), SUGGESTED_KNOWLEDGE), native, refOf, unitKeys, topicKeys };
  };
  const batch = await fitBatch(deps.cfg, all, cap, async (b) => {
    const { p } = await render(b);
    return p.system + p.user;
  });
  const { p, native, refOf, unitKeys, topicKeys } = await render(batch);
  const hints = deps.provider.kind === 'fixture' ? fixtureHints(tree, batch, native, refOf, unitKeys) : undefined;
  const raw = await callModel(deps, { workspaceId: job.workspaceId, logicalJobId: job.logicalJobId, jobId: job.id }, {
    role: 'balanced',
    operation: 'taxonomy',
    ...p,
    schema: TaxonomySchema,
    schemaName: 'taxonomy',
    jsonSchema: JSON_SCHEMAS.taxonomy,
    hints,
  });
  const res = { ...raw, value: taxonomyFromModel(raw.value, unitKeys, topicKeys) };
  const refToMsg = new Map([...refOf].map(([id, r]) => [r, id]));
  const unitInfos: UnitInfo[] = batch.map((u) => ({ unitKey: u.id, primaryRoot: u.primaryRoot, messageRefs: u.messageRefs.map((r) => r.m) }));
  // Top-down: building windows add only the broad first level under each root (six at most);
  // narrower levels are added one at a time by refining each topic.
  const plan = validateTaxonomy(tree, res.value, unitInfos, { allowedRefs: new Set(refToMsg.keys()), newParentIds: new Set(tree.roots.map((r) => r.id)), oneLevel: true });
  const published = await publishPlan(db, job, chat.id, plan, batch, refToMsg, res.modelId, { prov: provOf(deps) });
  return { followUps: published.followUps, units: batch.length, newTopics: plan.newTopics.length, rejected: plan.rejected.slice(0, 20) as unknown[], model: res.modelId, frontiers: published.frontiers, repaired: raw.repaired };
}

function fixtureHints(tree: Tree, units: UnitRow[], native: Map<string, string>, refOf: Map<string, string>, unitKeys: ShortKeys): FixtureHints {
  return {
    refs: Object.fromEntries([...refOf].map(([id, r]) => [r, native.get(id)!])),
    units: Object.fromEntries(units.map((u) => [unitKeys.short(u.id), u.messageRefs.map((r) => native.get(r.m)!)])),
    topicPaths: Object.fromEntries([...tree.nodes.values()].map((n) => [n.id, topicPathKey(tree, n.id)])),
  };
}

const provOf = (deps: PipelineDeps): 'model' | 'fixture' => (deps.provider.kind === 'fixture' ? 'fixture' : 'model');

interface PublishResult {
  followUps: string[];
  frontiers: number;
}

/**
 * Atomically publish a validated plan: create topics, place units (discussion
 * + claims), apply secondary placements, persist refinement frontiers and bump
 * the graph version. Stale revisions and withdrawn chats are rejected inside
 * the same transaction.
 */
async function publishPlan(
  db: Db,
  job: Job,
  chatId: string,
  plan: ReturnType<typeof validateTaxonomy>,
  units: UnitRow[],
  refToMsg: Map<string, string>,
  modelId: string,
  opts: { prov: 'model' | 'fixture'; moveFromParent?: string; frontierCandidates?: boolean },
): Promise<PublishResult> {
  // Fixture-mode output is labeled as such, never as model output.
  const prov = opts.prov;
  return db.transaction(async (tx) => {
    const chat = await lockChat(tx, chatId);
    if (!(await mapIsLive(tx, chat)) || chat.deletionGeneration !== job.deletionGeneration) {
      throw new Error('chat changed during analysis; results discarded');
    }
    const tree = await loadTree(tx, chatId);
    const taxonomyVersion = chat.taxonomyVersion + 1;
    const idOf = new Map<string, string>();
    for (const t of plan.newTopics) {
      const parentId = t.parentRef.kind === 'existing' ? t.parentRef.id : idOf.get(t.parentRef.key)!;
      if (!parentId || (t.parentRef.kind === 'existing' && !tree.nodes.has(parentId))) continue;
      const [row] = await tx
        .insert(s.topics)
        .values({ workspaceId: chat.workspaceId, chatId, root: t.root, kind: 'TOPIC', parentId, title: t.title, aliases: t.aliases, provenance: 'model', taxonomyVersion })
        .returning({ id: s.topics.id });
      idOf.set(t.key, row.id);
    }
    const resolve = (t: { kind: 'existing'; id: string } | { kind: 'new'; key: string }) => (t.kind === 'existing' ? t.id : idOf.get(t.key));
    const needsReview = new Map<RootEnum, string>();
    const needsReviewTopic = async (root: RootEnum) => {
      if (needsReview.has(root)) return needsReview.get(root)!;
      const rootNode = tree.roots.find((r) => r.root === root)!;
      const existing = rootNode.childIds.map((c) => tree.nodes.get(c)!).find((c) => c.title === 'Needs review');
      const id =
        existing?.id ??
        (await tx.insert(s.topics).values({ workspaceId: chat.workspaceId, chatId, root, kind: 'TOPIC', parentId: rootNode.id, title: 'Needs review', provenance: 'model', needsReview: true, taxonomyVersion }).returning({ id: s.topics.id }))[0].id;
      needsReview.set(root, id);
      return id;
    };

    // User placement removals are durable overrides that regeneration respects.
    const removed = await tx.execute<{ topic_id: string; message_id: string }>(sql`
      SELECT topic_id, payload->>'messageId' AS message_id FROM taxonomy_overrides WHERE chat_id = ${chatId}::uuid AND kind = 'placement_remove'`);
    const removedSet = new Set(removed.rows.map((r) => `${r.topic_id}|${r.message_id}`));

    const current = await currentRevisions(tx, [...units.flatMap((u) => u.messageRefs.map((r) => r.m)), ...refToMsg.values()]);
    const unitTopic = new Map<string, string>();
    for (const u of units) {
      const target = plan.unitTargets.get(u.id);
      if (!target) continue;
      const topicId = target.kind === 'needs_review' ? await needsReviewTopic(target.root) : resolve(target);
      if (!topicId) continue;
      unitTopic.set(u.id, topicId);
      const valid = u.messageRefs.filter((r) => current.get(r.m) === r.r);
      const meta = u.summaryBullets as { title: string; bullets: { text: string; evidence: MsgRef[] }[] };
      if (opts.moveFromParent) {
        // Refinement: the unit's discussion and model placements move to the child.
        const [disc] = await tx.select().from(s.discussions).where(and(eq(s.discussions.chatId, chatId), eq(s.discussions.unitKey, u.id)));
        if (disc && topicId !== opts.moveFromParent) {
          await tx.update(s.discussions).set({ topicId, taxonomyVersion }).where(eq(s.discussions.id, disc.id));
          await tx.execute(sql`
            UPDATE placements SET topic_id = ${topicId}::uuid, taxonomy_version = ${taxonomyVersion}
            WHERE discussion_id = ${disc.id}::uuid AND topic_id = ${opts.moveFromParent}::uuid AND NOT locked
              AND NOT EXISTS (SELECT 1 FROM placements p2 WHERE p2.topic_id = ${topicId}::uuid AND p2.message_id = placements.message_id)`);
          await tx.execute(sql`DELETE FROM placements WHERE discussion_id = ${disc.id}::uuid AND topic_id = ${opts.moveFromParent}::uuid AND NOT locked`);
        }
      } else {
        const [disc] = await tx
          .insert(s.discussions)
          .values({ workspaceId: chat.workspaceId, chatId, topicId, title: meta.title.slice(0, 120), unitKey: u.id, provenance: prov, taxonomyVersion })
          .returning({ id: s.discussions.id });
        for (const r of valid) {
          if (removedSet.has(`${topicId}|${r.m}`)) continue;
          await tx
            .insert(s.placements)
            .values({ workspaceId: chat.workspaceId, chatId, messageId: r.m, topicId, discussionId: disc.id, isPrimary: true, provenance: prov, analyzedRevision: r.r, taxonomyVersion })
            .onConflictDoNothing();
        }
        const inputIds = valid.map((r) => r.m).sort();
        const digest = sha256(valid.map((r) => `${r.m}:${r.r}`).sort().join(','));
        for (const b of meta.bullets) {
          const ev = b.evidence.filter((e) => current.get(e.m) === e.r);
          if (!ev.length) continue;
          const [claim] = await tx
            .insert(s.summaryClaims)
            .values({ workspaceId: chat.workspaceId, chatId, discussionId: disc.id, topicId, text: b.text, inputDigest: digest, inputMessageIds: inputIds, modelId, promptVersion: PIPELINE_VERSION })
            .returning({ id: s.summaryClaims.id });
          for (const e of ev) await tx.insert(s.claimEvidence).values({ claimId: claim.id, messageId: e.m, revision: e.r }).onConflictDoNothing();
        }
      }
      await tx.update(s.analysisUnits).set({ assignedTopicId: topicId }).where(eq(s.analysisUnits.id, u.id));
    }

    for (const sp of plan.secondary) {
      const msgId = refToMsg.get(sp.messageRef);
      const topicId = resolve(sp.target);
      if (!msgId || !topicId || current.get(msgId) === undefined || removedSet.has(`${topicId}|${msgId}`)) continue;
      if (opts.moveFromParent) {
        await tx.execute(sql`DELETE FROM placements WHERE message_id = ${msgId}::uuid AND topic_id = ${opts.moveFromParent}::uuid AND discussion_id IS NULL AND NOT locked`);
      }
      await tx
        .insert(s.placements)
        .values({ workspaceId: chat.workspaceId, chatId, messageId: msgId, topicId, isPrimary: false, provenance: prov, analyzedRevision: current.get(msgId)!, taxonomyVersion })
        .onConflictDoNothing();
    }

    // Refinement frontier: branches the model marked divisible with enough content.
    let frontiers = 0;
    const followUps: string[] = [];
    const subdivide = new Set([...(plan.newTopics.filter((t) => t.maySubdivide).map((t) => idOf.get(t.key)).filter(Boolean) as string[]), ...plan.subdivideExisting]);
    if (opts.frontierCandidates !== false) {
      const counts = new Map<string, string[]>();
      for (const [unitId, topicId] of unitTopic) counts.set(topicId, [...(counts.get(topicId) ?? []), unitId]);
      // Where the model already named narrower topics, even one discussion is worth its next level.
      const narrower = new Set([...(plan.newTopics.filter((t) => t.narrower).map((t) => idOf.get(t.key)).filter(Boolean) as string[]), ...plan.subdivideExisting]);
      for (const [topicId, unitIds] of counts) {
        if (!subdivide.has(topicId) || unitIds.length < (narrower.has(topicId) ? 1 : REFINE_MIN_UNITS)) continue;
        const refs = units.filter((u) => unitIds.includes(u.id)).flatMap((u) => u.messageRefs);
        // Each refinement the build starts has its own call budget: sharing the build's let a long
        // chat's refinements use up the calls its remaining discussions needed. Deeper refinements
        // share their parent refinement's budget, so recursion stays bounded.
        const refineJobId = job.kind === 'rebuild' ? crypto.randomUUID() : job.logicalJobId;
        const [fr] = await tx
          .insert(s.taxonomyFrontiers)
          .values({ workspaceId: chat.workspaceId, chatId, logicalJobId: refineJobId, parentTopicId: topicId, inputMessages: refs, checkpoint: { unitIds, narrower: narrower.has(topicId) } })
          .onConflictDoNothing()
          .returning({ id: s.taxonomyFrontiers.id });
        if (!fr) continue;
        frontiers++;
        const [rj] = await tx
          .insert(s.analysisJobs)
          .values({
            workspaceId: chat.workspaceId,
            chatId,
            kind: 'refine',
            logicalJobId: refineJobId,
            inputFingerprint: sha256(`refine|${fr.id}`),
            inputMessages: refs,
            pipelineVersion: PIPELINE_VERSION,
            deletionGeneration: chat.deletionGeneration,
            selectionEpoch: chat.selectionEpoch,
            result: { frontierId: fr.id },
          })
          .returning({ id: s.analysisJobs.id });
        followUps.push(rj.id);
      }
    }

    await tx
      .update(s.chats)
      .set({ taxonomyVersion, graphVersion: sql`${s.chats.graphVersion} + 1`, lastAnalysisAt: sql`now()` })
      .where(eq(s.chats.id, chatId));
    const [g] = await tx.select({ v: s.chats.graphVersion }).from(s.chats).where(eq(s.chats.id, chatId));
    await notifyChange(tx, { ws: chat.workspaceId, kind: 'graph', chatId, version: g.v });
    return { followUps, frontiers };
  });
}

async function currentRevisions(db: Db | Tx, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: s.messages.id, rev: s.messages.contentRevision })
    .from(s.messages)
    .where(and(inArray(s.messages.id, [...new Set(ids)]), eq(s.messages.state, 'active')));
  return new Map(rows.map((r) => [r.id, r.rev]));
}

// --------------------------------------------------------------------------
// Refinement of one branch (Ultra), resumable within the same budget ledger.
// --------------------------------------------------------------------------
async function runRefine(deps: PipelineDeps, job: Job, chat: Chat): Promise<JobOutcome> {
  const { db } = deps;
  const frontierId = (job.result as { frontierId?: string } | null)?.frontierId;
  const [fr] = frontierId ? await db.select().from(s.taxonomyFrontiers).where(eq(s.taxonomyFrontiers.id, frontierId)) : [];
  if (!fr) return { status: 'completed', followUps: [], detail: { skipped: 'frontier missing' } };
  if (fr.status === 'completed') return { status: 'completed', followUps: [] };
  await db.update(s.taxonomyFrontiers).set({ status: 'running', updatedAt: new Date() }).where(eq(s.taxonomyFrontiers.id, fr.id));
  const tree = await loadTree(db, chat.id);
  const parent = tree.nodes.get(fr.parentTopicId);
  if (!parent) {
    await db.update(s.taxonomyFrontiers).set({ status: 'completed', checkpoint: { reason: 'parent removed' } }).where(eq(s.taxonomyFrontiers.id, fr.id));
    return { status: 'completed', followUps: [] };
  }
  // Units directly on this parent, plus secondary (unit-less) placements.
  const units = await db.select().from(s.analysisUnits).where(and(eq(s.analysisUnits.chatId, chat.id), eq(s.analysisUnits.assignedTopicId, parent.id)));
  const secondary = await db.execute<{ message_id: string }>(sql`SELECT message_id FROM placements WHERE topic_id = ${parent.id}::uuid AND discussion_id IS NULL AND NOT locked`);
  const minUnits = (fr.checkpoint as { narrower?: boolean } | null)?.narrower ? 1 : REFINE_MIN_UNITS;
  if (units.length + secondary.rows.length < minUnits) {
    await db.update(s.taxonomyFrontiers).set({ status: 'completed', checkpoint: { reason: 'too little content' } }).where(eq(s.taxonomyFrontiers.id, fr.id));
    return { status: 'completed', followUps: [] };
  }
  const parentPathFull = ancestors(tree, parent.id).map((a) => a.title).join(' > ');
  // A crowded topic may hold more units than one call; refine a prompt-sized batch
  // (the rest stay on the branch and are picked up by the next deepening pass).
  const fitted = await fitBatch(deps.cfg, units, MAX_TAXONOMY_UNITS_PER_CALL, async (b) => {
    const { sample: smp, refOf: rf } = await sampleTexts(db, b);
    const uk = new ShortKeys('u');
    const pp = refinementPrompt(chat.title, parentPathFull, 't0', [], b.map((u) => digestUnit(u, smp, rf, uk)));
    return pp.system + pp.user + ' '.repeat(parent.childIds.length * 60);
  });
  units.splice(fitted.length);
  const { sample, native, refOf } = await sampleTexts(db, units);
  for (const r of secondary.rows) if (!refOf.has(r.message_id)) refOf.set(r.message_id, `r${refOf.size + 1}`);
  if (deps.provider.kind === 'fixture') {
    const more = await nativeIdsFor(db, secondary.rows.map((r) => r.message_id));
    for (const [k, v] of more) native.set(k, v);
  }
  const unitKeys = new ShortKeys('u');
  const topicKeys = new ShortKeys('t');
  const digests = units.map((u) => digestUnit(u, sample, refOf, unitKeys));
  const secondaryRefs = secondary.rows.map((r) => refOf.get(r.message_id)!);
  const parentPath = ancestors(tree, parent.id).map((a) => a.title).join(' > ');
  const children = parent.childIds.map((c) => ({ id: topicKeys.short(c), path: `${parentPath} > ${tree.nodes.get(c)!.title}`, locked: false }));
  const p = refinementPrompt(chat.title, parentPath, topicKeys.short(parent.id), children, digests);
  const user = JSON.stringify({ ...JSON.parse(p.user), secondary_message_refs: secondaryRefs });
  const hints = deps.provider.kind === 'fixture' ? fixtureHints(tree, units, native, refOf, unitKeys) : undefined;
  let res;
  try {
    const raw = await callModel(deps, { workspaceId: job.workspaceId, logicalJobId: job.logicalJobId, jobId: job.id }, {
      role: 'balanced',
      operation: 'refine',
      system: p.system,
      user,
      schema: TaxonomySchema,
      schemaName: 'taxonomy',
      jsonSchema: JSON_SCHEMAS.taxonomy,
      hints,
    });
    res = { ...raw, value: taxonomyFromModel(raw.value, unitKeys, topicKeys) };
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      // Keep the valid partial hierarchy and the unfinished frontier for resumption.
      await db.update(s.taxonomyFrontiers).set({ status: 'budget_paused', updatedAt: new Date() }).where(eq(s.taxonomyFrontiers.id, fr.id));
    } else {
      await db.update(s.taxonomyFrontiers).set({ status: 'failed', updatedAt: new Date() }).where(eq(s.taxonomyFrontiers.id, fr.id));
    }
    throw e;
  }
  const allowed = new Set([parent.id, ...parent.childIds]);
  const unitInfos: UnitInfo[] = units.map((u) => ({ unitKey: u.id, primaryRoot: u.primaryRoot, messageRefs: u.messageRefs.map((r) => r.m) }));
  // One level: only direct children of this topic; their own subtopics come from refining them next.
  const plan = validateTaxonomy(tree, res.value, unitInfos, { allowedParentIds: allowed, allowedRefs: new Set(refOf.values()), defaultTarget: parent.id, newParentIds: new Set([parent.id]), oneLevel: true });
  const refToMsg = new Map([...refOf].map(([id, r]) => [r, id]));
  const published = await publishPlan(db, job, chat.id, plan, units, refToMsg, res.modelId, { prov: provOf(deps), moveFromParent: parent.id });
  await db
    .update(s.taxonomyFrontiers)
    .set({ status: 'completed', checkpoint: { ...(fr.checkpoint as object), newTopics: plan.newTopics.length, units: units.length, noUsefulSubdivision: res.value.no_useful_subdivision }, updatedAt: new Date() })
    .where(eq(s.taxonomyFrontiers.id, fr.id));
  await keepLevelsReadable(deps, job, chat);
  // Keep going down while branches stay crowded.
  const deeper = await scheduleDeepening(db, job, chat.id);
  // Deeper levels appear after the build: related topics across chats are worked out again for them.
  const links = await scheduleLinks(db, chat.workspaceId);
  return { status: 'completed', followUps: [...published.followUps, ...deeper, ...links], detail: { parent: parent.id, newTopics: plan.newTopics.length, model: res.modelId } };
}

/** Resume budget-paused frontiers under their ORIGINAL logical ledger. */
export async function resumePausedFrontiers(db: Db, chatId: string): Promise<string[]> {
  const paused = await db.select().from(s.taxonomyFrontiers).where(and(eq(s.taxonomyFrontiers.chatId, chatId), eq(s.taxonomyFrontiers.status, 'budget_paused')));
  const out: string[] = [];
  for (const fr of paused) {
    const [job] = await db
      .select()
      .from(s.analysisJobs)
      .where(and(eq(s.analysisJobs.chatId, chatId), eq(s.analysisJobs.kind, 'refine'), sql`${s.analysisJobs.result}->>'frontierId' = ${fr.id}`));
    if (!job) continue;
    await db.update(s.taxonomyFrontiers).set({ status: 'pending' }).where(eq(s.taxonomyFrontiers.id, fr.id));
    await db.update(s.analysisJobs).set({ status: 'pending', result: { frontierId: fr.id } }).where(eq(s.analysisJobs.id, job.id));
    out.push(job.id);
  }
  return out;
}

// --------------------------------------------------------------------------
// Incremental assignment (Nano, escalating ambiguity to Super)
// --------------------------------------------------------------------------
/** Places every unassigned unit, one prompt-sized batch per call. */
async function assignIncremental(deps: PipelineDeps, job: Job, chat: Chat): Promise<{ followUps: string[]; detail: Record<string, unknown> }> {
  const { db } = deps;
  const started = Date.now();
  const followUps: string[] = [];
  const detail = { assigned: 0, escalated: 0, rejected: [] as unknown[], continued: false };
  let before = Infinity;
  for (;;) {
    const units = await db.select().from(s.analysisUnits).where(and(eq(s.analysisUnits.chatId, chat.id), isNull(s.analysisUnits.assignedTopicId)));
    // Done, or the last batch placed nothing (avoid spinning on units the model will not place).
    if (!units.length || units.length >= before) break;
    if (Date.now() - started > ASSIGN_TIME_BUDGET_MS) {
      const next = await requestRebuild(db, chat.id);
      if (next) followUps.push(next);
      detail.continued = true;
      break;
    }
    before = units.length;
    const r = await assignBatch(deps, job, chat, units);
    followUps.push(...r.followUps);
    detail.assigned += r.assigned;
    detail.escalated += r.escalated;
    detail.rejected.push(...r.rejected);
  }
  if (detail.assigned && !detail.continued) await keepLevelsReadable(deps, job, chat);
  return { followUps: [...new Set(followUps)], detail: { ...detail, rejected: detail.rejected.slice(0, 20) } };
}

async function assignBatch(deps: PipelineDeps, job: Job, chat: Chat, pending: UnitRow[]): Promise<{ followUps: string[]; assigned: number; escalated: number; rejected: unknown[] }> {
  const { db } = deps;
  const tree = await loadTree(db, chat.id);
  const locked = await lockedTopicIds(db, chat.id);
  const replyTopics = await replyTopicsFor(db, chat, pending, tree);
  const all = [...tree.roots.map((r) => ({ id: r.id, path: r.title, locked: true })), ...treeDigest(tree, locked)];
  const render = async (batch: UnitRow[]) => {
    const { sample, native, refOf } = await sampleTexts(db, batch);
    const unitKeys = new ShortKeys('u');
    const topicKeys = new ShortKeys('t');
    const digests = batch.map((u) => {
      const d = digestUnit(u, sample, refOf, unitKeys);
      const rt = replyTopics.get(u.id) ?? [];
      return rt.length ? { ...d, reply_topics: rt.map((t) => topicKeys.short(t)) } : d;
    });
    // Topics a reply points at stay choosable even past the candidate budget.
    const wanted = new Set(batch.flatMap((u) => replyTopics.get(u.id) ?? []));
    const candidates = fitTopics(deps.cfg, all, wanted);
    const shortCandidates = shortTopics(candidates, topicKeys);
    return { digests, shortCandidates, native, refOf, unitKeys, topicKeys, p: assignmentPrompt(chat.title, digests, shortCandidates) };
  };
  const units = await fitBatch(deps.cfg, pending, MAX_ASSIGN_UNITS_PER_CALL, async (b) => {
    const { p } = await render(b);
    return p.system + p.user;
  });
  const { digests, shortCandidates, native, refOf, unitKeys, topicKeys, p } = await render(units);
  const hints = deps.provider.kind === 'fixture' ? fixtureHints(tree, units, native, refOf, unitKeys) : undefined;
  const scope = { workspaceId: job.workspaceId, logicalJobId: job.logicalJobId, jobId: job.id };
  // Model output speaks in short keys; map units and topics back before using it.
  const fromModel = (v: Assignment): Assignment => ({
    assignments: v.assignments.map((a) => ({
      ...a,
      unit_key: unitKeys.long(a.unit_key),
      topic_id: a.topic_id ? topicKeys.long(a.topic_id) : a.topic_id,
      new_topic: a.new_topic ? { ...a.new_topic, parent_id: topicKeys.long(a.new_topic.parent_id) } : a.new_topic,
    })),
    secondary_placements: v.secondary_placements.map((x) => ({ ...x, topic_id: topicKeys.long(x.topic_id) })),
  });
  const firstRaw = await callModel(deps, scope, { role: 'fast', operation: 'assign', ...p, schema: AssignmentSchema, schemaName: 'assignment', jsonSchema: JSON_SCHEMAS.assignment, hints });
  const first = { ...firstRaw, value: fromModel(firstRaw.value) };
  let assignments = first.value.assignments;
  const ambiguous = assignments.filter((a) => a.confidence < 0.6 || (!a.topic_id && !a.new_topic)).map((a) => a.unit_key);
  if (ambiguous.length) {
    const sub = digests.filter((d) => ambiguous.includes(unitKeys.long(d.unit_key)));
    const p2 = assignmentPrompt(chat.title, sub, shortCandidates);
    const second = fromModel((await callModel(deps, scope, { role: 'balanced', operation: 'assign:escalate', ...p2, schema: AssignmentSchema, schemaName: 'assignment', jsonSchema: JSON_SCHEMAS.assignment, hints })).value);
    assignments = [...assignments.filter((a) => !ambiguous.includes(a.unit_key)), ...second.assignments.filter((a) => ambiguous.includes(a.unit_key))];
  }
  // Translate into a taxonomy plan so publication shares one validated path.
  const nodes: { key: string; parent: string; title: string; aliases: string[]; may_subdivide: boolean }[] = [];
  const taxAssign: { unit_key: string; topic: string }[] = [];
  for (const a of assignments) {
    if (a.topic_id && a.confidence >= 0.5) taxAssign.push({ unit_key: a.unit_key, topic: a.topic_id });
    else if (a.new_topic) {
      const key = `new:${a.unit_key}`;
      nodes.push({ key, parent: a.new_topic.parent_id, title: a.new_topic.title, aliases: [], may_subdivide: false });
      taxAssign.push({ unit_key: a.unit_key, topic: key });
    }
  }
  const unitInfos: UnitInfo[] = units.map((u) => ({ unitKey: u.id, primaryRoot: u.primaryRoot, messageRefs: u.messageRefs.map((r) => r.m) }));
  const refToMsg = new Map([...refOf].map(([id, r]) => [r, id]));
  const plan = validateTaxonomy(
    tree,
    { nodes, assignments: taxAssign, secondary_placements: first.value.secondary_placements.map((x) => ({ message_ref: x.message_ref, topic: x.topic_id })), no_useful_subdivision: false },
    unitInfos,
    { allowedRefs: new Set(refToMsg.keys()) },
  );
  const published = await publishPlan(db, job, chat.id, plan, units, refToMsg, first.modelId, { prov: provOf(deps), frontierCandidates: false });
  return { followUps: [...published.followUps, ...(await scheduleLinks(db, chat.workspaceId))], assigned: units.length, escalated: ambiguous.length, rejected: plan.rejected.slice(0, 20) };
}

// --------------------------------------------------------------------------
// Cross-chat links: deterministic bounded candidates, verified by Super.
// --------------------------------------------------------------------------
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'chat', 'general', 'needs', 'review', 'casual', 'links', 'web']);
const tokens = (t: string) =>
  t
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOP.has(w));

export async function scheduleLinks(db: Db, workspaceId: string): Promise<string[]> {
  // Related topics across chats are off unless switched on (CROSS_CHAT_LINKS=1): each check is a
  // Nemotron Super call, and the panel that showed them was dropped as not useful.
  if (process.env.CROSS_CHAT_LINKS !== '1') return [];
  const chats = await db.select().from(s.chats).where(and(eq(s.chats.workspaceId, workspaceId), eq(s.chats.selected, true), eq(s.chats.excluded, false)));
  if (chats.length < 2) return [];
  const versions = chats.map((c) => `${c.id}:${c.graphVersion}`).sort().join(',');
  const anchor = chats.sort((a, b) => a.id.localeCompare(b.id))[0];
  const [job] = await db
    .insert(s.analysisJobs)
    .values({ workspaceId, chatId: anchor.id, kind: 'links', logicalJobId: crypto.randomUUID(), inputFingerprint: sha256(`links|${versions}`), inputMessages: [], pipelineVersion: PIPELINE_VERSION, deletionGeneration: anchor.deletionGeneration, selectionEpoch: anchor.selectionEpoch })
    .onConflictDoNothing()
    .returning({ id: s.analysisJobs.id });
  return job ? [job.id] : [];
}

interface Candidate {
  aChat: string;
  aTopic: string;
  bChat: string;
  bTopic: string;
  type: 'RELATED_TOPIC' | 'SHARED_RESOURCE';
  aMsgs: string[];
  bMsgs: string[];
}

export async function linkCandidates(db: Db | Tx, workspaceId: string, limit = 20): Promise<Candidate[]> {
  const chats = await db.select().from(s.chats).where(and(eq(s.chats.workspaceId, workspaceId), eq(s.chats.selected, true), eq(s.chats.excluded, false)));
  const trees = new Map<string, Tree>();
  for (const c of chats) trees.set(c.id, await loadTree(db, c.id));
  const existing = await db.select({ a: s.crossChatLinks.aTopicId, b: s.crossChatLinks.bTopicId, t: s.crossChatLinks.relationType }).from(s.crossChatLinks).where(eq(s.crossChatLinks.workspaceId, workspaceId));
  const seen = new Set(existing.flatMap((e) => [`${e.a}|${e.b}|${e.t}`, `${e.b}|${e.a}|${e.t}`]));
  const out: Candidate[] = [];

  // Shared canonical URLs → the most specific topic holding each message.
  const shared = await db.execute<{ url: string; chat_a: string; msg_a: string; chat_b: string; msg_b: string }>(sql`
    SELECT ra.canonical_url AS url, ra.chat_id AS chat_a, ra.message_id AS msg_a, rb.chat_id AS chat_b, rb.message_id AS msg_b
    FROM resources ra JOIN resources rb ON ra.canonical_url = rb.canonical_url AND ra.chat_id < rb.chat_id
    WHERE ra.workspace_id = ${workspaceId}::uuid AND rb.workspace_id = ${workspaceId}::uuid AND ra.canonical_url IS NOT NULL
    LIMIT 100`);
  const deepestTopic = async (msgId: string, chatId: string) => {
    const t = trees.get(chatId);
    if (!t) return null;
    const rows = await db.select({ topicId: s.placements.topicId }).from(s.placements).where(eq(s.placements.messageId, msgId));
    const nodes = rows.map((r) => t.nodes.get(r.topicId)).filter((n) => n && n.root !== 'RESOURCES') as { id: string; depth: number }[];
    const all = rows.map((r) => t.nodes.get(r.topicId)).filter(Boolean) as { id: string; depth: number }[];
    const pick = (nodes.length ? nodes : all).sort((a, b) => b.depth - a.depth)[0];
    return pick?.id ?? null;
  };
  for (const r of shared.rows) {
    const a = await deepestTopic(r.msg_a, r.chat_a);
    const b = await deepestTopic(r.msg_b, r.chat_b);
    if (!a || !b || seen.has(`${a}|${b}|SHARED_RESOURCE`)) continue;
    seen.add(`${a}|${b}|SHARED_RESOURCE`);
    out.push({ aChat: r.chat_a, aTopic: a, bChat: r.chat_b, bTopic: b, type: 'SHARED_RESOURCE', aMsgs: [r.msg_a], bMsgs: [r.msg_b] });
  }

  // Title/alias keyword overlap between non-root topics of different chats.
  const list = [...trees.entries()].flatMap(([chatId, t]) =>
    [...t.nodes.values()].filter((n) => n.kind === 'TOPIC' && n.title !== 'Needs review').map((n) => ({ chatId, n, tok: new Set(tokens(n.title)) })),
  );
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const A = list[i];
      const B = list[j];
      if (A.chatId === B.chatId || A.n.root !== B.n.root) continue;
      const inter = [...A.tok].filter((x) => B.tok.has(x)).length;
      const union = new Set([...A.tok, ...B.tok]).size;
      if (!inter || inter / union < 0.5) continue;
      const [a, b] = A.chatId < B.chatId ? [A, B] : [B, A];
      if (seen.has(`${a.n.id}|${b.n.id}|RELATED_TOPIC`)) continue;
      seen.add(`${a.n.id}|${b.n.id}|RELATED_TOPIC`);
      out.push({ aChat: a.chatId, aTopic: a.n.id, bChat: b.chatId, bTopic: b.n.id, type: 'RELATED_TOPIC', aMsgs: [], bMsgs: [] });
    }
  }
  return out.slice(0, limit);
}

async function evidenceFor(db: Db, tree: Tree, topicId: string, preferred: string[], n = 4) {
  const ids = [topicId, ...collectDesc(tree, topicId)];
  const rows = await db.execute<{ id: string; content_revision: number; sender_label: string; sent_at: Date | null; body: string | null; native_id: string }>(sql`
    SELECT DISTINCT m.id, m.content_revision, m.sender_label, m.sent_at, m.body, m.native_id
    FROM placements p JOIN messages m ON m.id = p.message_id
    WHERE p.topic_id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}) AND m.state = 'active'
    ORDER BY m.sent_at DESC NULLS LAST LIMIT 12`);
  const pref = rows.rows.filter((r) => preferred.includes(r.id));
  const rest = rows.rows.filter((r) => !preferred.includes(r.id));
  return [...pref, ...rest].slice(0, n);
}

function collectDesc(tree: Tree, id: string): string[] {
  const out: string[] = [];
  const st = [...(tree.nodes.get(id)?.childIds ?? [])];
  while (st.length) {
    const c = st.pop()!;
    out.push(c);
    st.push(...(tree.nodes.get(c)?.childIds ?? []));
  }
  return out;
}

async function runLinks(deps: PipelineDeps, job: Job): Promise<JobOutcome> {
  const { db } = deps;
  const candidates = await linkCandidates(db, job.workspaceId);
  let verified = 0;
  let rejected = 0;
  for (const c of candidates) {
    const ta = await loadTree(db, c.aChat);
    const tb = await loadTree(db, c.bChat);
    if (!ta.nodes.has(c.aTopic) || !tb.nodes.has(c.bTopic)) continue;
    const ea = await evidenceFor(db, ta, c.aTopic, c.aMsgs);
    const eb = await evidenceFor(db, tb, c.bTopic, c.bMsgs);
    if (!ea.length || !eb.length) continue;
    const [ca] = await db.select({ title: s.chats.title }).from(s.chats).where(eq(s.chats.id, c.aChat));
    const [cb] = await db.select({ title: s.chats.title }).from(s.chats).where(eq(s.chats.id, c.bChat));
    const pa = ancestors(ta, c.aTopic).map((x) => x.title).join(' > ');
    const pb = ancestors(tb, c.bTopic).map((x) => x.title).join(' > ');
    const p = linkPrompt(
      { chat: ca.title, path: pa, evidence: ea.map((m, i) => ({ ref: `a${i + 1}`, sender: m.sender_label, time: m.sent_at ? new Date(m.sent_at).toISOString() : null, text: (m.body ?? '').slice(0, 400) })) },
      { chat: cb.title, path: pb, evidence: eb.map((m, i) => ({ ref: `b${i + 1}`, sender: m.sender_label, time: m.sent_at ? new Date(m.sent_at).toISOString() : null, text: (m.body ?? '').slice(0, 400) })) },
    );
    const hints: FixtureHints | undefined =
      deps.provider.kind === 'fixture'
        ? { refs: Object.fromEntries([...ea.map((m, i) => [`a${i + 1}`, m.native_id]), ...eb.map((m, i) => [`b${i + 1}`, m.native_id])]), topicPaths: { a: topicPathKey(ta, c.aTopic), b: topicPathKey(tb, c.bTopic) } }
        : undefined;
    const res = await callModel(deps, { workspaceId: job.workspaceId, logicalJobId: job.logicalJobId, jobId: job.id }, { role: 'balanced', operation: 'link', ...p, schema: LinkVerdictSchema, schemaName: 'link', jsonSchema: JSON_SCHEMAS.link, hints });
    const v = res.value;
    const aEv = v.a_evidence_refs.map((r) => ea[Number(r.slice(1)) - 1]).filter(Boolean);
    const bEv = v.b_evidence_refs.map((r) => eb[Number(r.slice(1)) - 1]).filter(Boolean);
    const ok = v.related && v.relation_type !== null && aEv.length > 0 && bEv.length > 0;
    await db
      .insert(s.crossChatLinks)
      .values({
        workspaceId: job.workspaceId,
        aChatId: c.aChat,
        aTopicId: c.aTopic,
        bChatId: c.bChat,
        bTopicId: c.bTopic,
        relationType: ok ? v.relation_type! : c.type,
        reason: v.reason.slice(0, 300) || (ok ? 'Related' : 'Not related'),
        aEvidence: aEv.map((m) => ({ messageId: m.id, revision: m.content_revision })),
        bEvidence: bEv.map((m) => ({ messageId: m.id, revision: m.content_revision })),
        status: ok ? 'verified' : 'rejected',
        verifierModel: res.modelId,
      })
      .onConflictDoNothing();
    if (ok) verified++;
    else rejected++;
  }
  await notifyChange(db, { ws: job.workspaceId, kind: 'graph' });
  return { status: 'completed', followUps: [], detail: { candidates: candidates.length, verified, rejected } };
}

// --------------------------------------------------------------------------
// Reshaping a built map: the first taxonomy sees only a slice of a long chat and
// later units are added side by side, which leaves wide, shallow levels. Once the
// backlog is placed, related siblings get a common parent (Super) and crowded
// topics are split further (refinement, recursively).
// --------------------------------------------------------------------------
const REGROUP_MIN_CHILDREN = 6;
const REGROUP_MAX_PARENTS = 6;
const REGROUP_MAX_PASSES = 3;
const OTHER_TOPICS = 'Other topics';
const SPLIT_MAX_TOPICS = 12;
const COLLAPSE_MAX_PASSES = 20;
const SPLIT_MAX_UNITS = 80;
const DEEPEN_MIN_UNITS = 6;
const DEEPEN_MAX_TOPICS = 12;
const DEEPEN_MAX_DEPTH = 8;

async function reshapeTree(deps: PipelineDeps, job: Job, chat: Chat): Promise<{ followUps: string[]; detail: Record<string, unknown> }> {
  let regrouped = 0;
  let split = 0;
  try {
    // One subject per topic first, so grouping works with clean titles.
    split = await splitCompoundTopics(deps, job, chat);
    await collapseRedundantLevels(deps.db, chat);
    regrouped = await regroupTopics(deps, job, chat);
  } catch (e) {
    // A failed tidy-up must not undo a built map.
    if (e instanceof BudgetExceededError) throw e;
    regrouped = -1;
  }
  // Grouping can leave a chain of single-subtopic levels; merging them can widen a level again.
  const collapsed = await collapseRedundantLevels(deps.db, chat);
  await capLevels(deps.db, chat);
  const followUps = await scheduleDeepening(deps.db, job, chat.id);
  return { followUps, detail: { split, regrouped, collapsed, deepening: followUps.length } };
}

/**
 * After topics were added: drop levels that add nothing, then bring any level
 * back to MAX_CHILD_TOPICS (no model call when none is over).
 */
async function keepLevelsReadable(deps: PipelineDeps, job: Job, chat: Chat): Promise<number> {
  await collapseRedundantLevels(deps.db, chat);
  if (!overfull(await loadTree(deps.db, chat.id)).length) return 0;
  try {
    const moved = await regroupTopics(deps, job, chat, { tidy: false });
    await collapseRedundantLevels(deps.db, chat);
    await capLevels(deps.db, chat);
    return moved;
  } catch (e) {
    if (e instanceof BudgetExceededError) throw e;
    return -1;
  }
}

/** "Academic and Career Guidance", "Cloud & Hosting": a title that joins subjects. */
const COMPOUND_TITLE = /\s(?:and|&)\s/i;

function compoundTopics(tree: Tree, locked: Set<string>): TreeNode[] {
  return [...tree.nodes.values()].filter((n) => n.kind === 'TOPIC' && !n.needsReview && !locked.has(n.id) && n.title !== OTHER_TOPICS && COMPOUND_TITLE.test(n.title));
}

/**
 * Whether the chat's map breaks a readability rule: a level over
 * MAX_CHILD_TOPICS, a topic joining subjects, or a level repeating its parent.
 */
export async function mapNeedsTidy(db: Db, chatId: string): Promise<boolean> {
  const tree = await loadTree(db, chatId);
  const repeats = [...tree.nodes.values()].some((n) => n.kind === 'TOPIC' && !n.needsReview && n.parentId && sameSubject(n.title, tree.nodes.get(n.parentId)!.title));
  if (repeats || overfull(tree).length > 0 || compoundTopics(tree, await lockedTopicIds(db, chatId)).length > 0) return true;
  // Messages read before filler screening existed still need screening.
  return (await db.execute(sql`${unscreenedSql(chatId)} LIMIT 1`)).rows.length > 0;
}

/**
 * One subject per topic: "Academic and Career Guidance" becomes "Academic" and
 * "Career" side by side, its subtopics and discussions shared out between them
 * (e.g. "Academic > Academic guidance"). Super decides the parts; a title that
 * names one subject ("Research and Development") is left alone. The old topic is
 * retired into the first part, like a merge, so links and filters follow it.
 * Returns how many topics were split.
 */
export async function splitCompoundTopics(deps: PipelineDeps, job: Job, chat: Chat): Promise<number> {
  const { db } = deps;
  const tree = await loadTree(db, chat.id);
  const locked = await lockedTopicIds(db, chat.id);
  const todo = compoundTopics(tree, locked)
    .filter((n) => n.parentId)
    .slice(0, SPLIT_MAX_TOPICS);
  let split = 0;
  for (const t of todo) {
    const lockedHere = await db.execute(sql`SELECT 1 FROM placements WHERE topic_id = ${t.id}::uuid AND locked LIMIT 1`);
    if (lockedHere.rows.length) continue; // the owner pinned messages here
    const kids = t.childIds.map((c) => tree.nodes.get(c)!).filter((k) => k.kind === 'TOPIC');
    const units = await db.select().from(s.analysisUnits).where(eq(s.analysisUnits.assignedTopicId, t.id));
    const childKey = new Map(kids.map((k, i) => [`c${i + 1}`, k]));
    const unitKey = new Map(units.slice(0, SPLIT_MAX_UNITS).map((u, i) => [`u${i + 1}`, u]));
    const parentPath = ancestors(tree, t.parentId!).map((a) => a.title).join(' > ');
    const p = splitPrompt(
      chat.title,
      parentPath,
      t.title,
      [...childKey].map(([key, k]) => ({ key, title: k.title })),
      [...unitKey].map(([key, u]) => ({ key, title: (u.summaryBullets as { title: string }).title })),
    );
    const r = await callModel(deps, { workspaceId: job.workspaceId, logicalJobId: job.logicalJobId, jobId: job.id }, { role: 'balanced', operation: 'split', ...p, schema: SplitSchema, schemaName: 'split', jsonSchema: JSON_SCHEMAS.split, maxOutputTokens: 2000 });
    const parts = r.value.parts.filter((x) => isTopicTitle(x.title) && !COMPOUND_TITLE.test(x.title));
    if (parts.length < 2) continue;
    // Anything the model left out goes to the part whose words it shares, else the first.
    const words = (x: string) => new Set(x.toLocaleLowerCase('und').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
    const closest = (title: string) => {
      const w = words(title);
      let best = 0;
      let bestScore = 0;
      parts.forEach((pt, i) => {
        const score = [...words(`${pt.title} ${pt.unit_subtopic ?? ''}`)].filter((x) => w.has(x)).length;
        if (score > bestScore) [best, bestScore] = [i, score];
      });
      return best;
    };
    const childPart = new Map<string, number>();
    const unitPart = new Map<string, number>();
    parts.forEach((pt, i) => {
      for (const c of pt.children) if (childKey.has(c) && !childPart.has(childKey.get(c)!.id)) childPart.set(childKey.get(c)!.id, i);
      for (const u of pt.units) if (unitKey.has(u) && !unitPart.has(unitKey.get(u)!.id)) unitPart.set(unitKey.get(u)!.id, i);
    });
    for (const k of kids) if (!childPart.has(k.id)) childPart.set(k.id, closest(k.title));
    for (const u of units) if (!unitPart.has(u.id)) unitPart.set(u.id, closest((u.summaryBullets as { title: string }).title));

    const norm = (x: string) => x.trim().toLocaleLowerCase('und');
    await db.transaction(async (tx) => {
      const current = await lockChat(tx, chat.id);
      const live = await loadTree(tx, chat.id);
      const node = live.nodes.get(t.id);
      if (!node || node.parentId !== t.parentId) return;
      const siblings = live.nodes.get(t.parentId!)!.childIds.map((c) => live.nodes.get(c)!);
      const newTopic = async (parentId: string, title: string) =>
        (await tx.insert(s.topics).values({ workspaceId: chat.workspaceId, chatId: chat.id, root: t.root, kind: 'TOPIC', parentId, title: title.trim().slice(0, 80), provenance: 'model', taxonomyVersion: current.taxonomyVersion }).returning({ id: s.topics.id }))[0].id;
      // Each part reuses a sibling of the same name ("Career" may already exist) or is created beside the old topic.
      const partIds: string[] = [];
      const holderIds: string[] = [];
      for (const pt of parts) {
        const same = siblings.find((x) => x.id !== t.id && norm(x.title) === norm(pt.title));
        const id = same?.id ?? (await newTopic(t.parentId!, pt.title));
        partIds.push(id);
        // Discussions sit one level down when the model named a narrower topic for them ("Academic guidance").
        const sub = pt.unit_subtopic?.trim();
        const hasUnits = units.some((u) => unitPart.get(u.id) === partIds.length - 1);
        if (sub && hasUnits && norm(sub) !== norm(pt.title)) {
          const existing = same ? live.nodes.get(same.id)!.childIds.map((c) => live.nodes.get(c)!).find((x) => norm(x.title) === norm(sub)) : undefined;
          holderIds.push(existing?.id ?? (await newTopic(id, sub)));
        } else holderIds.push(id);
      }
      for (const k of kids) await tx.update(s.topics).set({ parentId: partIds[childPart.get(k.id)!], updatedAt: new Date() }).where(and(eq(s.topics.id, k.id), eq(s.topics.parentId, t.id)));
      for (const u of units) {
        const to = holderIds[unitPart.get(u.id)!];
        await tx.update(s.analysisUnits).set({ assignedTopicId: to }).where(eq(s.analysisUnits.id, u.id));
        const [disc] = await tx.select().from(s.discussions).where(and(eq(s.discussions.chatId, chat.id), eq(s.discussions.unitKey, u.id)));
        if (!disc) continue;
        await tx.update(s.discussions).set({ topicId: to, taxonomyVersion: current.taxonomyVersion }).where(eq(s.discussions.id, disc.id));
        await tx.execute(sql`
          UPDATE placements SET topic_id = ${to}::uuid WHERE discussion_id = ${disc.id}::uuid AND topic_id = ${t.id}::uuid
            AND NOT EXISTS (SELECT 1 FROM placements p2 WHERE p2.topic_id = ${to}::uuid AND p2.message_id = placements.message_id)`);
      }
      // Remaining placements (e.g. shared files) go to the first part; then the old topic retires into it.
      await retireTopicInto(tx, chat.id, t.id, partIds[0]);
      const [g] = await tx.update(s.chats).set({ graphVersion: sql`${s.chats.graphVersion} + 1` }).where(eq(s.chats.id, chat.id)).returning({ v: s.chats.graphVersion });
      await notifyChange(tx, { ws: chat.workspaceId, kind: 'graph', chatId: chat.id, version: g.v });
      split++;
    });
  }
  return split;
}

/**
 * Retire topic `fromId` into `toId`: its messages, discussions, units and
 * subtopics move to `toId`, links and saved references follow it (like a manual
 * merge). Runs inside the caller's transaction.
 */
async function retireTopicInto(tx: Tx, chatId: string, fromId: string, toId: string) {
  await tx.execute(sql`
    INSERT INTO placements (workspace_id, chat_id, message_id, topic_id, discussion_id, is_primary, provenance, locked, analyzed_revision, taxonomy_version)
    SELECT workspace_id, chat_id, message_id, ${toId}::uuid, discussion_id, is_primary, provenance, locked, analyzed_revision, taxonomy_version
    FROM placements WHERE topic_id = ${fromId}::uuid
    ON CONFLICT (topic_id, message_id) DO NOTHING`);
  await tx.delete(s.placements).where(eq(s.placements.topicId, fromId));
  await tx.update(s.discussions).set({ topicId: toId }).where(eq(s.discussions.topicId, fromId));
  await tx.update(s.analysisUnits).set({ assignedTopicId: toId }).where(eq(s.analysisUnits.assignedTopicId, fromId));
  await tx.update(s.topics).set({ parentId: toId, updatedAt: new Date() }).where(and(eq(s.topics.parentId, fromId), isNull(s.topics.retiredInto)));
  await tx.update(s.topics).set({ retiredInto: toId, updatedAt: new Date() }).where(eq(s.topics.id, fromId));
  await tx.update(s.topicMergeMap).set({ survivingId: toId }).where(eq(s.topicMergeMap.survivingId, fromId));
  await tx.insert(s.topicMergeMap).values({ retiredId: fromId, survivingId: toId, chatId });
  await tx.update(s.userChatViewPreferences).set({ focusNodeId: toId }).where(eq(s.userChatViewPreferences.focusNodeId, fromId));
  await tx.execute(sql`UPDATE cross_chat_links SET a_topic_id = ${toId}::uuid WHERE a_topic_id = ${fromId}::uuid
    AND NOT EXISTS (SELECT 1 FROM cross_chat_links x WHERE x.a_topic_id = ${toId}::uuid AND x.b_topic_id = cross_chat_links.b_topic_id AND x.relation_type = cross_chat_links.relation_type)`);
  await tx.execute(sql`UPDATE cross_chat_links SET b_topic_id = ${toId}::uuid WHERE b_topic_id = ${fromId}::uuid
    AND NOT EXISTS (SELECT 1 FROM cross_chat_links x WHERE x.b_topic_id = ${toId}::uuid AND x.a_topic_id = cross_chat_links.a_topic_id AND x.relation_type = cross_chat_links.relation_type)`);
  await tx.delete(s.crossChatLinks).where(sql`${s.crossChatLinks.aTopicId} = ${fromId}::uuid OR ${s.crossChatLinks.bTopicId} = ${fromId}::uuid`);
}

/**
 * Removes levels that add nothing: a topic titled like its parent merges into
 * the parent, and a topic with no messages of its own whose single subtopic is
 * on the same subject is replaced by that subtopic. Repeated grouping and refinement otherwise stack
 * chains like "Software Development > Development > Software Development".
 * Returns how many levels were removed.
 */
export async function collapseRedundantLevels(db: Db, chat: Chat): Promise<number> {
  let removed = 0;
  for (let pass = 0; pass < COLLAPSE_MAX_PASSES; pass++) {
    const tree = await loadTree(db, chat.id);
    const locked = await lockedTopicIds(db, chat.id);
    const holding = new Set(
      (await db.execute<{ id: string }>(sql`SELECT DISTINCT topic_id AS id FROM placements WHERE chat_id = ${chat.id}::uuid
        UNION SELECT DISTINCT assigned_topic_id FROM analysis_units WHERE chat_id = ${chat.id}::uuid AND assigned_topic_id IS NOT NULL`)).rows.map((r) => r.id),
    );
    const plans: { from: string; to: string; lift?: string }[] = [];
    const touched = new Set<string>();
    for (const n of tree.nodes.values()) {
      if (n.kind !== 'TOPIC' || n.needsReview || !n.parentId || locked.has(n.id) || touched.has(n.id)) continue;
      const parent = tree.nodes.get(n.parentId)!;
      if (touched.has(parent.id)) continue;
      // Also a copy of a category root ("Knowledge Root" under Knowledge): it folds into the root.
      if (sameSubject(n.title, parent.title)) {
        // "Software Development" under "Software Development": one level is enough.
        plans.push({ from: n.id, to: parent.id });
        touched.add(n.id).add(parent.id);
        continue;
      }
      const kids = n.childIds.map((c) => tree.nodes.get(c)!);
      const only = kids.length === 1 ? kids[0] : null;
      // An empty topic whose only content is one subtopic on the same subject ("Development Tools &
      // Practices" > "Testing & Development Tools"): the subtopic takes its place. A distinct
      // narrowing ("Tips" > "Algorithms") stays.
      if (only && only.kind === 'TOPIC' && !only.needsReview && !holding.has(n.id) && !locked.has(only.id) && !touched.has(only.id) && overlappingSubject(n.title, only.title)) {
        plans.push({ from: n.id, to: only.id, lift: n.parentId });
        touched.add(n.id).add(only.id).add(parent.id);
      }
    }
    if (!plans.length) break;
    await db.transaction(async (tx) => {
      await lockChat(tx, chat.id);
      for (const p of plans) {
        if (p.lift) await tx.update(s.topics).set({ parentId: p.lift, updatedAt: new Date() }).where(and(eq(s.topics.id, p.to), eq(s.topics.parentId, p.from)));
        await retireTopicInto(tx, chat.id, p.from, p.to);
      }
      const [g] = await tx.update(s.chats).set({ graphVersion: sql`${s.chats.graphVersion} + 1` }).where(eq(s.chats.id, chat.id)).returning({ v: s.chats.graphVersion });
      await notifyChange(tx, { ws: chat.workspaceId, kind: 'graph', chatId: chat.id, version: g.v });
    });
    removed += plans.length;
  }
  return removed;
}

/** Child topics of a node that may be grouped (Needs review stays put). */
function groupable(tree: Tree, n: TreeNode): TreeNode[] {
  return n.childIds.map((c) => tree.nodes.get(c)!).filter((k) => k.kind === 'TOPIC' && !k.needsReview);
}

/** Nodes showing more than MAX_CHILD_TOPICS children, widest first. */
function overfull(tree: Tree) {
  return [...tree.nodes.values()]
    .map((n) => ({ n, kids: groupable(tree, n) }))
    .filter((x) => x.n.childIds.length > MAX_CHILD_TOPICS && x.kids.length >= 2)
    .sort((a, b) => b.kids.length - a.kids.length);
}

/**
 * Keeps every level readable: groups sibling topics that share a broader subject
 * under one parent, and brings any level over MAX_CHILD_TOPICS back under the
 * limit. With `tidy`, levels of REGROUP_MIN_CHILDREN or more are also offered for
 * grouping. Returns how many topics moved.
 */
export async function regroupTopics(deps: PipelineDeps, job: Job, chat: Chat, opts: { tidy?: boolean } = { tidy: true }): Promise<number> {
  let moved = 0;
  for (let pass = 0; pass < REGROUP_MAX_PASSES; pass++) {
    const m = await regroupPass(deps, job, chat, Boolean(opts.tidy) && pass === 0);
    moved += m;
    if (!m || !overfull(await loadTree(deps.db, chat.id)).length) break;
  }
  return moved + (await capLevels(deps.db, chat));
}

async function regroupPass(deps: PipelineDeps, job: Job, chat: Chat, tidy: boolean): Promise<number> {
  const { db } = deps;
  const tree = await loadTree(db, chat.id);
  const locked = await lockedTopicIds(db, chat.id);
  const over = overfull(tree);
  const overIds = new Set(over.map((x) => x.n.id));
  const extra = tidy
    ? [...tree.nodes.values()]
        .filter((n) => !overIds.has(n.id))
        .map((n) => ({ n, kids: groupable(tree, n) }))
        .filter((x) => x.kids.length >= REGROUP_MIN_CHILDREN)
        .sort((a, b) => b.kids.length - a.kids.length)
        .slice(0, REGROUP_MAX_PARENTS)
    : [];
  const crowded = [...over, ...extra];
  if (!crowded.length) return 0;
  const counts = new Map(
    (await db.execute<{ id: string; n: number }>(sql`SELECT assigned_topic_id AS id, count(*)::int AS n FROM analysis_units WHERE chat_id = ${chat.id}::uuid AND assigned_topic_id IS NOT NULL GROUP BY 1`)).rows.map((r) => [r.id, r.n]),
  );
  const examples = new Map<string, string[]>();
  for (const d of await db.select({ topicId: s.discussions.topicId, title: s.discussions.title }).from(s.discussions).where(eq(s.discussions.chatId, chat.id))) {
    if (!d.topicId) continue;
    const list = examples.get(d.topicId) ?? [];
    if (list.length < 3) examples.set(d.topicId, [...list, d.title]);
  }
  const norm = (t: string) => t.trim().toLocaleLowerCase('und');
  let moved = 0;
  for (const { n, kids } of crowded) {
    const keyOf = new Map(kids.map((k, i) => [`c${i + 1}`, k]));
    const parentPath = ancestors(tree, n.id).map((a) => a.title).join(' > ');
    // Needs review also takes room on the level.
    const max = Math.max(2, MAX_CHILD_TOPICS - (n.childIds.length - kids.length));
    const p = regroupPrompt(chat.title, parentPath, [...keyOf].map(([key, k]) => ({ key, title: k.title, units: counts.get(k.id) ?? 0, examples: examples.get(k.id) ?? [] })), max);
    const r = await callModel(deps, { workspaceId: job.workspaceId, logicalJobId: job.logicalJobId, jobId: job.id }, { role: 'balanced', operation: 'regroup', ...p, schema: RegroupSchema, schemaName: 'regroup', jsonSchema: JSON_SCHEMAS.regroup, maxOutputTokens: 4000 });
    const used = new Set<string>();
    const plans: GroupPlan[] = [];
    for (const g of r.value.groups) {
      // An existing sibling with the group's title becomes the parent ("Hackathon" absorbs its projects).
      if (!isTopicTitle(g.title) || sameSubject(g.title, n.title)) continue;
      const into = kids.find((k) => norm(k.title) === norm(g.title)) ?? null;
      if (into && used.has(into.id)) continue;
      const movers = [...new Set(g.children)].map((c) => keyOf.get(c)).filter((k): k is TreeNode => Boolean(k) && k!.id !== into?.id && !used.has(k!.id) && !locked.has(k!.id));
      // Worth a level: two or more topics move, and not the whole level at once.
      if (movers.length < (into ? 1 : 2) || movers.length + (into ? 1 : 0) >= kids.length) continue;
      for (const m of movers) used.add(m.id);
      if (into) used.add(into.id);
      plans.push({ title: g.title.trim(), into, movers });
    }
    if (plans.length) moved += await moveUnder(db, chat, n, plans);
  }
  return moved;
}

interface GroupPlan {
  title: string;
  into: TreeNode | null;
  movers: TreeNode[];
}

/** Moves each plan's topics under its existing sibling (`into`) or a new topic titled `title`. */
async function moveUnder(db: Db, chat: Chat, n: TreeNode, plans: GroupPlan[]): Promise<number> {
  return db.transaction(async (tx) => {
    const current = await lockChat(tx, chat.id);
    let moved = 0;
    for (const pl of plans) {
      const parentId =
        pl.into?.id ??
        (await tx.insert(s.topics).values({ workspaceId: chat.workspaceId, chatId: chat.id, root: n.root, kind: 'TOPIC', parentId: n.id, title: pl.title, provenance: 'model', taxonomyVersion: current.taxonomyVersion }).returning({ id: s.topics.id }))[0].id;
      const r2 = await tx
        .update(s.topics)
        .set({ parentId, updatedAt: new Date() })
        .where(and(inArray(s.topics.id, pl.movers.map((m) => m.id)), eq(s.topics.parentId, n.id), eq(s.topics.parentLocked, false)))
        .returning({ id: s.topics.id });
      moved += r2.length;
    }
    const [g] = await tx.update(s.chats).set({ graphVersion: sql`${s.chats.graphVersion} + 1` }).where(eq(s.chats.id, chat.id)).returning({ v: s.chats.graphVersion });
    await notifyChange(tx, { ws: chat.workspaceId, kind: 'graph', chatId: chat.id, version: g.v });
    return moved;
  });
}

/**
 * Last resort when the model leaves a level too wide: the biggest topics stay,
 * the rest move under "Other topics" on that level.
 */
async function capLevels(db: Db, chat: Chat): Promise<number> {
  let moved = 0;
  for (let i = 0; i < REGROUP_MAX_PASSES; i++) {
    const tree = await loadTree(db, chat.id);
    const over = overfull(tree);
    if (!over.length) break;
    const locked = await lockedTopicIds(db, chat.id);
    const direct = new Map(
      (await db.execute<{ id: string; n: number }>(sql`SELECT topic_id AS id, count(DISTINCT message_id)::int AS n FROM placements WHERE chat_id = ${chat.id}::uuid GROUP BY 1`)).rows.map((r) => [r.id, r.n]),
    );
    const size = (id: string): number => (direct.get(id) ?? 0) + tree.nodes.get(id)!.childIds.reduce((a, c) => a + size(c), 0);
    let round = 0;
    for (const { n, kids } of over) {
      const other = kids.find((k) => k.title === OTHER_TOPICS) ?? null;
      // Room left on the level once Needs review and "Other topics" are counted.
      const keep = Math.max(1, MAX_CHILD_TOPICS - (n.childIds.length - kids.length) - 1);
      const movers = kids
        .filter((k) => k.id !== other?.id && !locked.has(k.id))
        .sort((a, b) => size(b.id) - size(a.id))
        .slice(keep);
      if (movers.length < (other ? 1 : 2)) continue;
      round += await moveUnder(db, chat, n, [{ title: OTHER_TOPICS, into: other, movers }]);
    }
    if (!round) break;
    moved += round;
  }
  return moved;
}

/** Queues refinement for topics that still hold many discussions directly. */
export async function scheduleDeepening(db: Db, job: Job, chatId: string): Promise<string[]> {
  const tree = await loadTree(db, chatId);
  const crowded = await db.execute<{ topic_id: string; n: number }>(sql`
    SELECT u.assigned_topic_id AS topic_id, count(*)::int AS n FROM analysis_units u JOIN topics t ON t.id = u.assigned_topic_id
    WHERE u.chat_id = ${chatId}::uuid AND t.kind IN ('TOPIC', 'CATEGORY') AND NOT t.needs_review AND t.retired_into IS NULL
    GROUP BY 1 HAVING count(*) >= ${DEEPEN_MIN_UNITS} ORDER BY 2 DESC`);
  const out: string[] = [];
  for (const r of crowded.rows) {
    if (out.length >= DEEPEN_MAX_TOPICS) break;
    const node = tree.nodes.get(r.topic_id);
    if (!node || node.depth >= DEEPEN_MAX_DEPTH) continue;
    const [last] = await db.select().from(s.taxonomyFrontiers).where(eq(s.taxonomyFrontiers.parentTopicId, r.topic_id)).orderBy(desc(s.taxonomyFrontiers.createdAt)).limit(1);
    if (last && last.status !== 'completed' && last.status !== 'failed') continue; // already queued or paused
    const prev = (last?.checkpoint ?? {}) as { newTopics?: number; units?: number };
    // Refined before without a useful split, and not much has been added since.
    if (last?.status === 'completed' && !prev.newTopics && (prev.units ?? 0) * 1.5 > r.n) continue;
    if (last?.status === 'failed' && last.createdAt > new Date(Date.now() - 60 * 60_000)) continue;
    const units = await db.select({ refs: s.analysisUnits.messageRefs }).from(s.analysisUnits).where(eq(s.analysisUnits.assignedTopicId, r.topic_id));
    const refs = units.flatMap((u) => u.refs);
    const [chat] = await db.select().from(s.chats).where(eq(s.chats.id, chatId));
    // Each refinement gets its own ledger, so a deep map is not cut short by one job's call cap.
    const logicalJobId = crypto.randomUUID();
    const [fr] = await db
      .insert(s.taxonomyFrontiers)
      .values({ workspaceId: chat.workspaceId, chatId, logicalJobId, parentTopicId: r.topic_id, inputMessages: refs, checkpoint: { deepen: true } })
      .onConflictDoNothing()
      .returning({ id: s.taxonomyFrontiers.id });
    if (!fr) continue;
    const [rj] = await db
      .insert(s.analysisJobs)
      .values({ workspaceId: chat.workspaceId, chatId, kind: 'refine', logicalJobId, inputFingerprint: sha256(`refine|${fr.id}`), inputMessages: refs, pipelineVersion: PIPELINE_VERSION, deletionGeneration: chat.deletionGeneration, selectionEpoch: chat.selectionEpoch, result: { frontierId: fr.id } })
      .returning({ id: s.analysisJobs.id });
    out.push(rj.id);
  }
  void job;
  return out;
}

export { ROOT_LABELS };
