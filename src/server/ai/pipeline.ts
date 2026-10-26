// Durable analysis pipeline. Jobs are rows in analysis_jobs executed by the
// pg-boss worker; every model output is validated and published atomically,
// with generation/revision checks so stale work cannot overwrite newer state.
import crypto from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import * as s from '../../db/schema';
import type { LlmConfig } from '../../lib/config';
import type { Db, Tx } from '../db';
import { ancestors, loadTree, lockChat, ROOT_LABELS, type RootEnum, type Tree } from '../graph/tree';
import { notifyChange } from '../notify';
import { sha256 } from '../util';
import { assignmentPrompt, extractionPrompt, linkPrompt, refinementPrompt, taxonomyPrompt, type PromptMessage, type TreeDigestNode, type UnitDigest } from './prompts';
import type { FixtureHints } from './provider';
import { BudgetExceededError, callModel, ensureLedger, estimateTokens, InvalidOutputError, type RouterDeps } from './router';
import { AssignmentSchema, ExtractionSchema, JSON_SCHEMAS, LinkVerdictSchema, PIPELINE_VERSION, TaxonomySchema } from './schemas';
import { validateTaxonomy, type UnitInfo } from './taxonomy';

export interface PipelineDeps extends RouterDeps {
  cfg: LlmConfig;
}

type Job = typeof s.analysisJobs.$inferSelect;
type MsgRef = { m: string; r: number };

const SUGGESTED_KNOWLEDGE = 'Programming, Music, Art, History';
const REFINE_MIN_UNITS = 2;
const MAX_TAXONOMY_UNITS_PER_CALL = 90;
const MAX_QUOTED_PER_CHUNK = 20;
const ROOT_SHORT: Record<RootEnum, string> = { KNOWLEDGE: 'K', GENERAL_CHAT: 'G', RESOURCES: 'R' };

export const fingerprintOf = (kind: string, refs: MsgRef[], extra = '') =>
  sha256(`${PIPELINE_VERSION}|${kind}|${extra}|${[...refs].sort((a, b) => (a.m < b.m ? -1 : 1)).map((x) => `${x.m}:${x.r}`).join(',')}`);

// --------------------------------------------------------------------------
// Dispatch: coalesce committed outbox rows into bounded microbatch jobs.
// --------------------------------------------------------------------------
export async function dispatchOutbox(db: Db, cfg: LlmConfig, opts: { force?: boolean } = {}): Promise<string[]> {
  const pending = await db.execute<{ chat_id: string; n: number; oldest: Date }>(sql`
    SELECT chat_id, count(*)::int AS n, min(created_at) AS oldest FROM analysis_outbox
    WHERE dispatched_job_id IS NULL GROUP BY chat_id`);
  const created: string[] = [];
  for (const p of pending.rows) {
    const ready = opts.force || p.n >= cfg.LLM_MICROBATCH_MAX_MESSAGES || Date.now() - new Date(p.oldest).getTime() >= cfg.LLM_MICROBATCH_MAX_WAIT_MS;
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

async function currentChat(db: Db | Tx, job: Job) {
  const [chat] = await db.select().from(s.chats).where(eq(s.chats.id, job.chatId));
  if (!chat || !chat.selected || chat.excluded || chat.deletionGeneration !== job.deletionGeneration) return null;
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
}

type MessageRow = { id: string; content_revision: number; sender_label: string; sent_at: Date | null; body: string | null; native_id: string; reply_to_native_id: string | null };
const contextMessage = (r: MessageRow): LoadedMessage => ({ id: r.id, rev: r.content_revision, sender: r.sender_label, sentAt: r.sent_at ? new Date(r.sent_at) : null, body: r.body, files: [], urls: [], nativeId: r.native_id, replyTo: r.reply_to_native_id });

async function loadCurrent(db: Db | Tx, refs: MsgRef[]): Promise<LoadedMessage[]> {
  if (!refs.length) return [];
  const rows = await db.execute<MessageRow & { files: string[]; urls: string[] }>(sql`
    SELECT m.id, m.content_revision, m.sender_label, m.sent_at, m.body, m.native_id, m.reply_to_native_id,
      ARRAY(SELECT COALESCE(a.filename, a.media_type) FROM attachments a WHERE a.message_id = m.id) AS files,
      ARRAY(SELECT r.url FROM resources r WHERE r.message_id = m.id AND r.kind = 'url') AS urls
    FROM messages m
    WHERE m.id IN (${sql.join(refs.map((r) => sql`${r.m}::uuid`), sql`, `)})
      AND m.state = 'active' AND m.kind IN ('text','media') AND (m.expires_at IS NULL OR m.expires_at > now())
    ORDER BY m.sent_at NULLS LAST, m.id`);
  const want = new Map(refs.map((r) => [r.m, r.r]));
  // A newer revision has its own outbox entry; skip stale revisions here.
  return rows.rows
    .filter((r) => want.get(r.id) === r.content_revision)
    .map((r) => ({ ...contextMessage(r), files: r.files, urls: r.urls }));
}

const promptText = (m: LoadedMessage, limit = 1200) => {
  const b = m.body ?? '';
  return b.length > limit ? `${b.slice(0, limit)} [truncated]` : b;
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
  const units: { unitKey: string; primaryRoot: RootEnum; title: string; terms: string[]; refs: MsgRef[]; bullets: { text: string; evidence: MsgRef[] }[]; resources: string[]; needsReview: boolean }[] = [];
  for (const chunk of chunks) {
    const context = await precedingContext(db, chat.id, chunk[0], 10);
    // A reply is read with the message it quotes, even when that message is
    // far outside the chunk and its preceding window.
    const nearby = new Set([...chunk, ...context].map((m) => m.nativeId));
    const quoted = await quotedMessages(db, chat.id, [...new Set(chunk.map((m) => m.replyTo).filter((n): n is string => !!n && !nearby.has(n)))].slice(0, MAX_QUOTED_PER_CHUNK));
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
  });

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
async function replyTopicsFor(db: Db | Tx, chatId: string, units: UnitRow[], tree: Tree): Promise<Map<string, string[]>> {
  const ids = [...new Set(units.flatMap((u) => u.messageRefs.map((r) => r.m)))];
  if (!ids.length) return new Map();
  const rows = await db.execute<{ message_id: string; topic_id: string }>(sql`
    SELECT DISTINCT r.id AS message_id, p.topic_id FROM messages r
    JOIN messages q ON q.chat_id = r.chat_id AND q.native_id = r.reply_to_native_id AND q.state = 'active'
    JOIN placements p ON p.message_id = q.id AND p.is_primary
    WHERE r.chat_id = ${chatId}::uuid AND r.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`);
  const byMsg = new Map<string, string[]>();
  for (const r of rows.rows) byMsg.set(r.message_id, [...(byMsg.get(r.message_id) ?? []), r.topic_id]);
  return new Map(units.map((u) => [u.id, [...new Set(u.messageRefs.flatMap((r) => byMsg.get(r.m) ?? []))].filter((t) => tree.nodes.get(t)?.root === u.primaryRoot)]));
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
    if (busy.rows.length || outbox.rows.length) return null;
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
  const [job] = await db
    .insert(s.analysisJobs)
    .values({ workspaceId: chat.workspaceId, chatId, kind: 'rebuild', logicalJobId: crypto.randomUUID(), inputFingerprint: sha256(`rebuild|manual|${Date.now()}|${crypto.randomUUID()}`), inputMessages: [], pipelineVersion: PIPELINE_VERSION, deletionGeneration: chat.deletionGeneration, selectionEpoch: chat.selectionEpoch })
    .returning({ id: s.analysisJobs.id });
  return job.id;
}

type UnitRow = typeof s.analysisUnits.$inferSelect;

function topicPathKey(tree: Tree, id: string): string {
  const chain = ancestors(tree, id);
  return [ROOT_SHORT[chain[0].root], ...chain.slice(1).map((n) => n.title)].join('/');
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

function digestUnit(u: UnitRow, sampleOf: Map<string, string>, refOf: Map<string, string>): UnitDigest {
  const meta = u.summaryBullets as { title: string };
  return {
    unit_key: u.id,
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
// Initial/explicit taxonomy (Ultra)
// --------------------------------------------------------------------------
async function runRebuild(deps: PipelineDeps, job: Job, chat: Chat): Promise<JobOutcome> {
  const { db } = deps;
  const all = await db.select().from(s.analysisUnits).where(and(eq(s.analysisUnits.chatId, chat.id), isNull(s.analysisUnits.assignedTopicId)));
  if (!all.length) return { status: 'completed', followUps: [], detail: { units: 0 } };
  const batch = all.slice(0, MAX_TAXONOMY_UNITS_PER_CALL);
  const tree = await loadTree(db, chat.id);
  const locked = await lockedTopicIds(db, chat.id);
  const { sample, native, refOf } = await sampleTexts(db, batch);
  const digests = batch.map((u) => digestUnit(u, sample, refOf));
  const p = taxonomyPrompt(chat.title, digests, treeDigest(tree, locked), SUGGESTED_KNOWLEDGE);
  const hints = deps.provider.kind === 'fixture' ? fixtureHints(tree, batch, native, refOf) : undefined;
  const res = await callModel(deps, { workspaceId: job.workspaceId, logicalJobId: job.logicalJobId, jobId: job.id }, {
    role: 'reasoning',
    operation: 'taxonomy',
    ...p,
    schema: TaxonomySchema,
    schemaName: 'taxonomy',
    jsonSchema: JSON_SCHEMAS.taxonomy,
    hints,
  });
  const refToMsg = new Map([...refOf].map(([id, r]) => [r, id]));
  const unitInfos: UnitInfo[] = batch.map((u) => ({ unitKey: u.id, primaryRoot: u.primaryRoot, messageRefs: u.messageRefs.map((r) => r.m) }));
  const plan = validateTaxonomy(tree, res.value, unitInfos, { allowedRefs: new Set(refToMsg.keys()) });
  const published = await publishPlan(db, job, chat.id, plan, batch, refToMsg, res.modelId, { prov: provOf(deps) });
  const followUps = published.followUps;
  // Remaining units beyond this call are placed incrementally.
  if (all.length > batch.length) {
    const more = await assignIncremental(deps, job, chat);
    followUps.push(...more.followUps);
  }
  followUps.push(...(await scheduleLinks(db, chat.workspaceId)));
  return { status: 'completed', followUps, detail: { units: batch.length, newTopics: plan.newTopics.length, rejected: plan.rejected.slice(0, 20), model: res.modelId, frontiers: published.frontiers } };
}

function fixtureHints(tree: Tree, units: UnitRow[], native: Map<string, string>, refOf: Map<string, string>): FixtureHints {
  return {
    refs: Object.fromEntries([...refOf].map(([id, r]) => [r, native.get(id)!])),
    units: Object.fromEntries(units.map((u) => [u.id, u.messageRefs.map((r) => native.get(r.m)!)])),
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
    if (!chat.selected || chat.excluded || chat.deletionGeneration !== job.deletionGeneration) {
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
    const subdivide = new Set(plan.newTopics.filter((t) => t.maySubdivide).map((t) => idOf.get(t.key)).filter(Boolean) as string[]);
    if (opts.frontierCandidates !== false) {
      const counts = new Map<string, string[]>();
      for (const [unitId, topicId] of unitTopic) counts.set(topicId, [...(counts.get(topicId) ?? []), unitId]);
      for (const [topicId, unitIds] of counts) {
        if (!subdivide.has(topicId) || unitIds.length < REFINE_MIN_UNITS) continue;
        const refs = units.filter((u) => unitIds.includes(u.id)).flatMap((u) => u.messageRefs);
        const [fr] = await tx
          .insert(s.taxonomyFrontiers)
          .values({ workspaceId: chat.workspaceId, chatId, logicalJobId: job.logicalJobId, parentTopicId: topicId, inputMessages: refs, checkpoint: { unitIds } })
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
            // Continuations share the logical job (and its budget ledger).
            logicalJobId: job.logicalJobId,
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
  if (units.length + secondary.rows.length < REFINE_MIN_UNITS) {
    await db.update(s.taxonomyFrontiers).set({ status: 'completed', checkpoint: { reason: 'too little content' } }).where(eq(s.taxonomyFrontiers.id, fr.id));
    return { status: 'completed', followUps: [] };
  }
  const { sample, native, refOf } = await sampleTexts(db, units);
  for (const r of secondary.rows) if (!refOf.has(r.message_id)) refOf.set(r.message_id, `r${refOf.size + 1}`);
  if (deps.provider.kind === 'fixture') {
    const more = await nativeIdsFor(db, secondary.rows.map((r) => r.message_id));
    for (const [k, v] of more) native.set(k, v);
  }
  const digests = units.map((u) => digestUnit(u, sample, refOf));
  const secondaryRefs = secondary.rows.map((r) => refOf.get(r.message_id)!);
  const parentPath = ancestors(tree, parent.id).map((a) => a.title).join(' > ');
  const children = parent.childIds.map((c) => ({ id: c, path: `${parentPath} > ${tree.nodes.get(c)!.title}`, locked: false }));
  const p = refinementPrompt(chat.title, parentPath, parent.id, children, digests);
  const user = JSON.stringify({ ...JSON.parse(p.user), secondary_message_refs: secondaryRefs });
  const hints = deps.provider.kind === 'fixture' ? fixtureHints(tree, units, native, refOf) : undefined;
  let res;
  try {
    res = await callModel(deps, { workspaceId: job.workspaceId, logicalJobId: job.logicalJobId, jobId: job.id }, {
      role: 'reasoning',
      operation: 'refine',
      system: p.system,
      user,
      schema: TaxonomySchema,
      schemaName: 'taxonomy',
      jsonSchema: JSON_SCHEMAS.taxonomy,
      hints,
    });
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
  const plan = validateTaxonomy(tree, res.value, unitInfos, { allowedParentIds: allowed, allowedRefs: new Set(refOf.values()), defaultTarget: parent.id });
  const refToMsg = new Map([...refOf].map(([id, r]) => [r, id]));
  const published = await publishPlan(db, job, chat.id, plan, units, refToMsg, res.modelId, { prov: provOf(deps), moveFromParent: parent.id });
  await db
    .update(s.taxonomyFrontiers)
    .set({ status: 'completed', checkpoint: { newTopics: plan.newTopics.length, noUsefulSubdivision: res.value.no_useful_subdivision }, updatedAt: new Date() })
    .where(eq(s.taxonomyFrontiers.id, fr.id));
  return { status: 'completed', followUps: published.followUps, detail: { parent: parent.id, newTopics: plan.newTopics.length, model: res.modelId } };
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
async function assignIncremental(deps: PipelineDeps, job: Job, chat: Chat): Promise<{ followUps: string[]; detail: Record<string, unknown> }> {
  const { db } = deps;
  const units = await db.select().from(s.analysisUnits).where(and(eq(s.analysisUnits.chatId, chat.id), isNull(s.analysisUnits.assignedTopicId)));
  if (!units.length) return { followUps: [], detail: {} };
  const tree = await loadTree(db, chat.id);
  const locked = await lockedTopicIds(db, chat.id);
  const { sample, native, refOf } = await sampleTexts(db, units);
  const replyTopics = await replyTopicsFor(db, chat.id, units, tree);
  const digests = units.map((u) => {
    const d = digestUnit(u, sample, refOf);
    const rt = replyTopics.get(u.id) ?? [];
    return rt.length ? { ...d, reply_topics: rt } : d;
  });
  const all = [...tree.roots.map((r) => ({ id: r.id, path: r.title, locked: true })), ...treeDigest(tree, locked)];
  const candidates = all.slice(0, 400);
  // Topics a reply points at stay choosable even past the candidate cap.
  const wanted = new Set([...replyTopics.values()].flat());
  candidates.push(...all.slice(400).filter((c) => wanted.has(c.id)));
  const hints = deps.provider.kind === 'fixture' ? fixtureHints(tree, units, native, refOf) : undefined;
  const p = assignmentPrompt(chat.title, digests, candidates);
  const scope = { workspaceId: job.workspaceId, logicalJobId: job.logicalJobId, jobId: job.id };
  const first = await callModel(deps, scope, { role: 'fast', operation: 'assign', ...p, schema: AssignmentSchema, schemaName: 'assignment', jsonSchema: JSON_SCHEMAS.assignment, hints });
  let assignments = first.value.assignments;
  const ambiguous = assignments.filter((a) => a.confidence < 0.6 || (!a.topic_id && !a.new_topic)).map((a) => a.unit_key);
  if (ambiguous.length) {
    const sub = digests.filter((d) => ambiguous.includes(d.unit_key));
    const p2 = assignmentPrompt(chat.title, sub, candidates);
    const second = await callModel(deps, scope, { role: 'balanced', operation: 'assign:escalate', ...p2, schema: AssignmentSchema, schemaName: 'assignment', jsonSchema: JSON_SCHEMAS.assignment, hints });
    assignments = [...assignments.filter((a) => !ambiguous.includes(a.unit_key)), ...second.value.assignments.filter((a) => ambiguous.includes(a.unit_key))];
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
  return { followUps: [...published.followUps, ...(await scheduleLinks(db, chat.workspaceId))], detail: { assigned: units.length, escalated: ambiguous.length, rejected: plan.rejected.slice(0, 20) } };
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

export { ROOT_LABELS };
