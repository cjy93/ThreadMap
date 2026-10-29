// Canonical source persistence. Every accepted native event, live or replayed,
// goes through this module inside a transaction that also writes the analysis
// outbox, so no model call ever precedes a durable source commit.
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as s from '../../db/schema';
import type { Db, Tx } from '../db';
import { notifyChange } from '../notify';
import { attachmentObjectKey, type StorageAdapter } from '../storage';
import { canonicalUrl, extractUrls, normalizeSearch, sha256 } from '../util';
import type { AliasEvent, ChatMetaEvent, ContactEvent, EditEvent, MessageEvent, NormalizedEvent, RevokeEvent, StarEvent } from './types';

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
  e.type === 'message' || e.type === 'edit' || e.type === 'revoke' || e.type === 'star' || e.type === 'chat_meta' ? e.chatJid : null;

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

// Direct chats are named, in order of preference: the owner's saved contact
// name, the person's own WhatsApp name, their phone number.
// "Unknown contact": WhatsApp addresses the person by a hidden ID (@lid) and gave no name.
export const DIRECT_PLACEHOLDER = 'Unknown contact';
export const LEGACY_DIRECT_PLACEHOLDER = 'Direct chat';
const isUnknownTitle = (t: string) => t === DIRECT_PLACEHOLDER || t === LEGACY_DIRECT_PLACEHOLDER;
// WhatsApp's number privacy sends titles like "+65∙∙∙∙∙∙25": a number, not a name.
const isPlaceholderTitle = (t: string) => isUnknownTitle(t) || /^\+\d+$/.test(t) || /^\+\d*[∙•·]+\d*$/.test(t);

function phoneTitle(...jids: (string | null | undefined)[]): string | null {
  const pn = jids.find((j) => j?.endsWith('@s.whatsapp.net'));
  const digits = pn?.split('@')[0];
  return digits && /^\d+$/.test(digits) ? `+${digits}` : null;
}

async function knownName(db: Db | Tx, ctx: IngestContext, jids: string[]): Promise<string | null> {
  const [row] = await db
    .select({ name: s.participants.displayName })
    .from(s.participantAliases)
    .innerJoin(s.participants, eq(s.participants.id, s.participantAliases.participantId))
    .where(and(eq(s.participantAliases.workspaceId, ctx.workspaceId), inArray(s.participantAliases.aliasJid, jids), sql`${s.participants.displayName} !~ '^\\+?[0-9 ∙•·-]+$'`))
    .limit(1);
  return row?.name ?? null;
}

async function setDirectTitle(db: Db | Tx, chat: ChatRow, title: string) {
  if (chat.title === title) return;
  await db.update(s.chats).set({ title }).where(eq(s.chats.id, chat.id));
}

/** Remember a contact's name and apply it to their direct chat if one exists. */
async function applyContact(db: Db, ctx: IngestContext, ev: ContactEvent) {
  const jids = [ev.jid, ev.altJid].filter((j): j is string => Boolean(j));
  await db.transaction(async (tx) => {
    const [found] = await tx
      .select({ id: s.participantAliases.participantId })
      .from(s.participantAliases)
      .where(and(eq(s.participantAliases.workspaceId, ctx.workspaceId), inArray(s.participantAliases.aliasJid, jids)))
      .limit(1);
    // A saved name always wins; a self-chosen name only fills a gap.
    const display = ev.name ? sql`${ev.name}` : sql`COALESCE(${s.participants.displayName}, ${ev.pushName})`;
    let pid = found?.id;
    if (pid) await tx.update(s.participants).set({ displayName: display }).where(eq(s.participants.id, pid));
    else {
      const [p] = await tx
        .insert(s.participants)
        .values({ workspaceId: ctx.workspaceId, canonicalJid: ev.jid, displayName: ev.name ?? ev.pushName })
        .onConflictDoUpdate({ target: [s.participants.workspaceId, s.participants.canonicalJid], set: { displayName: display } })
        .returning({ id: s.participants.id });
      pid = p.id;
    }
    for (const j of jids) await tx.insert(s.participantAliases).values({ workspaceId: ctx.workspaceId, aliasJid: j, participantId: pid, source: 'contact' }).onConflictDoNothing();
  });
  let chat: ChatRow | undefined;
  for (const j of jids) chat ??= await findChatByJid(db, ctx, j);
  if (!chat || chat.kind !== 'direct') return;
  if (ev.name) await setDirectTitle(db, chat, ev.name);
  else if (ev.pushName && isPlaceholderTitle(chat.title)) await setDirectTitle(db, chat, ev.pushName);
}

/** Record minimal discovery metadata (identity/title/type only, never content). */
export async function upsertDiscoveredChat(db: Db | Tx, ctx: IngestContext, ev: ChatMetaEvent): Promise<ChatRow> {
  const existing = (await findChatByJid(db, ctx, ev.chatJid)) ?? (ev.chatJidAlt ? await findChatByJid(db, ctx, ev.chatJidAlt) : undefined);
  const activity = ev.lastActivitySec ? new Date(ev.lastActivitySec * 1000) : null;
  // A masked or bare number from WhatsApp never replaces a real name for a person.
  const weakTitle = ev.kind === 'direct' && ev.title !== null && isPlaceholderTitle(ev.title);
  if (existing) {
    if (ev.title && ev.title !== existing.title && !(weakTitle && !isPlaceholderTitle(existing.title))) {
      await db.update(s.chats).set({ title: ev.title }).where(eq(s.chats.id, existing.id));
    }
    if (activity && (!existing.lastEventAt || existing.lastEventAt < activity)) {
      await db.update(s.chats).set({ lastEventAt: sql`GREATEST(${s.chats.lastEventAt}, ${activity})` }).where(eq(s.chats.id, existing.id));
    }
    if (ev.chatJidAlt) await addChatAlias(db, ctx, existing.id, ev.chatJidAlt, 'native_alt');
    return { ...existing, title: ev.title ?? existing.title };
  }
  const fallback =
    ev.kind === 'group'
      ? 'Unnamed group'
      : // A masked title is kept rather than revealing the number WhatsApp chose to hide.
        ((await knownName(db, ctx, [ev.chatJid, ev.chatJidAlt].filter((j): j is string => Boolean(j)))) ??
        (weakTitle ? ev.title : null) ??
        phoneTitle(ev.chatJid, ev.chatJidAlt) ??
        DIRECT_PLACEHOLDER);
  const [row] = await db
    .insert(s.chats)
    .values({
      workspaceId: ctx.workspaceId,
      linkedAccountId: ctx.linkedAccountId,
      sourceKind: ctx.sourceKind,
      nativeJid: ev.chatJid,
      kind: ev.kind,
      title: weakTitle ? fallback : (ev.title ?? fallback),
      lastEventAt: activity,
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
      else if (other.id !== chat.id && other.kind === 'direct' && !(await mergeDirectChats(tx, ctx, chat, other))) {
        await tx
          .update(s.syncCoverage)
          .set({ warnings: sql`${s.syncCoverage.warnings} || ${JSON.stringify([{ type: 'alias_conflict', at: new Date().toISOString() }])}::jsonb` })
          .where(eq(s.syncCoverage.chatId, chat.id));
      }
      // Knowing the number behind a hidden ID lets a saved contact name apply (to the chat that
      // remains, if the two were just merged).
      const live = (await findChatByJid(tx, ctx, a)) ?? chat;
      const [current] = await tx.select().from(s.chats).where(eq(s.chats.id, live.id));
      if (isPlaceholderTitle(current.title)) {
        const name = (await knownName(tx, ctx, [ev.pn, ev.lid])) ?? (isUnknownTitle(current.title) ? phoneTitle(ev.pn) : null);
        if (name) await setDirectTitle(tx, current, name);
      }
    }
  }
}

/**
 * One person seen under both their number and their hidden ID became two direct
 * chats. Opening one then missed everything WhatsApp sent under the other
 * address (history included): unopened chats keep no content. Once a mapping
 * proves they are the same person, fold them into one. Only when at most one
 * of them holds messages; two filled chats stay apart (with a warning). The one
 * kept is the one with messages, else the opened one, else the older one.
 * Returns whether they were merged.
 */
async function mergeDirectChats(tx: Tx, ctx: IngestContext, a: ChatRow, b: ChatRow): Promise<boolean> {
  const count = async (id: string) => (await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM messages WHERE chat_id = ${id}::uuid`)).rows[0].n;
  const [na, nb] = [await count(a.id), await count(b.id)];
  if (na > 0 && nb > 0) return false;
  const keepA = na > 0 || (nb === 0 && (a.selected !== b.selected ? a.selected : a.createdAt <= b.createdAt));
  const [keep, drop] = keepA ? [a, b] : [b, a];
  // Every address of the dropped chat now reaches the kept one.
  await tx.update(s.chatAliases).set({ chatId: keep.id }).where(eq(s.chatAliases.chatId, drop.id));
  await addChatAlias(tx, ctx, keep.id, drop.nativeJid, 'lid_mapping');
  const newer = (x: ChatRow) => x.historyAnchor?.ts ?? 0;
  await tx
    .update(s.chats)
    .set({
      lastEventAt: sql`GREATEST(${s.chats.lastEventAt}, ${drop.lastEventAt})`,
      ...(newer(drop) > newer(keep) ? { historyAnchor: drop.historyAnchor } : {}),
      ...(!keep.avatarKey && drop.avatarKey ? { avatarKey: drop.avatarKey, avatarCheckedAt: drop.avatarCheckedAt } : {}),
      // Opened under either address means opened.
      ...(!keep.selected && drop.selected ? { selected: true, historyMode: drop.historyMode, newOnlyCutoff: drop.newOnlyCutoff, autoAnalyzeUntil: drop.autoAnalyzeUntil } : {}),
    })
    .where(eq(s.chats.id, keep.id));
  await tx.delete(s.chats).where(eq(s.chats.id, drop.id));
  return true;
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
    // lastEventAt is the newest message's own time (set in ingestEvents), not arrival time:
    // a history backfill must not make an old chat look new.
    .set({ sourceVersion: sql`${s.chats.sourceVersion} + 1` })
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
  for (const e of events) {
    if (e.type === 'contact') await applyContact(db, ctx, e);
  }
  // A group message carries its sender's own WhatsApp name (WhatsApp shows it as "~Name").
  // Only that name is kept, for groups selected or not, so people's direct chats can be named.
  const senders = new Set<string>();
  for (const e of events) {
    if (e.type !== 'message' || e.chatKind !== 'group' || e.fromMe || !e.participantJid || !e.senderName || senders.has(e.participantJid)) continue;
    if (/^\+?[\d\s∙•·-]+$/.test(e.senderName.trim())) continue;
    senders.add(e.participantJid);
    await applyContact(db, ctx, { type: 'contact', jid: e.participantJid, altJid: e.participantAltJid, name: null, pushName: e.senderName.trim() });
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
    // Last-message time keeps the chat list in WhatsApp order, selected or not;
    // only the time is kept for unselected chats, never their content.
    const newest = list
      .filter((e): e is MessageEvent => e.type === 'message' && Boolean(e.sentAtSec) && e.kind !== 'system')
      .reduce<MessageEvent | null>((a, e) => (!a || e.sentAtSec! > a.sentAtSec! ? e : a), null);
    if (chat && newest) {
      const ts = newest.sentAtSec!;
      const at = new Date(ts * 1000);
      const newerTime = !chat.lastEventAt || chat.lastEventAt < at;
      // The anchor lets history be requested later if this chat is selected after its history was discarded.
      const newerAnchor = !chat.historyAnchor || chat.historyAnchor.ts < ts;
      const historyAnchor = { remoteJid: newest.chatJid, id: newest.nativeId, fromMe: newest.fromMe, participant: newest.participantJid, ts };
      if (newerTime || newerAnchor) {
        await db
          .update(s.chats)
          .set({ ...(newerTime ? { lastEventAt: sql`GREATEST(${s.chats.lastEventAt}, ${at})` } : {}), ...(newerAnchor ? { historyAnchor } : {}) })
          .where(eq(s.chats.id, chat.id));
        chat = { ...chat, ...(newerTime ? { lastEventAt: at } : {}), ...(newerAnchor ? { historyAnchor } : {}) };
      }
    }
    if (chat?.kind === 'direct' && isPlaceholderTitle(chat.title)) {
      // The other person's own WhatsApp name, carried on their messages.
      const named = list.find((e): e is MessageEvent => e.type === 'message' && !e.fromMe && Boolean(e.senderName));
      if (named?.senderName) {
        await setDirectTitle(db, chat, named.senderName);
        chat = { ...chat, title: named.senderName };
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
        else if (e.type === 'star') changed = (await applyStar(tx, locked, e, stats)) || changed;
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
    .select({ id: s.messages.id, state: s.messages.state, digest: s.messages.revisionDigest, kind: s.messages.kind, body: s.messages.body, starred: s.messages.starred })
    .from(s.messages)
    .where(and(eq(s.messages.chatId, chat.id), eq(s.messages.nativeKeyHash, hash)));
  if (existing) {
    // A later sync of the same message may carry a star it did not have before.
    if (e.starred && !existing.starred) {
      await tx.update(s.messages).set({ starred: true, starredAt: new Date() }).where(eq(s.messages.id, existing.id));
      return true;
    }
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
    const cap = chat.historyLimit ? Math.min(chat.historyLimit, ctx.historyCapPerChat) : ctx.historyCapPerChat;
    if (cov && cov.historyCount >= cap) {
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
  // A one-to-one chat's other side is the chat itself when WhatsApp sends no name.
  const senderLabel = e.fromMe ? 'You' : (e.senderName ?? (chat.kind === 'direct' ? chat.title : 'Unknown sender'));
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
      starred: Boolean(e.starred),
      starredAt: e.starred ? now : null,
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
        thumbnail: a.thumbnailB64 ? Buffer.from(a.thumbnailB64, 'base64') : null,
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

/** Star or unstar a stored message, following the phone. */
async function applyStar(tx: Tx, chat: ChatRow, e: StarEvent, stats: IngestStats): Promise<boolean> {
  const target = await findTarget(tx, chat.id, e.targetNativeId, e.fromMe);
  if (!target || target.starred === e.starred) {
    stats.ignored++;
    return false;
  }
  await tx.update(s.messages).set({ starred: e.starred, starredAt: e.starred ? new Date() : null }).where(eq(s.messages.id, target.id));
  return true;
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
    .set({ availability: 'unavailable', mediaRef: null, objectKey: null, thumbnail: null, aiDescription: null, aiDescribedBy: null, failureReason: state, updatedAt: sql`now()` })
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
