// Canonical source persistence. Every accepted native event, live or replayed,
// goes through this module inside a transaction that also writes the analysis
// outbox, so no model call ever precedes a durable source commit.
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as s from '../../db/schema';
import type { Db, Tx } from '../db';
import { notifyChange } from '../notify';
import { attachmentObjectKey, type StorageAdapter } from '../storage';
import { canonicalUrl, extractUrls, normalizeSearch, sha256 } from '../util';
import type { AliasEvent, ChatMetaEvent, EditEvent, MessageEvent, NormalizedEvent, RevokeEvent } from './types';

export interface IngestContext {
  workspaceId: string;
  linkedAccountId: string | null;
  sourceKind: 'whatsapp' | 'fixture';
  historyCapPerChat: number;
  /** Encrypt native media download material (companion only). */
  sealMediaRef?: (plain: string, aad: string) => Buffer;
  storage?: StorageAdapter;
  now?: () => Date;
  /** Lease fencing check (live companion): throws if this process lost ownership. */
  fence?: (tx: Tx) => Promise<void>;
}

export interface IngestStats {
  inserted: number;
  duplicates: number;
  edits: number;
  revokes: number;
  pendingControls: number;
  staleIgnored: number;
  excludedUnselected: number;
  excludedCutoff: number;
  excludedHistoryCap: number;
  ignored: number;
  conflicts: number;
}

const emptyStats = (): IngestStats => ({
  inserted: 0,
  duplicates: 0,
  edits: 0,
  revokes: 0,
  pendingControls: 0,
  staleIgnored: 0,
  excludedUnselected: 0,
  excludedCutoff: 0,
  excludedHistoryCap: 0,
  ignored: 0,
  conflicts: 0,
});

export const nativeKeyHash = (nativeId: string, fromMe: boolean) => sha256(`${nativeId}|${fromMe ? 1 : 0}`);

export function revisionDigest(kind: string, body: string | null, attachmentDescriptors: string[]): string {
  return sha256(`${kind}\u0000${body ?? ''}\u0000${attachmentDescriptors.join('\u0001')}`);
}

const eventChatJid = (e: NormalizedEvent): string | null =>
  e.type === 'message' || e.type === 'edit' || e.type === 'revoke' || e.type === 'chat_meta' ? e.chatJid : null;

type ChatRow = typeof s.chats.$inferSelect;

/** Resolve a native JID (or its alias) to a known chat row in this workspace/account. */
export async function findChatByJid(db: Db | Tx, ctx: IngestContext, jid: string): Promise<ChatRow | undefined> {
  const viaAlias = await db
    .select({ chat: s.chats })
    .from(s.chatAliases)
    .innerJoin(s.chats, eq(s.chats.id, s.chatAliases.chatId))
    .where(and(eq(s.chatAliases.workspaceId, ctx.workspaceId), eq(s.chatAliases.aliasJid, jid)))
    .limit(1);
  if (viaAlias[0]) return viaAlias[0].chat;
  const direct = await db
    .select()
    .from(s.chats)
    .where(
      and(
        eq(s.chats.workspaceId, ctx.workspaceId),
        eq(s.chats.sourceKind, ctx.sourceKind),
        eq(s.chats.nativeJid, jid),
        ctx.linkedAccountId ? eq(s.chats.linkedAccountId, ctx.linkedAccountId) : sql`${s.chats.linkedAccountId} IS NULL`,
      ),
    )
    .limit(1);
  return direct[0];
}

/** Record minimal discovery metadata (identity/title/type only, never content). */
export async function upsertDiscoveredChat(db: Db | Tx, ctx: IngestContext, ev: ChatMetaEvent): Promise<ChatRow> {
  const existing = (await findChatByJid(db, ctx, ev.chatJid)) ?? (ev.chatJidAlt ? await findChatByJid(db, ctx, ev.chatJidAlt) : undefined);
  if (existing) {
    if (ev.title && ev.title !== existing.title) {
      await db.update(s.chats).set({ title: ev.title }).where(eq(s.chats.id, existing.id));
    }
    if (ev.chatJidAlt) await addChatAlias(db, ctx, existing.id, ev.chatJidAlt, 'native_alt');
    return { ...existing, title: ev.title ?? existing.title };
  }
  const [row] = await db
    .insert(s.chats)
    .values({
      workspaceId: ctx.workspaceId,
      linkedAccountId: ctx.linkedAccountId,
      sourceKind: ctx.sourceKind,
      nativeJid: ev.chatJid,
      kind: ev.kind,
      title: ev.title ?? (ev.kind === 'group' ? 'Unnamed group' : 'Direct chat'),
    })
    .onConflictDoUpdate({
      target: [s.chats.workspaceId, s.chats.sourceKind, s.chats.linkedAccountId, s.chats.nativeJid],
      set: { title: sql`COALESCE(${ev.title}, ${s.chats.title})` },
    })
    .returning();
  await addChatAlias(db, ctx, row.id, ev.chatJid, 'native');
  if (ev.chatJidAlt) await addChatAlias(db, ctx, row.id, ev.chatJidAlt, 'native_alt');
  await db.insert(s.syncCoverage).values({ chatId: row.id }).onConflictDoNothing();
  return row;
}

async function addChatAlias(db: Db | Tx, ctx: IngestContext, chatId: string, jid: string, source: string) {
  await db.insert(s.chatAliases).values({ chatId, workspaceId: ctx.workspaceId, aliasJid: jid, source }).onConflictDoNothing();
}

/** Resolve a participant by any known alias, creating one if unseen. */
async function resolveParticipant(tx: Tx, ctx: IngestContext, jid: string, altJid: string | null, name: string | null, isSelf: boolean) {
  const candidates = [jid, altJid].filter((j): j is string => Boolean(j));
  const found = await tx
    .select({ participantId: s.participantAliases.participantId })
    .from(s.participantAliases)
    .where(and(eq(s.participantAliases.workspaceId, ctx.workspaceId), inArray(s.participantAliases.aliasJid, candidates)))
    .limit(1);
  let pid = found[0]?.participantId;
  if (!pid) {
    const [p] = await tx
      .insert(s.participants)
      .values({ workspaceId: ctx.workspaceId, canonicalJid: jid, displayName: name, isSelf })
      .onConflictDoUpdate({ target: [s.participants.workspaceId, s.participants.canonicalJid], set: { isSelf } })
      .returning({ id: s.participants.id });
    pid = p.id;
  } else if (name) {
    await tx.update(s.participants).set({ displayName: name }).where(eq(s.participants.id, pid));
  }
  for (const c of candidates) {
    await tx
      .insert(s.participantAliases)
      .values({ workspaceId: ctx.workspaceId, aliasJid: c, participantId: pid, source: c === jid ? 'native' : 'native_alt' })
      .onConflictDoNothing();
  }
  return pid;
}

/**
 * Apply an authoritative PN↔LID mapping: merge participant identities and chat
 * aliases. Never inferred from names or payload text.
 */
async function applyAlias(tx: Tx, ctx: IngestContext, ev: AliasEvent) {
  const rows = await tx
    .select()
    .from(s.participantAliases)
    .where(and(eq(s.participantAliases.workspaceId, ctx.workspaceId), inArray(s.participantAliases.aliasJid, [ev.pn, ev.lid])));
  const ids = [...new Set(rows.map((r) => r.participantId))];
  if (ids.length === 2) {
    const [keep, drop] = ids;
    await tx.update(s.messages).set({ senderParticipantId: keep }).where(eq(s.messages.senderParticipantId, drop));
    await tx.update(s.participantAliases).set({ participantId: keep }).where(eq(s.participantAliases.participantId, drop));
    await tx.delete(s.participants).where(eq(s.participants.id, drop));
  } else if (ids.length === 1) {
    for (const j of [ev.pn, ev.lid]) {
      await tx
        .insert(s.participantAliases)
        .values({ workspaceId: ctx.workspaceId, aliasJid: j, participantId: ids[0], source: 'lid_mapping' })
        .onConflictDoNothing();
    }
  }
  // Direct chats can be addressed by either form.
  for (const [a, b] of [
    [ev.pn, ev.lid],
    [ev.lid, ev.pn],
  ] as const) {
    const chat = await findChatByJid(tx, ctx, a);
    if (chat && chat.kind === 'direct') {
      const other = await findChatByJid(tx, ctx, b);
      if (!other) await addChatAlias(tx, ctx, chat.id, b, 'lid_mapping');
      else if (other.id !== chat.id) {
        await tx
          .update(s.syncCoverage)
          .set({ warnings: sql`${s.syncCoverage.warnings} || ${JSON.stringify([{ type: 'alias_conflict', at: new Date().toISOString() }])}::jsonb` })
          .where(eq(s.syncCoverage.chatId, chat.id));
      }
    }
  }
}

function attachmentDescriptor(a: MessageEvent['attachments'][number]) {
  return `${a.mediaType}|${a.mime ?? ''}|${a.filename ?? ''}|${a.size ?? ''}`;
}

function buildSearchText(body: string | null, sender: string, filenames: (string | null)[], urls: string[]): string {
  return normalizeSearch([body ?? '', sender, ...filenames.filter(Boolean), ...urls].join(' '));
}

async function bumpSource(tx: Tx, chatId: string): Promise<number> {
  const [r] = await tx
    .update(s.chats)
    .set({ sourceVersion: sql`${s.chats.sourceVersion} + 1`, lastEventAt: sql`now()` })
    .where(eq(s.chats.id, chatId))
    .returning({ v: s.chats.sourceVersion });
  return r.v;
}

/**
 * Persist a batch of normalized events. Events for unselected/excluded chats
 * are reported back (excludedUnselected) and never stored with content.
 * Returns stats plus the set of events the caller may buffer pre-selection.
 */
export async function ingestEvents(db: Db, ctx: IngestContext, events: NormalizedEvent[]): Promise<{ stats: IngestStats; unselected: MessageEvent[] }> {
  const stats = emptyStats();
  const unselected: MessageEvent[] = [];

  // Discovery metadata and alias mappings first (content-free).
  for (const e of events) {
    if (e.type === 'chat_meta') await upsertDiscoveredChat(db, ctx, e);
  }
  const aliases = events.filter((e): e is AliasEvent => e.type === 'alias');
  if (aliases.length) {
    await db.transaction(async (tx) => {
      for (const a of aliases) await applyAlias(tx, ctx, a);
    });
  }

  const byChat = new Map<string, NormalizedEvent[]>();
  for (const e of events) {
    if (e.type === 'ignored') {
      stats.ignored++;
      continue;
    }
    const jid = eventChatJid(e);
    if (!jid || e.type === 'chat_meta') continue;
    const list = byChat.get(jid) ?? [];
    list.push(e);
    byChat.set(jid, list);
  }

  for (const [jid, list] of byChat) {
    let chat = await findChatByJid(db, ctx, jid);
    if (!chat) {
      const first = list.find((e): e is MessageEvent => e.type === 'message');
      if (first) {
        chat = await upsertDiscoveredChat(db, ctx, {
          type: 'chat_meta',
          chatJid: jid,
          chatJidAlt: first.chatJidAlt,
          kind: first.chatKind,
          title: null,
        });
      }
    }
    if (!chat) {
      // Control events for chats we have never seen: nothing durable to protect.
      stats.ignored += list.length;
      continue;
    }
    const chatId = chat.id;
    const outcome = await db.transaction(async (tx) => {
      // Serialize with deletion/selection changes for this chat.
      const [locked] = await tx.select().from(s.chats).where(eq(s.chats.id, chatId)).for('update');
      if (ctx.fence) await ctx.fence(tx);
      if (!locked.selected || locked.excluded) {
        return { changed: false, unselected: list.filter((e): e is MessageEvent => e.type === 'message') };
      }
      let changed = false;
      for (const e of list) {
        if (e.type === 'message') changed = (await applyMessage(tx, ctx, locked, e, stats)) || changed;
        else if (e.type === 'edit') changed = (await applyEdit(tx, ctx, locked, e, stats)) || changed;
        else if (e.type === 'revoke') changed = (await applyRevoke(tx, ctx, locked, e, 'revoked', stats)) || changed;
      }
      if (changed) {
        const v = await bumpSource(tx, chatId);
        await notifyChange(tx, { ws: ctx.workspaceId, kind: 'source', chatId, version: v });
      }
      return { changed, unselected: [] as MessageEvent[] };
    });
    if (outcome.unselected.length) {
      stats.excludedUnselected += outcome.unselected.length;
      unselected.push(...outcome.unselected);
    }
  }
  return { stats, unselected };
}

async function applyMessage(tx: Tx, ctx: IngestContext, chat: ChatRow, e: MessageEvent, stats: IngestStats): Promise<boolean> {
  const hash = nativeKeyHash(e.nativeId, e.fromMe);
  const [existing] = await tx
    .select({ id: s.messages.id, state: s.messages.state, digest: s.messages.revisionDigest, kind: s.messages.kind, body: s.messages.body })
    .from(s.messages)
    .where(and(eq(s.messages.chatId, chat.id), eq(s.messages.nativeKeyHash, hash)));
  if (existing) {
    // Replay/backfill duplicate: never resurrect a tombstone or overwrite a newer edit.
    if (existing.state !== 'active') stats.staleIgnored++;
    else if (existing.kind === e.kind && (e.body ?? null) !== (existing.body ?? null) && e.kind !== 'system') {
      // Same native message with different content and no edit event: keep the
      // observed evidence and flag the conflict instead of silently replacing it.
      stats.conflicts++;
      await tx
        .update(s.syncCoverage)
        .set({ warnings: sql`${s.syncCoverage.warnings} || ${JSON.stringify([{ type: 'content_conflict', at: new Date().toISOString() }])}::jsonb` })
        .where(eq(s.syncCoverage.chatId, chat.id));
    } else stats.duplicates++;
    return false;
  }

  const sentAt = e.sentAtSec !== null ? new Date(e.sentAtSec * 1000) : null;
  const human = e.kind === 'text' || e.kind === 'media';

  // Selection cutoff for "new messages from now".
  if (chat.historyMode === 'new_only') {
    if (!sentAt) {
      stats.excludedCutoff++;
      await tx
        .update(s.syncCoverage)
        .set({ unknownTimeExcluded: sql`${s.syncCoverage.unknownTimeExcluded} + 1` })
        .where(eq(s.syncCoverage.chatId, chat.id));
      return false;
    }
    if (chat.newOnlyCutoff && sentAt < chat.newOnlyCutoff) {
      stats.excludedCutoff++;
      await tx
        .update(s.syncCoverage)
        .set({ excludedBeforeCutoff: sql`${s.syncCoverage.excludedBeforeCutoff} + 1` })
        .where(eq(s.syncCoverage.chatId, chat.id));
      return false;
    }
  }

  // Initial-history backfill cap (never applies to live arrivals).
  if (e.origin !== 'live') {
    const [cov] = await tx.select().from(s.syncCoverage).where(eq(s.syncCoverage.chatId, chat.id));
    if (cov && cov.historyCount >= ctx.historyCapPerChat) {
      stats.excludedHistoryCap++;
      if (cov.historyState !== 'limited') {
        await tx.update(s.syncCoverage).set({ historyState: 'limited' }).where(eq(s.syncCoverage.chatId, chat.id));
      }
      return false;
    }
  }

  // Out-of-order control events that arrived before this base message.
  const pending = await tx
    .select()
    .from(s.controlEvents)
    .where(and(eq(s.controlEvents.chatId, chat.id), eq(s.controlEvents.targetNativeId, e.nativeId), eq(s.controlEvents.applied, false)));
  const pendingRevoke = pending.find((p) => p.type === 'revoke' || p.type === 'expire');
  const pendingEdits = pending.filter((p) => p.type === 'edit').sort((a, b) => (a.eventTime?.getTime() ?? 0) - (b.eventTime?.getTime() ?? 0));

  const senderParticipantId = await resolveParticipant(
    tx,
    ctx,
    e.fromMe ? 'self' : e.senderJid,
    e.fromMe ? null : (e.participantAltJid ?? null),
    e.senderName,
    e.fromMe,
  );
  const senderLabel = e.fromMe ? 'You' : (e.senderName ?? 'Unknown sender');
  const now = ctx.now?.() ?? new Date();
  const expiresAt = e.ephemeralSec && sentAt ? new Date(sentAt.getTime() + e.ephemeralSec * 1000) : null;
  const latestEdit = pendingEdits.at(-1);
  const body = pendingRevoke ? null : (latestEdit?.editBody ?? e.body);
  const descriptors = e.attachments.map(attachmentDescriptor);
  const urls = extractUrls(body);
  const state = pendingRevoke ? (pendingRevoke.type === 'expire' ? 'expired' : 'revoked') : expiresAt && expiresAt <= now ? 'expired' : 'active';
  const revision = state === 'active' && latestEdit ? 2 : 1;

  const [msg] = await tx
    .insert(s.messages)
    .values({
      workspaceId: ctx.workspaceId,
      chatId: chat.id,
      nativeKeyHash: nativeKeyHash(e.nativeId, e.fromMe),
      nativeId: e.nativeId,
      fromMe: e.fromMe,
      nativeKey: { remoteJid: e.chatJid, remoteJidAlt: e.chatJidAlt ?? null, participant: e.participantJid, participantAlt: e.participantAltJid },
      senderParticipantId,
      senderLabel,
      direction: e.fromMe ? 'outgoing' : 'incoming',
      kind: e.kind,
      state,
      body: state === 'active' ? body : null,
      searchText: state === 'active' ? buildSearchText(body, senderLabel, e.attachments.map((a) => a.filename), urls) : null,
      sentAt,
      sentAtRaw: e.sentAtSec !== null ? String(e.sentAtSec) : null,
      receivedAt: now,
      editedAt: state === 'active' && latestEdit ? latestEdit.eventTime : null,
      contentRevision: revision,
      revisionDigest: revisionDigest(e.kind, state === 'active' ? body : null, descriptors),
      replyToNativeId: e.replyToNativeId,
      expiresAt,
      ingestEventType: `${e.origin}:${e.marker ?? e.kind}`,
    })
    .returning({ id: s.messages.id });

  if (pending.length) {
    await tx.update(s.controlEvents).set({ applied: true, editBody: null }).where(inArray(s.controlEvents.id, pending.map((p) => p.id)));
  }
  if (state !== 'active') {
    stats.pendingControls += pending.length;
    stats.revokes++;
    return true;
  }

  await tx.insert(s.messageRevisions).values({ messageId: msg.id, revision, body, digest: revisionDigest(e.kind, body, descriptors) });

  for (const [i, a] of e.attachments.entries()) {
    const [att] = await tx
      .insert(s.attachments)
      .values({
        workspaceId: ctx.workspaceId,
        messageId: msg.id,
        ordinal: i,
        mediaType: a.mediaType,
        declaredMime: a.mime,
        filename: a.filename,
        declaredSize: a.size,
        availability: a.fixtureAvailability ?? (a.mediaRef || a.fixtureBytesB64 ? 'available' : 'unavailable'),
        viewOnce: a.viewOnce,
        expiresAt,
      })
      .returning({ id: s.attachments.id });
    if (a.mediaRef && ctx.sealMediaRef) {
      await tx.update(s.attachments).set({ mediaRef: ctx.sealMediaRef(a.mediaRef, `media:${att.id}`) }).where(eq(s.attachments.id, att.id));
    }
    if (a.fixtureBytesB64 && ctx.storage && !a.fixtureAvailability) {
      // Fixture attachments stand in for a completed on-demand fetch.
      const bytes = Buffer.from(a.fixtureBytesB64, 'base64');
      const key = attachmentObjectKey(ctx.workspaceId, att.id);
      await ctx.storage.put(key, bytes, a.mime ?? 'application/octet-stream');
      await tx
        .update(s.attachments)
        .set({ availability: 'cached', objectKey: key, byteCount: bytes.length, contentHash: sha256(bytes), detectedMime: a.mime })
        .where(eq(s.attachments.id, att.id));
    }
    await tx.insert(s.resources).values({
      workspaceId: ctx.workspaceId,
      chatId: chat.id,
      messageId: msg.id,
      kind: 'attachment',
      attachmentId: att.id,
      label: a.filename ?? a.mediaType,
    });
  }
  for (const u of urls) {
    await tx.insert(s.resources).values({ workspaceId: ctx.workspaceId, chatId: chat.id, messageId: msg.id, kind: 'url', url: u, canonicalUrl: canonicalUrl(u), label: u });
  }

  if (human) {
    await tx
      .insert(s.analysisOutbox)
      .values({
        workspaceId: ctx.workspaceId,
        chatId: chat.id,
        messageId: msg.id,
        revision,
        deletionGeneration: chat.deletionGeneration,
        selectionEpoch: chat.selectionEpoch,
      })
      .onConflictDoNothing();
  }

  const isHistory = e.origin !== 'live';
  await tx
    .insert(s.syncCoverage)
    .values({ chatId: chat.id })
    .onConflictDoNothing();
  await tx
    .update(s.syncCoverage)
    .set({
      historyCount: isHistory ? sql`${s.syncCoverage.historyCount} + 1` : s.syncCoverage.historyCount,
      liveCount: isHistory ? s.syncCoverage.liveCount : sql`${s.syncCoverage.liveCount} + 1`,
      historyState: isHistory ? sql`CASE WHEN ${s.syncCoverage.historyState} = 'not_requested' THEN 'receiving' ELSE ${s.syncCoverage.historyState} END` : s.syncCoverage.historyState,
      earliestAt: sentAt ? sql`LEAST(COALESCE(${s.syncCoverage.earliestAt}, ${sentAt}), ${sentAt})` : s.syncCoverage.earliestAt,
      latestAt: sentAt ? sql`GREATEST(COALESCE(${s.syncCoverage.latestAt}, ${sentAt}), ${sentAt})` : s.syncCoverage.latestAt,
      updatedAt: sql`now()`,
    })
    .where(eq(s.syncCoverage.chatId, chat.id));
  stats.inserted++;
  if (pending.length) stats.pendingControls += pending.length;
  return true;
}

/** Find the target message for a control event by native id (and fromMe when ambiguous). */
async function findTarget(tx: Tx, chatId: string, nativeId: string, fromMe: boolean) {
  const rows = await tx
    .select()
    .from(s.messages)
    .where(and(eq(s.messages.chatId, chatId), eq(s.messages.nativeId, nativeId)));
  if (rows.length <= 1) return rows[0];
  return rows.find((r) => r.fromMe === fromMe) ?? rows[0];
}

async function recordControl(tx: Tx, ctx: IngestContext, chatId: string, ev: EditEvent | RevokeEvent, type: 'edit' | 'revoke' | 'expire', applied: boolean): Promise<boolean> {
  const t = ev.type === 'edit' ? ev.editTimeSec : ev.timeSec;
  const r = await tx
    .insert(s.controlEvents)
    .values({
      workspaceId: ctx.workspaceId,
      chatId,
      eventKey: ev.eventKey,
      targetNativeId: ev.targetNativeId,
      type,
      editBody: ev.type === 'edit' && !applied ? ev.newBody : null,
      eventTime: t !== null ? new Date(t * 1000) : null,
      applied,
    })
    .onConflictDoNothing()
    .returning({ id: s.controlEvents.id });
  return r.length > 0;
}

async function applyEdit(tx: Tx, ctx: IngestContext, chat: ChatRow, e: EditEvent, stats: IngestStats): Promise<boolean> {
  const target = await findTarget(tx, chat.id, e.targetNativeId, e.fromMe);
  if (!target) {
    if (await recordControl(tx, ctx, chat.id, e, 'edit', false)) stats.pendingControls++;
    else stats.duplicates++;
    return false;
  }
  if (!(await recordControl(tx, ctx, chat.id, e, 'edit', true))) {
    stats.duplicates++;
    return false;
  }
  const editAt = e.editTimeSec !== null ? new Date(e.editTimeSec * 1000) : new Date();
  if (target.state !== 'active') {
    stats.staleIgnored++;
    return false;
  }
  if (target.editedAt && editAt <= target.editedAt) {
    stats.staleIgnored++;
    return false;
  }
  if ((target.body ?? null) === e.newBody) {
    stats.duplicates++;
    return false;
  }
  const atts = await tx.select().from(s.attachments).where(eq(s.attachments.messageId, target.id)).orderBy(s.attachments.ordinal);
  const descriptors = atts.map((a) => `${a.mediaType}|${a.declaredMime ?? ''}|${a.filename ?? ''}|${a.declaredSize ?? ''}`);
  const revision = target.contentRevision + 1;
  const digest = revisionDigest(target.kind, e.newBody, descriptors);
  const urls = extractUrls(e.newBody);
  await tx
    .update(s.messages)
    .set({
      body: e.newBody,
      searchText: buildSearchText(e.newBody, target.senderLabel, atts.map((a) => a.filename), urls),
      contentRevision: revision,
      revisionDigest: digest,
      editedAt: editAt,
      updatedAt: sql`now()`,
    })
    .where(eq(s.messages.id, target.id));
  await tx.insert(s.messageRevisions).values({ messageId: target.id, revision, body: e.newBody, digest });
  await tx.delete(s.resources).where(and(eq(s.resources.messageId, target.id), eq(s.resources.kind, 'url')));
  for (const u of urls) {
    await tx.insert(s.resources).values({ workspaceId: ctx.workspaceId, chatId: chat.id, messageId: target.id, kind: 'url', url: u, canonicalUrl: canonicalUrl(u), label: u });
  }
  await invalidateDerived(tx, target.id);
  await tx
    .insert(s.analysisOutbox)
    .values({ workspaceId: ctx.workspaceId, chatId: chat.id, messageId: target.id, revision, deletionGeneration: chat.deletionGeneration, selectionEpoch: chat.selectionEpoch })
    .onConflictDoNothing();
  stats.edits++;
  return true;
}

/** Suppress claims and links that cite this message; generated prose must be regenerated. */
export async function invalidateDerived(tx: Tx, messageId: string) {
  await tx.execute(sql`
    UPDATE summary_claims SET valid = false
    WHERE valid AND id IN (SELECT claim_id FROM claim_evidence WHERE message_id = ${messageId})`);
  await tx.execute(sql`
    UPDATE cross_chat_links SET status = 'suppressed', updated_at = now()
    WHERE status = 'verified' AND (
      a_evidence @> ${JSON.stringify([{ messageId }])}::jsonb OR b_evidence @> ${JSON.stringify([{ messageId }])}::jsonb)`);
}

/** Tombstone a message: purge body, revisions, search text, files, placements and derivatives. */
export async function tombstoneMessage(tx: Tx, ctx: { storage?: StorageAdapter }, messageId: string, state: 'revoked' | 'expired' | 'deleted') {
  await tx
    .update(s.messages)
    .set({ state, body: null, searchText: null, updatedAt: sql`now()` })
    .where(eq(s.messages.id, messageId));
  await tx.update(s.messageRevisions).set({ body: null }).where(eq(s.messageRevisions.messageId, messageId));
  const atts = await tx.select({ id: s.attachments.id, objectKey: s.attachments.objectKey }).from(s.attachments).where(eq(s.attachments.messageId, messageId));
  await tx
    .update(s.attachments)
    .set({ availability: 'unavailable', mediaRef: null, objectKey: null, failureReason: state, updatedAt: sql`now()` })
    .where(eq(s.attachments.messageId, messageId));
  await tx.delete(s.resources).where(eq(s.resources.messageId, messageId));
  await tx.delete(s.placements).where(eq(s.placements.messageId, messageId));
  await invalidateDerived(tx, messageId);
  // Remove cached bytes; content is already unreachable via the DB if this fails.
  if (ctx.storage) {
    for (const a of atts) if (a.objectKey) await ctx.storage.delete(a.objectKey).catch(() => undefined);
  }
}

async function applyRevoke(tx: Tx, ctx: IngestContext, chat: ChatRow, e: RevokeEvent, state: 'revoked' | 'expired', stats: IngestStats): Promise<boolean> {
  const target = await findTarget(tx, chat.id, e.targetNativeId, e.fromMe);
  if (!target) {
    if (await recordControl(tx, ctx, chat.id, e, state === 'expired' ? 'expire' : 'revoke', false)) stats.pendingControls++;
    else stats.duplicates++;
    return false;
  }
  await recordControl(tx, ctx, chat.id, e, state === 'expired' ? 'expire' : 'revoke', true);
  if (target.state !== 'active') {
    stats.duplicates++;
    return false;
  }
  await tombstoneMessage(tx, ctx, target.id, state);
  stats.revokes++;
  return true;
}

/** Expire disappearing messages whose known expiry has passed (background sweep). */
export async function sweepExpired(db: Db, storage?: StorageAdapter): Promise<number> {
  const due = await db
    .select({ id: s.messages.id, chatId: s.messages.chatId, ws: s.messages.workspaceId })
    .from(s.messages)
    .where(and(eq(s.messages.state, 'active'), sql`${s.messages.expiresAt} <= now()`))
    .limit(500);
  for (const m of due) {
    await db.transaction(async (tx) => {
      await tombstoneMessage(tx, { storage }, m.id, 'expired');
      const v = await bumpSource(tx, m.chatId);
      await notifyChange(tx, { ws: m.ws, kind: 'source', chatId: m.chatId, version: v });
    });
  }
  return due.length;
}
