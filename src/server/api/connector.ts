// Owner-only WhatsApp connection control, chat discovery/selection, media and
// destructive actions. Commands go to the companion through PostgreSQL; the
// browser can never invoke arbitrary Baileys methods.
import { and, desc, eq, sql } from 'drizzle-orm';
import * as s from '../../db/schema';
import { loadAppConfig } from '../../lib/config';
import { requestRebuild, resumePausedFrontiers } from '../ai/pipeline';
import type { Db } from '../db';
import { notifyChange } from '../notify';
import { getStorage } from '../storage';
import { isUuid, SafeError } from '../util';
import { applySelections, deleteChat, ensureLinkedAccount } from '../workspace';
import { requireChat, type AuthCtx } from './service';

export const COMMAND_CHANNEL = 'tm_cmd';

function ownerOnly(ctx: AuthCtx) {
  if (ctx.mode !== 'private') throw new SafeError('not available in the public demo', 403, 'demo_forbidden');
}

export async function enqueueCommand(db: Db, ctx: AuthCtx, type: (typeof s.connectorCommands.$inferInsert)['type'], payload: Record<string, unknown> = {}, idem?: string) {
  ownerOnly(ctx);
  const la = await ensureLinkedAccount(db, ctx.workspaceId);
  const [row] = await db
    .insert(s.connectorCommands)
    .values({ workspaceId: ctx.workspaceId, linkedAccountId: la.id, type, payload, idempotencyKey: idem ?? null })
    .onConflictDoNothing()
    .returning();
  const cmd = row ?? (await db.select().from(s.connectorCommands).where(and(eq(s.connectorCommands.workspaceId, ctx.workspaceId), eq(s.connectorCommands.idempotencyKey, idem!))))[0];
  await db.execute(sql`SELECT pg_notify(${COMMAND_CHANNEL}, ${cmd.linkedAccountId})`);
  return cmd;
}

export async function startPairing(db: Db, ctx: AuthCtx) {
  ownerOnly(ctx);
  if (!loadAppConfig().WHATSAPP_PAIRING_ENABLED) throw new SafeError('pairing is disabled', 403, 'pairing_disabled');
  const la = await ensureLinkedAccount(db, ctx.workspaceId);
  await db.update(s.linkedAccounts).set({ desiredState: 'active', updatedAt: new Date() }).where(eq(s.linkedAccounts.id, la.id));
  const cmd = await enqueueCommand(db, ctx, 'pair');
  return { attempt_id: cmd.id };
}

export async function setDesired(db: Db, ctx: AuthCtx, desired: 'active' | 'paused') {
  ownerOnly(ctx);
  const la = await ensureLinkedAccount(db, ctx.workspaceId);
  await db.update(s.linkedAccounts).set({ desiredState: desired, updatedAt: new Date() }).where(eq(s.linkedAccounts.id, la.id));
  await enqueueCommand(db, ctx, desired === 'paused' ? 'pause' : 'resume');
  return { desired_state: desired };
}

export async function disconnect(db: Db, ctx: AuthCtx) {
  ownerOnly(ctx);
  const la = await ensureLinkedAccount(db, ctx.workspaceId);
  await db.update(s.linkedAccounts).set({ desiredState: 'disconnected', updatedAt: new Date() }).where(eq(s.linkedAccounts.id, la.id));
  const cmd = await enqueueCommand(db, ctx, 'disconnect');
  return { command_id: cmd.id, note: 'Saved credentials are removed. If remote unlink cannot be confirmed, remove ThreadMap under WhatsApp → Linked Devices.' };
}

export async function connectionStatus(db: Db, ctx: AuthCtx) {
  if (ctx.mode !== 'private') {
    return { mode: 'demo', connection: { state: 'demo_replay', detail: 'Public demo: labeled synthetic replay. Pairing is disabled.' }, pairing_allowed: false };
  }
  const la = await ensureLinkedAccount(db, ctx.workspaceId);
  const [st] = await db.select().from(s.connectionStatus).where(eq(s.connectionStatus.linkedAccountId, la.id));
  const [lease] = await db.select().from(s.connectorLeases).where(eq(s.connectorLeases.linkedAccountId, la.id));
  const [hb] = await db.select().from(s.processHeartbeats).where(eq(s.processHeartbeats.processName, 'companion'));
  const coverage = await db.execute<{ chat_id: string; title: string; history_state: string; earliest_at: Date | null; latest_at: Date | null; history_count: number; live_count: number; warnings: unknown; excluded_before_cutoff: number; unknown_time_excluded: number }>(sql`
    SELECT c.id AS chat_id, c.title, sc.history_state, sc.earliest_at, sc.latest_at, sc.history_count, sc.live_count, sc.warnings, sc.excluded_before_cutoff, sc.unknown_time_excluded
    FROM chats c JOIN sync_coverage sc ON sc.chat_id = c.id WHERE c.workspace_id = ${ctx.workspaceId}::uuid AND c.selected`);
  const backlog = await db.execute<{ pending: number; budget_paused: number; failed: number }>(sql`
    SELECT count(*) FILTER (WHERE status IN ('pending','running'))::int AS pending,
           count(*) FILTER (WHERE status = 'budget_paused')::int AS budget_paused,
           count(*) FILTER (WHERE status = 'failed')::int AS failed
    FROM analysis_jobs WHERE workspace_id = ${ctx.workspaceId}::uuid`);
  const outbox = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM analysis_outbox WHERE workspace_id = ${ctx.workspaceId}::uuid AND dispatched_job_id IS NULL`);
  return {
    mode: 'private',
    pairing_allowed: loadAppConfig().WHATSAPP_PAIRING_ENABLED,
    desired_state: la.desiredState,
    connection: {
      state: st?.state ?? 'disconnected',
      detail: st?.detail ?? null,
      last_event_at: st?.lastEventAt?.toISOString() ?? null,
      heartbeat_at: st?.heartbeatAt?.toISOString() ?? null,
      connected_since: st?.connectedSince?.toISOString() ?? null,
      uncertain_intervals: st?.uncertainIntervals ?? [],
      relink_required: st?.state === 'relink_required',
      remote_unlink_confirmed: st?.remoteUnlinkConfirmed ?? null,
      lease_held: Boolean(lease && lease.expiresAt > new Date()),
    },
    companion_heartbeat_at: hb?.heartbeatAt.toISOString() ?? null,
    history: coverage.rows.map((r) => ({ ...r, earliest_at: r.earliest_at ? new Date(r.earliest_at).toISOString() : null, latest_at: r.latest_at ? new Date(r.latest_at).toISOString() : null })),
    analysis: { ...backlog.rows[0], undispatched: outbox.rows[0].n },
  };
}

/** Discovered chats: identity/title/type metadata and selection only — never content previews. */
export async function discoveredChats(db: Db, ctx: AuthCtx) {
  ownerOnly(ctx);
  const rows = await db
    .select({ id: s.chats.id, title: s.chats.title, kind: s.chats.kind, selected: s.chats.selected, paused: s.chats.paused, historyMode: s.chats.historyMode, cutoff: s.chats.newOnlyCutoff, excluded: s.chats.excluded })
    .from(s.chats)
    .where(and(eq(s.chats.workspaceId, ctx.workspaceId), eq(s.chats.sourceKind, 'whatsapp')))
    .orderBy(desc(s.chats.selected), s.chats.title);
  return { chats: rows.map((r) => ({ ...r, cutoff: r.cutoff?.toISOString() ?? null })) };
}

export async function putSelections(db: Db, ctx: AuthCtx, body: unknown) {
  ownerOnly(ctx);
  const items = ((body as { selections?: unknown })?.selections ?? []) as { chat_id?: unknown; selected?: unknown; history_mode?: unknown }[];
  if (!Array.isArray(items) || items.length > 500) throw new SafeError('invalid selections');
  const parsed = items.map((i) => {
    if (!isUuid(i.chat_id) || typeof i.selected !== 'boolean') throw new SafeError('invalid selection item');
    if (i.history_mode !== undefined && i.history_mode !== 'available_history' && i.history_mode !== 'new_only') throw new SafeError('invalid history mode');
    return { chatId: i.chat_id, selected: i.selected, historyMode: i.history_mode as 'available_history' | 'new_only' | undefined };
  });
  const res = await applySelections(db, ctx.workspaceId, parsed);
  // Let the companion release buffered pre-selection history for newly selected chats.
  await enqueueCommand(db, ctx, 'request_history', { reason: 'selection_changed' });
  return { effective: res };
}

export async function requestHistory(db: Db, ctx: AuthCtx, chatId: string) {
  const chat = await requireChat(db, ctx, chatId);
  ownerOnly(ctx);
  if (chat.sourceKind !== 'whatsapp' || !chat.selected) throw new SafeError('history requests apply to selected WhatsApp chats only');
  const cmd = await enqueueCommand(db, ctx, 'request_history', { chatId });
  return { command_id: cmd.id, note: 'Older history is best-effort; WhatsApp may return partial or no results.' };
}

export async function fetchAttachment(db: Db, ctx: AuthCtx, attachmentId: string) {
  const a = await authorizedAttachment(db, ctx, attachmentId);
  if (a.availability === 'cached') return { availability: 'cached' };
  if (a.availability === 'unsupported' || a.availability === 'unavailable') return { availability: a.availability, reason: a.failureReason };
  if (ctx.mode !== 'private') return { availability: a.availability, reason: 'Media fetch is unavailable in the demo replay' };
  const max = loadAppConfig().MAX_ATTACHMENT_MIB * 1024 * 1024;
  if ((a.declaredSize ?? 0) > max) return { availability: 'failed', reason: `File exceeds ${loadAppConfig().MAX_ATTACHMENT_MIB} MiB limit` };
  // Idempotent transition: only one fetch command per attachment in flight.
  const r = await db.execute(sql`UPDATE attachments SET availability = 'fetching', updated_at = now() WHERE id = ${a.id}::uuid AND availability IN ('available','failed') RETURNING id`);
  if (r.rows.length) await enqueueCommand(db, ctx, 'fetch_media', { attachmentId: a.id }, `fetch:${a.id}:${Date.now() >> 16}`);
  return { availability: 'fetching' };
}

export async function authorizedAttachment(db: Db, ctx: AuthCtx, attachmentId: string) {
  if (!isUuid(attachmentId)) throw new SafeError('file not found', 404, 'not_found');
  const [a] = await db
    .select({ att: s.attachments, state: s.messages.state, excluded: s.chats.excluded })
    .from(s.attachments)
    .innerJoin(s.messages, eq(s.messages.id, s.attachments.messageId))
    .innerJoin(s.chats, eq(s.chats.id, s.messages.chatId))
    .where(and(eq(s.attachments.id, attachmentId), eq(s.attachments.workspaceId, ctx.workspaceId)));
  if (!a || a.state !== 'active' || a.excluded) throw new SafeError('file not found', 404, 'not_found');
  if (a.att.expiresAt && a.att.expiresAt < new Date()) throw new SafeError('file expired', 410, 'expired');
  return a.att;
}

const INLINE_SAFE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'application/pdf']);

/** Stream a cached private file with safe headers (never executes received content). */
export async function attachmentContent(db: Db, ctx: AuthCtx, attachmentId: string, download: boolean) {
  const a = await authorizedAttachment(db, ctx, attachmentId);
  if (a.availability !== 'cached' || !a.objectKey) throw new SafeError('file is not available', 409, 'not_cached');
  const bytes = await getStorage().get(a.objectKey);
  if (!bytes) throw new SafeError('file is not available', 409, 'not_cached');
  const mime = a.detectedMime ?? a.declaredMime ?? 'application/octet-stream';
  const inline = !download && INLINE_SAFE.has(mime);
  const safeName = (a.filename ?? `${a.mediaType}-${a.id.slice(0, 8)}`).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120);
  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': inline ? mime : 'application/octet-stream',
      'content-length': String(bytes.length),
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(safeName)}`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      'cache-control': 'private, no-store',
    },
  });
}

export async function deleteIndexedChat(db: Db, ctx: AuthCtx, chatId: string) {
  await requireChat(db, ctx, chatId);
  const storage = getStorage();
  return deleteChat(db, ctx.workspaceId, chatId, (k) => storage.delete(k));
}

export async function rebuildChat(db: Db, ctx: AuthCtx, chatId: string) {
  await requireChat(db, ctx, chatId);
  const id = await requestRebuild(db, chatId);
  await notifyChange(db, { ws: ctx.workspaceId, kind: 'analysis', chatId });
  return { job_id: id, note: 'Rebuild runs within the per-job inference budget and preserves your corrections.' };
}

export async function retryJob(db: Db, ctx: AuthCtx, jobId: string) {
  if (!isUuid(jobId)) throw new SafeError('job not found', 404, 'not_found');
  const [j] = await db.select().from(s.analysisJobs).where(and(eq(s.analysisJobs.id, jobId), eq(s.analysisJobs.workspaceId, ctx.workspaceId)));
  if (!j) throw new SafeError('job not found', 404, 'not_found');
  if (j.status === 'budget_paused' && j.kind === 'refine') return { resumed: await resumePausedFrontiers(db, j.chatId) };
  if (j.status !== 'failed' && j.status !== 'budget_paused') throw new SafeError('only failed or paused jobs can be retried', 409, 'not_retryable');
  if (j.attempts >= 5) throw new SafeError('retry limit reached', 409, 'retry_limit');
  await db.update(s.analysisJobs).set({ status: 'pending', safeError: null }).where(eq(s.analysisJobs.id, j.id));
  return { retried: j.id };
}
