// Answers given without WhatsApp's Reply: people often answer a question from a
// few messages back (two questions asked, then both answered in turn) without
// pressing Reply, so WhatsApp records no link. When a discussion is opened,
// Nemotron Nano reads it once and links each such answer to the message it
// answers; the result is kept on the messages, so each discussion is read once.
import crypto from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as s from '../../db/schema';
import type { LlmConfig } from '../../lib/config';
import { answersPrompt } from '../ai/prompts';
import type { ModelProvider } from '../ai/provider';
import { callModel, ensureLedger } from '../ai/router';
import { AnswersSchema, JSON_SCHEMAS } from '../ai/schemas';
import type { Db } from '../db';
import { ASK_CHANNEL } from '../notify';
import { isUuid, SafeError } from '../util';
import { modelProblem, type NotYet } from './ask';
import { discussionRows, type AuthCtx } from './service';

// Messages read per call, and earlier messages given as context with them.
const ANSWERS_PER_CALL = 120;
const ANSWERS_CONTEXT = 8;
const ANSWERS_TIMEOUT_MS = 90_000;

/** Runs in the worker: link the answers in one message's discussion. Returns how many were found. */
export async function inferAnswers(deps: { db: Db; provider: ModelProvider; cfg: LlmConfig }, workspaceId: string, messageId: string): Promise<{ links: number }> {
  const { db } = deps;
  const [m] = await db.select({ chatId: s.messages.chatId }).from(s.messages).where(and(eq(s.messages.id, messageId), eq(s.messages.workspaceId, workspaceId)));
  if (!m) return { links: 0 };
  const [chat] = await db.select({ title: s.chats.title }).from(s.chats).where(eq(s.chats.id, m.chatId));
  const rows = await discussionRows(db, m.chatId, messageId);
  if (!rows.length) return { links: 0 };
  const logicalJobId = crypto.randomUUID();
  await ensureLedger(db, workspaceId, logicalJobId, deps.cfg);
  const text = (r: { body: string | null }) => (r.body ?? '').slice(0, 400);
  const links: { from: string; to: string }[] = [];
  for (let i = 0; i < rows.length; i += ANSWERS_PER_CALL) {
    const part = rows.slice(i, i + ANSWERS_PER_CALL);
    // What came just before this part: earlier discussion messages, or the chat before the discussion.
    const context =
      i > 0
        ? rows.slice(Math.max(0, i - ANSWERS_CONTEXT), i)
        : part[0].sent_at
          ? (
              await db.execute<(typeof rows)[number]>(sql`
                SELECT id, sender_label, body, sent_at, native_id, reply_to_native_id AS reply_to FROM messages
                WHERE chat_id = ${m.chatId}::uuid AND state = 'active' AND (sent_at, id) < (${part[0].sent_at}, ${part[0].id}::uuid)
                ORDER BY sent_at DESC, id DESC LIMIT ${ANSWERS_CONTEXT}`)
            ).rows.reverse()
          : [];
    const refOf = new Map<string, string>();
    context.forEach((r, k) => refOf.set(r.id, `c${k + 1}`));
    part.forEach((r, k) => refOf.set(r.id, `m${k + 1}`));
    const idOfRef = new Map([...refOf].map(([id, ref]) => [ref, id]));
    const refOfNative = new Map([...context, ...part].map((r) => [r.native_id, refOf.get(r.id)!]));
    const item = (r: (typeof rows)[number]) => ({
      ref: refOf.get(r.id)!,
      sender: r.sender_label,
      time: r.sent_at ? new Date(r.sent_at).toISOString() : null,
      text: text(r),
      reply_to: r.reply_to ? (refOfNative.get(r.reply_to) ?? 'earlier message') : null,
    });
    const res = await callModel(deps, { workspaceId, logicalJobId }, {
      role: 'fast',
      operation: 'answers',
      ...answersPrompt(chat?.title ?? '', context.map(item), part.map(item)),
      schema: AnswersSchema,
      schemaName: 'answers',
      jsonSchema: JSON_SCHEMAS.answers,
      maxOutputTokens: 2000,
      thinking: false,
    });
    const byId = new Map([...context, ...part].map((r) => [r.id, r]));
    for (const l of res.value.links) {
      const from = idOfRef.get(l.ref);
      const to = idOfRef.get(l.answers);
      const a = from ? byId.get(from) : undefined;
      const b = to ? byId.get(to) : undefined;
      // Only a message of this part, answering a different, earlier one, and not already a WhatsApp reply.
      if (!a || !b || !l.ref.startsWith('m') || a.id === b.id || a.reply_to) continue;
      if (a.sent_at && b.sent_at && new Date(b.sent_at) > new Date(a.sent_at)) continue;
      links.push({ from: a.id, to: b.id });
    }
  }
  const ids = rows.map((r) => r.id);
  await db.transaction(async (tx) => {
    await tx.update(s.messages).set({ inferredReplyTo: null, inferredAt: new Date() }).where(inArray(s.messages.id, ids));
    for (const l of links) await tx.update(s.messages).set({ inferredReplyTo: l.to }).where(eq(s.messages.id, l.from));
  });
  return { links: links.length };
}

type AnswersRunner = (messageId: string) => Promise<{ links: number } | NotYet | null>;

/** The web process asks the worker (which holds the model key) and waits for it. */
const answersViaWorker =
  (db: Db, workspaceId: string): AnswersRunner =>
  async (messageId) => {
    const { prepareAskReply } = await import('../events-hub');
    const id = crypto.randomUUID();
    const { reply } = await prepareAskReply(id, ANSWERS_TIMEOUT_MS, { ws: workspaceId, kind: 'answers' });
    await db.execute(sql`SELECT pg_notify(${ASK_CHANNEL}, ${JSON.stringify({ id, kind: 'answers', workspaceId, messageId })})`);
    const r = await reply;
    if (!r) return { pending: id };
    return r.ok ? { links: Number(r.links ?? 0) } : { failed: r.reason };
  };

/** POST /api/messages/:id/answers — read the message's discussion for answers given without Reply (once). */
export async function findAnswers(db: Db, ctx: AuthCtx, messageId: string, run: AnswersRunner = answersViaWorker(db, ctx.workspaceId)) {
  if (!isUuid(messageId)) throw new SafeError('message not found', 404, 'not_found');
  const [m] = await db.select({ chatId: s.messages.chatId }).from(s.messages).where(and(eq(s.messages.id, messageId), eq(s.messages.workspaceId, ctx.workspaceId)));
  if (!m) throw new SafeError('message not found', 404, 'not_found');
  const rows = await discussionRows(db, m.chatId, messageId);
  if (!rows.length) return { checked: false, note: 'This message has not been analysed yet.' };
  if (rows.every((r) => r.inferred_at !== null)) return { checked: true };
  const r = await run(messageId);
  if (!r) return { checked: false, note: 'Nemotron did not answer.' };
  // Slow: the worker carries on and saves its result; opening the message again shows it.
  if ('pending' in r) return { checked: false, note: 'NVIDIA Nemotron is still reading this discussion; open the message again in a minute.' };
  if ('failed' in r) return { checked: false, note: modelProblem(r.failed) };
  return { checked: true, links: r.links };
}
