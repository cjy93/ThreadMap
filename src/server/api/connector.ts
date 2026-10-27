// Owner-only WhatsApp connection control, chat discovery/selection, media and
// destructive actions. Commands go to the companion through PostgreSQL; the
// browser can never invoke arbitrary Baileys methods.
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as s from '../../db/schema';
import { loadAppConfig } from '../../lib/config';
import { mapNeedsTidy, rebuildMapFromScratch, requestRebuild, resumePausedFrontiers } from '../ai/pipeline';
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

export async function startPairing(db: Db, ctx: AuthCtx, body: unknown = {}) {
  ownerOnly(ctx);
  // Optional: link by phone number (a code typed on the phone) instead of scanning a QR.
  const raw = (body as { phone?: unknown })?.phone;
  const phone = typeof raw === 'string' && raw.trim() ? raw.replace(/[\s()+-]/g, '') : undefined;
  if (phone !== undefined && !/^\d{8,15}$/.test(phone)) throw new SafeError('enter the full number with country code, e.g. 65 9123 4567');
  if (!loadAppConfig().WHATSAPP_PAIRING_ENABLED) throw new SafeError('pairing is disabled', 403, 'pairing_disabled');
  const la = await ensureLinkedAccount(db, ctx.workspaceId);
  await db.update(s.linkedAccounts).set({ desiredState: 'active', updatedAt: new Date() }).where(eq(s.linkedAccounts.id, la.id));
  const cmd = await enqueueCommand(db, ctx, 'pair', phone ? { phone } : {});
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

/**
 * Disconnect / Sign out: leaving deletes the account. The browser is signed out
 * now; the companion logs the WhatsApp device out and then deletes the account
 * with all its chats, messages, maps and photos (in that order, so the device
 * really disappears from the phone's Linked Devices).
 */
export async function deleteMyAccount(db: Db, ctx: AuthCtx) {
  ownerOnly(ctx);
  await enqueueCommand(db, ctx, 'delete_account');
  await db.delete(s.session).where(eq(s.session.userId, ctx.userId));
  return { deleted: true };
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
    .select({
      id: s.chats.id,
      title: s.chats.title,
      kind: s.chats.kind,
      selected: s.chats.selected,
      paused: s.chats.paused,
      historyMode: s.chats.historyMode,
      cutoff: s.chats.newOnlyCutoff,
      excluded: s.chats.excluded,
      lastMessageAt: s.chats.lastEventAt,
      avatarKey: s.chats.avatarKey,
      avatarCheckedAt: s.chats.avatarCheckedAt,
      // The owner's own contact's number, so a friend can be found by number when WhatsApp gave no name.
      phone: sql<string | null>`(SELECT '+' || split_part(a.alias_jid, '@', 1) FROM chat_aliases a
        WHERE a.chat_id = ${s.chats.id} AND a.alias_jid LIKE '%@s.whatsapp.net' LIMIT 1)`,
    })
    .from(s.chats)
    .where(and(eq(s.chats.workspaceId, ctx.workspaceId), eq(s.chats.sourceKind, 'whatsapp')))
    // Like WhatsApp: latest message first. Chats with no known time follow, named before number-only.
    .orderBy(
      sql`${s.chats.lastEventAt} DESC NULLS LAST`,
      sql`(${s.chats.title} ~ '^\\+[0-9]*[∙•·]*[0-9]*$' OR ${s.chats.title} IN ('Unknown contact', 'Direct chat'))`,
      sql`lower(${s.chats.title})`,
    );
  const stale = Date.now() - AVATAR_RECHECK_MS;
  return {
    chats: rows.map(({ avatarKey, avatarCheckedAt, ...r }) => ({
      ...r,
      cutoff: r.cutoff?.toISOString() ?? null,
      last_message_at: r.lastMessageAt?.toISOString() ?? null,
      // Versioned so a refreshed photo is not served from the browser cache.
      avatar_url: avatarKey ? `/api/chats/${r.id}/avatar?v=${avatarCheckedAt?.getTime() ?? 0}` : null,
      avatar_due: !avatarCheckedAt || avatarCheckedAt.getTime() < stale,
    })),
  };
}

// Profile photos are looked up lazily for chats on screen, a batch at a time,
// and re-checked weekly; WhatsApp is never asked for all chats at once.
const AVATAR_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
const AVATAR_BATCH = 40;

export async function requestAvatars(db: Db, ctx: AuthCtx, body: unknown) {
  ownerOnly(ctx);
  const ids = (body as { chat_ids?: unknown })?.chat_ids;
  if (!Array.isArray(ids) || ids.length > 500 || !ids.every(isUuid)) throw new SafeError('invalid chat ids');
  // Claim due chats so overlapping requests do not fetch the same photo twice.
  const due = await db
    .update(s.chats)
    .set({ avatarCheckedAt: new Date() })
    .where(
      and(
        eq(s.chats.workspaceId, ctx.workspaceId),
        eq(s.chats.sourceKind, 'whatsapp'),
        inArray(s.chats.id, (ids as string[]).slice(0, AVATAR_BATCH)),
        sql`(${s.chats.avatarCheckedAt} IS NULL OR ${s.chats.avatarCheckedAt} < ${new Date(Date.now() - AVATAR_RECHECK_MS)})`,
      ),
    )
    .returning({ id: s.chats.id });
  if (due.length) await enqueueCommand(db, ctx, 'fetch_avatars', { chatIds: due.map((d) => d.id) });
  return { requested: due.length };
}

export async function avatarContent(db: Db, ctx: AuthCtx, chatId: string) {
  ownerOnly(ctx);
  const chat = await requireChat(db, ctx, chatId);
  const bytes = chat.avatarKey ? await getStorage().get(chat.avatarKey) : null;
  if (!bytes) throw new SafeError('no profile photo', 404, 'not_found');
  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': bytes[0] === 0x89 ? 'image/png' : 'image/jpeg',
      'content-length': String(bytes.length),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
      // The URL carries a version, so the private copy can be reused for a day.
      'cache-control': 'private, max-age=86400',
    },
  });
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
  // Chats being opened now (not already open), for the history backfill below.
  const picked = parsed.filter((p) => p.selected).map((p) => p.chatId);
  const opening = picked.length
    ? (
        await db.execute<{ id: string }>(sql`
          SELECT c.id FROM chats c WHERE c.id IN (${sql.join(picked.map((id) => sql`${id}::uuid`), sql`, `)})
            AND c.workspace_id = ${ctx.workspaceId}::uuid AND NOT c.selected`)
      ).rows.map((r) => r.id)
    : [];
  const res = await applySelections(db, ctx.workspaceId, parsed);
  // Let the companion release buffered pre-selection history for newly selected chats.
  await enqueueCommand(db, ctx, 'request_history', { reason: 'selection_changed' });
  // WhatsApp sent each chat's history once, at linking; a chat opened later kept only a few
  // minutes of it. Page the older history back in from the phone (all-history chats only).
  const backfill = res.filter((r) => opening.includes(r.chatId) && r.historyMode === 'available_history');
  for (const r of backfill) await enqueueCommand(db, ctx, 'request_history', { chatId: r.chatId, backfill: true });
  return { effective: res };
}

// Long enough for the worker (1 s tick) to dispatch everything waiting, including stragglers.
const REFRESH_WINDOW_MS = 60 * 1000;

/** Refresh: analyse the messages that arrived since the last analysis of this chat, once. */
export async function refreshChat(db: Db, ctx: AuthCtx, chatId: string) {
  ownerOnly(ctx);
  const chat = await requireChat(db, ctx, chatId);
  if (!chat.selected) throw new SafeError('open this chat first', 409, 'not_opened');
  const busy = await db.execute(sql`SELECT 1 FROM analysis_jobs WHERE chat_id = ${chat.id}::uuid AND status IN ('pending','running') LIMIT 1`);
  if (busy.rows.length) return { analysing: 0, note: 'Analysis is already running for this chat.' };
  // Messages no analysis covers (e.g. their jobs were cancelled) are queued again:
  // entries held by cancelled/failed jobs are released, never-queued ones are added.
  const uncovered = sql`
    m.chat_id = ${chat.id}::uuid AND m.state = 'active' AND m.kind IN ('text','media') AND (m.expires_at IS NULL OR m.expires_at > now())
    AND NOT EXISTS (SELECT 1 FROM placements p WHERE p.message_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM analysis_units u WHERE u.chat_id = m.chat_id AND u.message_refs @> jsonb_build_array(jsonb_build_object('m', m.id::text)))`;
  await db.execute(sql`
    UPDATE analysis_outbox o SET dispatched_job_id = NULL, deletion_generation = ${chat.deletionGeneration}, selection_epoch = ${chat.selectionEpoch}
    FROM messages m, analysis_jobs j
    WHERE o.message_id = m.id AND o.revision = m.content_revision AND j.id = o.dispatched_job_id AND j.status IN ('cancelled','failed') AND ${uncovered}`);
  await db.execute(sql`
    INSERT INTO analysis_outbox (workspace_id, chat_id, message_id, revision, deletion_generation, selection_epoch)
    SELECT m.workspace_id, m.chat_id, m.id, m.content_revision, ${chat.deletionGeneration}, ${chat.selectionEpoch}
    FROM messages m WHERE ${uncovered}
    ON CONFLICT (message_id, revision) DO NOTHING`);
  const waiting = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM analysis_outbox WHERE chat_id = ${chat.id}::uuid AND dispatched_job_id IS NULL`);
  const n = waiting.rows[0].n;
  // Messages already analysed but never placed (their map build was cancelled) need a fresh build.
  const unplaced = await db.execute<{ n: number }>(sql`
    SELECT COALESCE(sum(jsonb_array_length(message_refs)), 0)::int AS n FROM analysis_units WHERE chat_id = ${chat.id}::uuid AND assigned_topic_id IS NULL`);
  const stranded = n === 0 ? unplaced.rows[0].n : 0;
  if (stranded) await requestRebuild(db, chat.id);
  if (n) await db.update(s.chats).set({ autoAnalyzeUntil: new Date(Date.now() + REFRESH_WINDOW_MS) }).where(eq(s.chats.id, chat.id));
  const total = n + stranded;
  // Nothing new, but the map breaks a readability rule (a level too wide, a topic joining subjects): tidy it.
  if (!total && (await mapNeedsTidy(db, chat.id))) {
    await requestRebuild(db, chat.id);
    return { analysing: 0, note: 'Tidying the map into broader, single-subject topics with NVIDIA Nemotron…' };
  }
  return { analysing: total, note: total ? `Analysing ${total} message${total === 1 ? '' : 's'} with NVIDIA Nemotron…` : 'Already up to date.' };
}

export async function requestHistory(db: Db, ctx: AuthCtx, chatId: string) {
  const chat = await requireChat(db, ctx, chatId);
  ownerOnly(ctx);
  if (chat.sourceKind !== 'whatsapp' || !chat.selected) throw new SafeError('history requests apply to selected WhatsApp chats only');
  // Older pages past the per-chat history limit would be dropped on arrival; say so instead.
  const [cov] = await db.select().from(s.syncCoverage).where(eq(s.syncCoverage.chatId, chat.id));
  if (cov?.historyState === 'limited') {
    return { limited: true, note: `This chat already has the ${cov.historyCount.toLocaleString('en-US')} older messages ThreadMap keeps per chat (WHATSAPP_HISTORY_MAX_MESSAGES_PER_CHAT). Raise that limit to load more.` };
  }
  // Every older page the phone still has, up to the per-chat cap.
  const cmd = await enqueueCommand(db, ctx, 'request_history', { chatId, backfill: true });
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

// Media players are allowed inline too; the sandbox CSP below still applies to the response.
const INLINE_SAFE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'application/pdf', 'video/mp4', 'audio/ogg', 'audio/mpeg', 'audio/mp4']);

/** WhatsApp's small embedded preview of an image/video, shown before (or instead of) the download. */
export async function attachmentPreview(db: Db, ctx: AuthCtx, attachmentId: string) {
  const a = await authorizedAttachment(db, ctx, attachmentId);
  if (!a.thumbnail) throw new SafeError('no preview', 404, 'not_found');
  return new Response(new Uint8Array(a.thumbnail), {
    headers: { 'content-type': 'image/jpeg', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'", 'cache-control': 'private, max-age=86400' },
  });
}

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

/**
 * Unopen: ThreadMap stops capturing the chat and deletes its messages, files and
 * map, so Nemotron never analyses it again. Nothing changes in WhatsApp; the chat
 * goes back to the list of chats to open (name, type, time and photo only).
 */
export async function unopenChat(db: Db, ctx: AuthCtx, chatId: string) {
  ownerOnly(ctx);
  await requireChat(db, ctx, chatId);
  const storage = getStorage();
  await deleteChat(db, ctx.workspaceId, chatId, (k) => storage.delete(k), { keepAvatar: true });
  return { unopened: true };
}

export async function rebuildChat(db: Db, ctx: AuthCtx, chatId: string) {
  await requireChat(db, ctx, chatId);
  const id = await requestRebuild(db, chatId);
  await notifyChange(db, { ws: ctx.workspaceId, kind: 'analysis', chatId });
  return { job_id: id, note: 'Rebuild runs within the per-job inference budget and preserves your corrections.' };
}

/** "Rebuild map": a fresh map from the discussions already read, under the current rules. */
export async function rebuildChatFromScratch(db: Db, ctx: AuthCtx, chatId: string) {
  ownerOnly(ctx);
  const chat = await requireChat(db, ctx, chatId);
  if (!chat.selected) throw new SafeError('open this chat first', 409, 'not_opened');
  const id = await rebuildMapFromScratch(db, chat.id);
  if (!id) throw new SafeError('Analysis is running for this chat; rebuild the map once it finishes.', 409, 'busy');
  await notifyChange(db, { ws: ctx.workspaceId, kind: 'analysis', chatId: chat.id });
  return { job_id: id, note: 'Rebuilding the map from scratch with NVIDIA Nemotron…' };
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
