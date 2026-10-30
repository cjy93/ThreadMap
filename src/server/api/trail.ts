// A question followed through the chat until it is resolved. Topic grouping cuts a
// conversation where its subject drifts, and an answer can come hours or days later
// without WhatsApp's Reply (the asker reads the chat later). When a message is opened,
// Nemotron reads forward from its discussion once and keeps the later messages that
// continue it; the result is saved, so each message is read once.
import crypto from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as s from '../../db/schema';
import type { LlmConfig } from '../../lib/config';
import { trailPrompt, type PromptMessage } from '../ai/prompts';
import type { ModelProvider } from '../ai/provider';
import { callModel, ensureLedger } from '../ai/router';
import { JSON_SCHEMAS, TrailSchema } from '../ai/schemas';
import type { Db } from '../db';
import { ASK_CHANNEL } from '../notify';
import { isUuid, SafeError } from '../util';
import { modelProblem, type NotYet } from './ask';
import { discussionRows, requireChat, type AuthCtx } from './service';

// How far ahead to read, and how much at once.
const TRAIL_DAYS = 7;
const TRAIL_MAX_MESSAGES = 240;
const TRAIL_PER_CALL = 60;
// The thread so far given with each part (the latest messages of it).
const TRAIL_THREAD_MAX = 24;
const TRAIL_TIMEOUT_MS = 90_000;

type Row = { id: string; sender_label: string; body: string | null; sent_at: Date | null; native_id: string; reply_to: string | null };

/** Runs in the worker: follow the opened message's discussion forward and save the trail. */
export async function inferTrail(deps: { db: Db; provider: ModelProvider; cfg: LlmConfig }, workspaceId: string, messageId: string): Promise<{ found: number }> {
  const { db } = deps;
  const [m] = await db.select().from(s.messages).where(and(eq(s.messages.id, messageId), eq(s.messages.workspaceId, workspaceId)));
  if (!m || !m.sentAt) return { found: 0 };
  const [chat] = await db.select({ title: s.chats.title }).from(s.chats).where(eq(s.chats.id, m.chatId));

  // The thread so far: what the message replies to (up the chain), its discussion, and itself.
  const seed = new Map<string, Row>();
  const disc = await discussionRows(db, m.chatId, messageId);
  for (const r of disc) seed.set(r.id, { id: r.id, sender_label: r.sender_label, body: r.body, sent_at: r.sent_at, native_id: r.native_id, reply_to: r.reply_to });
  let up: { native: string | null; id: string | null } = { native: m.replyToNativeId, id: m.inferredReplyTo };
  for (let i = 0; i < 10 && (up.native || up.id); i++) {
    const [q] = (
      await db.execute<Row & { inferred_reply_to: string | null }>(sql`
        SELECT id, sender_label, body, sent_at, native_id, reply_to_native_id AS reply_to, inferred_reply_to FROM messages
        WHERE chat_id = ${m.chatId}::uuid AND ${up.native ? sql`native_id = ${up.native}` : sql`id = ${up.id}::uuid`} LIMIT 1`)
    ).rows;
    if (!q || seed.has(q.id)) break;
    seed.set(q.id, q);
    up = { native: q.reply_to, id: q.inferred_reply_to };
  }
  seed.set(m.id, { id: m.id, sender_label: m.senderLabel, body: m.body, sent_at: m.sentAt, native_id: m.nativeId, reply_to: m.replyToNativeId });
  const thread = [...seed.values()].filter((r) => r.sent_at).sort((a, b) => +new Date(a.sent_at!) - +new Date(b.sent_at!));
  const last = thread[thread.length - 1];

  // Later messages, up to a week on.
  const later = (
    await db.execute<Row>(sql`
      SELECT id, sender_label, body, sent_at, native_id, reply_to_native_id AS reply_to FROM messages
      WHERE chat_id = ${m.chatId}::uuid AND state = 'active' AND body IS NOT NULL AND body <> ''
        AND (sent_at, id) > (${last.sent_at}, ${last.id}::uuid)
        AND sent_at < ${new Date(+new Date(m.sentAt) + TRAIL_DAYS * 86_400_000)}
      ORDER BY sent_at, id LIMIT ${TRAIL_MAX_MESSAGES}`)
  ).rows.filter((r) => !seed.has(r.id));

  const logicalJobId = crypto.randomUUID();
  await ensureLedger(db, workspaceId, logicalJobId, deps.cfg);
  const found: Row[] = [];
  let resolvedBy: string | null = null;
  for (let i = 0; i < later.length && !resolvedBy; i += TRAIL_PER_CALL) {
    const part = later.slice(i, i + TRAIL_PER_CALL);
    const so = [...thread, ...found].slice(-TRAIL_THREAD_MAX);
    const refOf = new Map<string, string>();
    so.forEach((r, k) => refOf.set(r.id, `t${k + 1}`));
    part.forEach((r, k) => refOf.set(r.id, `l${k + 1}`));
    const refOfNative = new Map([...so, ...part].map((r) => [r.native_id, refOf.get(r.id)!]));
    const item = (r: Row): PromptMessage => ({
      ref: refOf.get(r.id)!,
      sender: r.sender_label,
      time: r.sent_at ? new Date(r.sent_at).toISOString() : null,
      text: (r.body ?? '').slice(0, 300),
      reply_to: r.reply_to ? (refOfNative.get(r.reply_to) ?? 'earlier message') : null,
    });
    const res = await callModel(deps, { workspaceId, logicalJobId }, {
      role: 'balanced',
      operation: 'trail',
      ...trailPrompt(chat?.title ?? '', so.map(item), part.map(item)),
      schema: TrailSchema,
      schemaName: 'trail',
      jsonSchema: JSON_SCHEMAS.trail,
      maxOutputTokens: 1500,
    });
    const byRef = new Map(part.map((r) => [refOf.get(r.id)!, r]));
    const picked = new Set(res.value.continues.filter((r) => byRef.has(r)));
    // The settling message is part of the trail too.
    if (res.value.resolved_by && byRef.has(res.value.resolved_by)) {
      picked.add(res.value.resolved_by);
      resolvedBy = byRef.get(res.value.resolved_by)!.id;
    }
    for (const r of part) if (picked.has(refOf.get(r.id)!)) found.push(r);
  }

  const ids = found.map((r) => r.id);
  await db
    .insert(s.messageTrails)
    .values({ messageId, workspaceId, messageIds: ids, resolvedBy, checkedAt: new Date() })
    .onConflictDoUpdate({ target: s.messageTrails.messageId, set: { messageIds: ids, resolvedBy, checkedAt: new Date() } });
  return { found: ids.length };
}

type TrailRunner = (messageId: string) => Promise<{ found: number } | NotYet | null>;

/** The web process asks the worker (which holds the model key) and waits for it. */
const trailViaWorker =
  (db: Db, workspaceId: string): TrailRunner =>
  async (messageId) => {
    const { prepareAskReply } = await import('../events-hub');
    const id = crypto.randomUUID();
    const { reply } = await prepareAskReply(id, TRAIL_TIMEOUT_MS, { ws: workspaceId, kind: 'trail' });
    await db.execute(sql`SELECT pg_notify(${ASK_CHANNEL}, ${JSON.stringify({ id, kind: 'trail', workspaceId, messageId })})`);
    const r = await reply;
    if (!r) return { pending: id };
    return r.ok ? { found: Number(r.found ?? 0) } : { failed: r.reason };
  };

/**
 * GET /api/messages/:id/trail — the saved trail, if any (no model call).
 * POST — follow the discussion now: once, and again only while it is unresolved and newer messages
 * within the reading window have arrived since (an answer can come days later).
 */
export async function findTrail(db: Db, ctx: AuthCtx, messageId: string, opts: { follow: boolean }, run: TrailRunner = trailViaWorker(db, ctx.workspaceId)) {
  if (!isUuid(messageId)) throw new SafeError('message not found', 404, 'not_found');
  const [m] = await db.select({ chatId: s.messages.chatId, sentAt: s.messages.sentAt }).from(s.messages).where(and(eq(s.messages.id, messageId), eq(s.messages.workspaceId, ctx.workspaceId)));
  if (!m) throw new SafeError('message not found', 404, 'not_found');
  const chat = await requireChat(db, ctx, m.chatId);
  let [saved] = await db.select().from(s.messageTrails).where(eq(s.messageTrails.messageId, messageId));
  const stale =
    saved && !saved.resolvedBy && m.sentAt
      ? (
          await db.execute(sql`
            SELECT 1 FROM messages WHERE chat_id = ${m.chatId}::uuid AND sent_at > ${saved.checkedAt}
              AND sent_at < ${new Date(+new Date(m.sentAt) + TRAIL_DAYS * 86_400_000)} LIMIT 1`)
        ).rows.length > 0
      : false;
  if (!opts.follow && (!saved || stale)) return { checked: false, stale };
  if (!saved || stale) {
    const r = await run(messageId);
    if (!r) return { checked: false, note: 'Nemotron did not answer.' };
    if ('pending' in r) return { checked: false, note: 'NVIDIA Nemotron is still following this discussion; open the message again in a minute.' };
    if ('failed' in r) return { checked: false, note: modelProblem(r.failed) };
    [saved] = await db.select().from(s.messageTrails).where(eq(s.messageTrails.messageId, messageId));
    if (!saved) return { checked: false, note: 'Nemotron did not answer.' };
  }
  const ids = saved.messageIds;
  const rows = ids.length
    ? await db
        .select({ id: s.messages.id, sender: s.messages.senderLabel, body: s.messages.body, sentAt: s.messages.sentAt, state: s.messages.state, direction: s.messages.direction })
        .from(s.messages)
        .where(and(inArray(s.messages.id, ids), eq(s.messages.workspaceId, ctx.workspaceId)))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const senderOf = (label: string, direction: string) => (label === 'Unknown sender' && chat.kind === 'direct' && direction === 'incoming' ? chat.title : label);
  return {
    checked: true,
    resolved: saved.resolvedBy !== null,
    messages: ids
      .map((id) => byId.get(id))
      .filter((r): r is NonNullable<typeof r> => Boolean(r))
      .map((r) => ({
        message_id: r.id,
        sender: senderOf(r.sender, r.direction),
        direction: r.direction,
        snippet: r.state === 'active' ? (r.body ?? '').slice(0, 500) : null,
        sent_at: r.sentAt ? new Date(r.sentAt).toISOString() : null,
        resolves: r.id === saved.resolvedBy,
      })),
  };
}
