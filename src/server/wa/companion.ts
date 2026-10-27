// Long-running Baileys companion. One socket per linked account, guarded by a
// database lease. Receives incoming AND owner-sent messages, persists selected
// sources before any analysis, never sends messages or read receipts.
import crypto from 'node:crypto';
import makeWASocket, { Browsers, DisconnectReason, downloadMediaMessage, fetchLatestWaWebVersion, makeCacheableSignalKeyStore, type WAMessageKey, type WASocket, type WAVersion } from 'baileys';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import pg from 'pg';
import pino from 'pino';
import * as s from '../../db/schema';
import type { WhatsAppConfig } from '../../lib/config';
import { COMMAND_CHANNEL } from '../api/connector';
import { EncryptionKeyError, openPacked, sealPacked } from '../crypto';
import { pgSslOptions, type Db } from '../db';
import { DIRECT_PLACEHOLDER, ingestEvents, LEGACY_DIRECT_PLACEHOLDER, type IngestContext } from '../ingest/ingest';
import { bareJid } from '../ingest/normalize';
import { nativeToNormalized } from '../ingest/native';
import { PreselectionBuffer } from '../ingest/preselection';
import type { NormalizedEvent } from '../ingest/types';
import { notifyChange, QR_CHANNEL } from '../notify';
import { attachmentObjectKey, avatarObjectKey, type StorageAdapter } from '../storage';
import { sha256, sniffMime } from '../util';
import { accountsWithFingerprint, claimWhatsAppIdentity, deleteAccountData } from '../workspace';
import { clearAuthState, loadPgAuthState } from './auth-store';
import { acquireLease, LeaseLostError, type Lease } from './lease';

type ConnState = (typeof s.connectionStatus.$inferInsert)['state'];

// Allowlisted, content-free operational logging only.
const log = (msg: string, meta: Record<string, string | number | boolean | null> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), proc: 'companion', msg, ...meta }));

export interface CompanionDeps {
  db: Db;
  dbUrl: string;
  storage: StorageAdapter;
  cfg: WhatsAppConfig;
  key: Buffer;
  instanceId?: string;
}

// Phones refuse to link a web client that reports a stale version, and the one
// bundled with Baileys ages quickly. Use the live version (re-checked every few
// hours); fall back to the last known or bundled one if WhatsApp is unreachable.
const WA_VERSION_TTL_MS = 6 * 60 * 60 * 1000;
let waVersion: { version: WAVersion; at: number } | undefined;
async function currentWaVersion(): Promise<WAVersion | undefined> {
  if (waVersion && Date.now() - waVersion.at < WA_VERSION_TTL_MS) return waVersion.version;
  try {
    const r = await fetchLatestWaWebVersion({ signal: AbortSignal.timeout(10_000) });
    if (r.isLatest) {
      waVersion = { version: r.version, at: Date.now() };
      log('wa_version', { version: r.version.join('.') });
    } else log('wa_version_unavailable');
  } catch {
    log('wa_version_unavailable');
  }
  return waVersion?.version;
}

const HANDLED_EVENTS = ['messaging-history.set', 'messages.upsert', 'messages.update', 'messages.delete', 'chats.upsert', 'chats.update', 'groups.upsert', 'groups.update', 'contacts.upsert', 'contacts.update', 'lid-mapping.update'] as const;

class Session {
  sock?: WASocket;
  lease?: Lease;
  stopped = false;
  attempts = 0;
  disconnectedAt: Date | null = null;
  // Set when a start had no saved credentials (a QR scan); survives the restart WhatsApp requests right after it.
  freshScan = false;
  // A phone-number pairing code was already requested on this connection.
  codeRequested = false;
  // The socket is linked and open (not merely pairing or closed).
  open = false;
  buffer: PreselectionBuffer;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private c: Companion,
    readonly accountId: string,
    // Changes once if a scan proves this number already owns a workspace.
    public workspaceId: string,
  ) {
    this.buffer = new PreselectionBuffer(c.deps.cfg.WHATSAPP_PRESELECTION_BUFFER_MIB * 1024 * 1024, c.deps.cfg.WHATSAPP_PRESELECTION_BUFFER_TTL_SECONDS * 1000);
  }

  private get db() {
    return this.c.deps.db;
  }

  async status(state: ConnState, detail: string | null = null, extra: Partial<typeof s.connectionStatus.$inferInsert> = {}) {
    await this.db
      .insert(s.connectionStatus)
      .values({ linkedAccountId: this.accountId, state, detail, heartbeatAt: new Date(), ...extra })
      .onConflictDoUpdate({ target: s.connectionStatus.linkedAccountId, set: { state, detail, heartbeatAt: new Date(), updatedAt: new Date(), ...extra } });
    await notifyChange(this.db, { ws: this.workspaceId, kind: 'connection' });
  }

  async start() {
    if (this.stopped) return;
    if (!this.lease) {
      const lease = await acquireLease(this.db, this.c.deps.dbUrl, this.accountId, this.c.instanceId);
      if (!lease) {
        await this.status('error', 'Another ThreadMap companion holds this WhatsApp account; this instance will not connect.');
        log('lease_unavailable', { account: this.accountId.slice(0, 8) });
        this.schedule(30_000);
        return;
      }
      this.lease = lease;
      void lease.lost.then(() => {
        if (this.stopped) return;
        log('lease_lost', { account: this.accountId.slice(0, 8) });
        this.closeSocket();
        this.lease = undefined;
        void this.status('reconnecting', 'Account lease lost; re-acquiring before reconnecting.');
        this.schedule(5_000);
      });
    }
    let auth;
    try {
      const [la] = await this.db.select().from(s.linkedAccounts).where(eq(s.linkedAccounts.id, this.accountId));
      auth = await loadPgAuthState(this.db, this.accountId, this.c.deps.key, la.keyVersion, this.lease.fence);
    } catch (e) {
      if (e instanceof EncryptionKeyError) {
        await this.status('relink_required', 'Saved session cannot be decrypted with the configured key. Disconnect and pair again.');
        return;
      }
      throw e;
    }
    if (!auth.hasStoredCreds) this.freshScan = true;
    this.codeRequested = false;
    await this.status(auth.hasStoredCreds ? 'connecting' : 'pairing', null);
    const logger = pino({ level: 'silent' });
    const version = await currentWaVersion();
    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: auth.state.creds, keys: makeCacheableSignalKeyStore(auth.state.keys, logger) },
      logger,
      browser: Browsers.ubuntu('ThreadMap'),
      markOnlineOnConnect: false,
      syncFullHistory: this.c.deps.cfg.WHATSAPP_INITIAL_SYNC_MODE === 'available_history',
      shouldSyncHistoryMessage: () => this.c.deps.cfg.WHATSAPP_INITIAL_SYNC_MODE === 'available_history',
      getMessage: async () => undefined,
      // No qrTimeout: Baileys follows WhatsApp Web (first QR 60 s, later ones 20 s). Holding later
      // QRs for 60 s shows codes WhatsApp already expired (phone: "check your connection").
    });
    this.sock = sock;

    sock.ev.process(async (events) => {
      try {
        if (events['connection.update']) await this.onConnection(events['connection.update'], sock);
        if (events['creds.update']) await auth.saveCreds();
        const normalized: NormalizedEvent[] = [];
        for (const name of HANDLED_EVENTS) {
          const data = events[name];
          if (data) normalized.push(...nativeToNormalized(name, data));
        }
        if (normalized.length) await this.ingest(normalized);
      } catch (e) {
        if (e instanceof LeaseLostError) {
          this.closeSocket();
          return;
        }
        // Persistence unavailable: stop capture rather than silently dropping events.
        log('ingest_failed', { error: e instanceof Error ? e.name : 'unknown' });
        this.closeSocket();
        await this.status('error', 'Storage unavailable; capture paused. A gap may exist until reconnect.').catch(() => undefined);
        this.disconnectedAt ??= new Date();
        this.schedule(15_000);
      }
    });
  }

  private ctx(): IngestContext {
    return {
      workspaceId: this.workspaceId,
      linkedAccountId: this.accountId,
      sourceKind: 'whatsapp',
      historyCapPerChat: this.c.deps.cfg.WHATSAPP_HISTORY_MAX_MESSAGES_PER_CHAT,
      sealMediaRef: (plain, aad) => sealPacked(this.c.deps.key, Buffer.from(plain), aad),
      storage: this.c.deps.storage,
      fence: this.lease?.fence,
    };
  }

  async ingest(events: NormalizedEvent[]) {
    const { stats, unselected } = await ingestEvents(this.db, this.ctx(), events);
    if (unselected.length) {
      // Only chats with no selection decision yet may be buffered (memory only).
      const undecided = await this.db.select({ jid: s.chats.nativeJid }).from(s.chats).where(and(eq(s.chats.linkedAccountId, this.accountId), eq(s.chats.selectionEpoch, 0)));
      const set = new Set(undecided.map((u) => u.jid));
      for (const e of unselected) if (set.has(e.chatJid)) this.buffer.add(e);
    }
    if (stats.inserted || stats.edits || stats.revokes) {
      await this.db.update(s.connectionStatus).set({ lastEventAt: new Date() }).where(eq(s.connectionStatus.linkedAccountId, this.accountId));
    }
    if (this.buffer.warnings.length) await this.flushWarnings();
  }

  /** Release buffered history for chats the owner has now selected; discard the rest on expiry. */
  async releaseBuffer() {
    const selected = await this.db.select({ jid: s.chats.nativeJid }).from(s.chats).where(and(eq(s.chats.linkedAccountId, this.accountId), eq(s.chats.selected, true)));
    const set = new Set(selected.map((x) => x.jid));
    const released = this.buffer.release((jid) => set.has(jid));
    if (released.length) await ingestEvents(this.db, this.ctx(), released);
    const decided = await this.db.select({ jid: s.chats.nativeJid }).from(s.chats).where(and(eq(s.chats.linkedAccountId, this.accountId), sql`${s.chats.selectionEpoch} > 0`, eq(s.chats.selected, false)));
    const drop = new Set(decided.map((d) => d.jid));
    this.buffer.release((jid) => drop.has(jid)); // discarded, never stored
    await this.flushWarnings();
    return released.length;
  }

  private async flushWarnings() {
    for (const w of this.buffer.warnings.splice(0)) {
      await this.db.execute(sql`
        UPDATE sync_coverage SET warnings = warnings || ${JSON.stringify([{ type: w.type, dropped: w.dropped, at: new Date().toISOString() }])}::jsonb
        WHERE chat_id IN (SELECT id FROM chats WHERE linked_account_id = ${this.accountId}::uuid AND native_jid = ${w.chatJid})`);
    }
  }

  private async onConnection(u: Partial<import('baileys').ConnectionState>, sock: WASocket) {
    if (u.qr) {
      // Linking by phone number (no camera): once the connection is ready, ask WhatsApp for a code
      // the owner types on the phone. It is valid for this connection; a reconnect requests a new one.
      const phone = this.c.pairPhones.get(this.accountId);
      if (phone && !this.codeRequested) {
        this.codeRequested = true;
        try {
          const code = await sock.requestPairingCode(phone);
          await this.db.execute(sql`SELECT pg_notify(${QR_CHANNEL}, ${JSON.stringify({ ws: this.workspaceId, qr: u.qr, code, ttlMs: 180_000 })})`);
          await this.status('pairing', 'Enter the code on your phone: WhatsApp → Linked Devices → Link a device → Link with phone number instead.');
          return;
        } catch {
          log('pairing_code_failed', { account: this.accountId.slice(0, 8) });
        }
      }
      // Transient owner-only delivery; never persisted or logged.
      // Kept briefly: a newer QR replaces it, and a closed session clears it (below).
      await this.db.execute(sql`SELECT pg_notify(${QR_CHANNEL}, ${JSON.stringify({ ws: this.workspaceId, qr: u.qr, ttlMs: 25_000 })})`);
      if (!this.codeRequested) await this.status('pairing', 'Scan the QR code in WhatsApp → Linked Devices.');
    }
    if (u.connection === 'open') {
      this.open = true;
      this.c.pairPhones.delete(this.accountId);
      await this.db.execute(sql`SELECT pg_notify(${QR_CHANNEL}, ${JSON.stringify({ ws: this.workspaceId, qr: null })})`);
      const me = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0] : null;
      if (!me) {
        // Without a number there is no identity to sign in as.
        await this.status('error', 'WhatsApp did not report the linked number; pair again.');
        await sock.logout().catch(() => undefined);
        await clearAuthState(this.db, this.accountId);
        this.closeSocket();
        return;
      }
      const fp = sha256(`wa-account:${me}`);
      // A QR scan starts from scratch: earlier devices for this number are logged out first.
      const freshScan = this.freshScan;
      this.freshScan = false;
      if (freshScan) for (const prior of await accountsWithFingerprint(this.db, fp, this.accountId)) await this.c.retire(prior);
      const claim = await claimWhatsAppIdentity(this.db, this.accountId, fp, { freshScan });
      if (claim.outcome === 'mismatch') {
        // A different WhatsApp account must not inherit this workspace's records.
        await this.status('relink_required', 'A different WhatsApp account was linked. Disconnect it; this workspace belongs to the previously linked account.');
        await sock.logout().catch(() => undefined);
        await clearAuthState(this.db, this.accountId);
        this.closeSocket();
        return;
      }
      if (claim.outcome === 'fresh') {
        this.workspaceId = claim.workspaceId;
        this.disconnectedAt = null; // a new account has no earlier coverage to have a gap in
        for (const key of claim.purgeKeys) await this.c.deps.storage.delete(key).catch(() => undefined);
        log('signed_in_fresh', { account: this.accountId.slice(0, 8), replaced: claim.replacedAccountIds.length, purged: claim.purgeKeys.length });
      }
      await this.db.update(s.linkedAccounts).set({ connectionGeneration: sql`${s.linkedAccounts.connectionGeneration} + 1`, updatedAt: new Date() }).where(eq(s.linkedAccounts.id, this.accountId));
      const gap = this.disconnectedAt ? [{ from: this.disconnectedAt.toISOString(), to: new Date().toISOString(), reason: 'disconnected' }] : [];
      await this.status('connected', null, { connectedSince: new Date() });
      // Appended separately: an upsert's VALUES cannot reference the existing row.
      if (gap.length) {
        await this.db
          .update(s.connectionStatus)
          .set({ uncertainIntervals: sql`${s.connectionStatus.uncertainIntervals} || ${JSON.stringify(gap)}::jsonb` })
          .where(eq(s.connectionStatus.linkedAccountId, this.accountId));
      }
      this.disconnectedAt = null;
      this.attempts = 0;
      log('connected', { account: this.accountId.slice(0, 8) });
      // Discovery metadata for group titles (identity/title/type only).
      try {
        const groups = await sock.groupFetchAllParticipating();
        await this.ingest(Object.values(groups).map((g) => ({ type: 'chat_meta', chatJid: g.id, kind: 'group', title: g.subject ?? null })));
      } catch {
        /* best effort */
      }
      await this.resolveHiddenNumbers(sock).catch(() => log('hidden_numbers_unresolved'));
    }
    if (u.connection === 'close') {
      this.sock = undefined;
      this.open = false;
      // A QR from a closed socket can no longer pair; stop showing it.
      await this.db.execute(sql`SELECT pg_notify(${QR_CHANNEL}, ${JSON.stringify({ ws: this.workspaceId, qr: null })})`).catch(() => undefined);
      this.disconnectedAt ??= new Date();
      const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      log('connection_closed', { account: this.accountId.slice(0, 8), code: code ?? null });
      if (this.stopped) return;
      if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden) {
        await clearAuthState(this.db, this.accountId);
        // A link that never completed is not a lost session: offer a fresh attempt instead.
        if (this.freshScan) await this.status('disconnected', 'Linking did not complete. Show a new QR code or get a new phone code to try again.');
        else await this.status('relink_required', 'WhatsApp ended this linked session. Pair again to resume.');
        log('logged_out', { account: this.accountId.slice(0, 8) });
        return;
      }
      if (code === DisconnectReason.connectionReplaced) {
        await this.status('error', 'Session replaced by another connection. Not reconnecting automatically.');
        return;
      }
      if (code === DisconnectReason.restartRequired) {
        log('restart_required');
        this.schedule(100);
        return;
      }
      this.attempts++;
      if (this.attempts > 10) {
        await this.status('error', 'Repeated connection failures; reconnect stopped. Use Resume to retry.');
        return;
      }
      const delay = Math.min(300_000, 1000 * 2 ** this.attempts) + Math.floor(Math.random() * 1000);
      await this.status('reconnecting', `Connection closed (code ${code ?? 'unknown'}); retrying.`);
      this.schedule(delay);
    }
  }

  schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.start().catch((e) => log('start_failed', { error: e instanceof Error ? e.name : 'unknown' })), ms);
  }

  closeSocket() {
    try {
      this.sock?.end(undefined);
    } catch {
      /* ignore */
    }
    this.sock = undefined;
  }

  async stop(state: ConnState = 'paused', detail: string | null = null) {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.closeSocket();
    this.buffer.clear();
    await this.lease?.release();
    this.lease = undefined;
    await this.status(state, detail);
  }

  /**
   * Direct chats WhatsApp addresses by a hidden ID (@lid) carry no number, so
   * saved contact names (keyed by number) cannot reach them. The phone already
   * shares which number each ID belongs to; apply those mappings as aliases.
   */
  private async resolveHiddenNumbers(sock: WASocket) {
    await this.db
      .update(s.chats)
      .set({ title: DIRECT_PLACEHOLDER })
      .where(and(eq(s.chats.linkedAccountId, this.accountId), eq(s.chats.title, LEGACY_DIRECT_PLACEHOLDER)));
    const rows = await this.db
      .select({ jid: s.chats.nativeJid })
      .from(s.chats)
      .where(and(eq(s.chats.linkedAccountId, this.accountId), eq(s.chats.kind, 'direct'), sql`${s.chats.nativeJid} LIKE '%@lid'`));
    if (!rows.length) return;
    const pairs = (await sock.signalRepository.lidMapping.getPNsForLIDs(rows.map((r) => r.jid))) ?? [];
    const aliases: NormalizedEvent[] = [];
    for (const p of pairs) {
      const pn = bareJid(p.pn);
      const lid = bareJid(p.lid);
      if (pn && lid) aliases.push({ type: 'alias', pn, lid });
    }
    if (aliases.length) await this.ingest(aliases);
    log('hidden_numbers', { chats: rows.length, resolved: aliases.length });
  }

  /** Stop without writing status: the account row no longer exists. */
  /** Resolves once the account lease is released, so a replacement session can take it. */
  abandon(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.closeSocket();
    this.buffer.clear();
    const released = this.lease?.release().catch(() => undefined) ?? Promise.resolve();
    this.lease = undefined;
    return released;
  }

  async logout(): Promise<boolean> {
    let confirmed = false;
    if (this.sock) {
      try {
        await this.sock.logout('ThreadMap disconnect');
        confirmed = true;
      } catch {
        confirmed = false;
      }
    }
    return confirmed;
  }

  private backfilling = new Set<string>();

  /**
   * Older history for an opened chat, page after page (50 messages each) from the
   * phone, until WhatsApp has no more or the per-chat cap is reached. WhatsApp
   * sends a chat's full history only once, at linking, and ThreadMap keeps an
   * unopened chat's messages in memory for just a few minutes, so a chat opened
   * later would otherwise start with almost nothing. Paced like scrolling up in
   * WhatsApp Web; runs in the background so other commands are not held up.
   */
  async backfillHistory(chatId: string) {
    if (this.backfilling.has(chatId)) return { ok: true, already: true };
    this.backfilling.add(chatId);
    const cap = this.c.deps.cfg.WHATSAPP_HISTORY_MAX_MESSAGES_PER_CHAT;
    const count = async () => (await this.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM messages WHERE chat_id = ${chatId}::uuid`)).rows[0].n;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let pages = 0;
    try {
      let n = await count();
      let quiet = 0;
      while (this.sock && n < cap && pages < Math.ceil(cap / 50)) {
        const r = await this.requestHistory(chatId);
        if (!r.ok) break;
        pages++;
        // A page usually lands within a few seconds; none at all means the phone has no more.
        let m = n;
        for (let i = 0; i < 15 && m === n; i++) {
          await wait(1000);
          m = await count();
        }
        if (m === n && ++quiet >= 2) break;
        if (m > n) quiet = 0;
        n = m;
        // Keep the first-open analysis going while older pages arrive.
        await this.db.execute(sql`UPDATE chats SET auto_analyze_until = GREATEST(coalesce(auto_analyze_until, now()), now() + interval '2 minutes') WHERE id = ${chatId}::uuid AND selected`);
        await wait(1500 + Math.floor(Math.random() * 1500));
      }
    } finally {
      this.backfilling.delete(chatId);
    }
    return { ok: true, pages };
  }

  async requestHistory(chatId: string) {
    if (!this.sock) return { ok: false, reason: 'not connected' };
    const [oldest] = await this.db
      .select({ nativeId: s.messages.nativeId, fromMe: s.messages.fromMe, nativeKey: s.messages.nativeKey, sentAt: s.messages.sentAt })
      .from(s.messages)
      .where(and(eq(s.messages.chatId, chatId), sql`${s.messages.sentAt} IS NOT NULL`))
      .orderBy(asc(s.messages.sentAt))
      .limit(1);
    if (oldest?.sentAt) {
      // Page further back from the oldest message already stored.
      const nk = oldest.nativeKey as { remoteJid: string; participant?: string };
      const key: WAMessageKey = { remoteJid: nk.remoteJid, fromMe: oldest.fromMe, id: oldest.nativeId, participant: nk.participant ?? undefined };
      await this.sock.fetchMessageHistory(50, key, Math.floor(oldest.sentAt.getTime() / 1000));
      return { ok: true, from: 'oldest_stored' };
    }
    // Nothing stored yet (selected after the initial history was discarded): start from the newest message seen.
    const [chat] = await this.db.select({ anchor: s.chats.historyAnchor }).from(s.chats).where(eq(s.chats.id, chatId));
    const a = chat?.anchor;
    if (!a) return { ok: false, reason: 'no anchor message' };
    await this.sock.fetchMessageHistory(50, { remoteJid: a.remoteJid, fromMe: a.fromMe, id: a.id, participant: a.participant ?? undefined }, a.ts);
    return { ok: true, from: 'newest_seen' };
  }

  /**
   * Small profile photos for chats the owner has on screen. One lookup at a
   * time with a pause between, so this looks like WhatsApp Web scrolling, not a
   * sweep. A photo that is missing or hidden is remembered as such for a week.
   */
  /**
   * Images in opened chats are downloaded as they arrive (newest first, a few per
   * tick) so they can be shown and read by the vision model before analysis.
   */
  async fetchOpenedChatImages() {
    if (!this.sock) return;
    const maxBytes = this.c.deps.cfg.MAX_ATTACHMENT_MIB * 1024 * 1024;
    // Photos and stickers (small images, shown inline like WhatsApp does).
    const due = await this.db.execute<{ id: string }>(sql`
      UPDATE attachments SET availability = 'fetching', updated_at = now()
      WHERE id IN (
        SELECT a.id FROM attachments a JOIN messages m ON m.id = a.message_id JOIN chats c ON c.id = m.chat_id
        WHERE a.workspace_id = ${this.workspaceId}::uuid AND c.selected AND m.state = 'active'
          AND a.media_type IN ('image', 'sticker') AND a.availability = 'available' AND NOT a.view_once AND COALESCE(a.declared_size, 0) <= ${maxBytes}
        ORDER BY m.sent_at DESC NULLS LAST LIMIT 8)
      RETURNING id`);
    for (const r of due.rows) await this.fetchMedia(r.id);
  }

  async fetchAvatars(chatIds: string[]) {
    if (!chatIds.length) return { fetched: 0 };
    const rows = await this.db
      .select({ id: s.chats.id, jid: s.chats.nativeJid, key: s.chats.avatarKey })
      .from(s.chats)
      .where(and(eq(s.chats.workspaceId, this.workspaceId), inArray(s.chats.id, chatIds)));
    let fetched = 0;
    for (const [i, r] of rows.entries()) {
      if (!this.sock) {
        await this.db.update(s.chats).set({ avatarCheckedAt: null }).where(inArray(s.chats.id, rows.slice(i).map((x) => x.id)));
        break;
      }
      try {
        const url = await this.sock.profilePictureUrl(r.jid, 'preview');
        const res = url ? await fetch(url, { signal: AbortSignal.timeout(10_000) }) : null;
        if (res && !res.ok) throw Object.assign(new Error('download failed'), { status: res.status });
        const buf = res ? Buffer.from(await res.arrayBuffer()) : null;
        const mime = buf ? sniffMime(buf) : null;
        if (buf && mime?.startsWith('image/') && buf.length <= 512 * 1024) {
          const key = avatarObjectKey(this.workspaceId, r.id);
          await this.c.deps.storage.put(key, buf, mime);
          await this.db.update(s.chats).set({ avatarKey: key, avatarCheckedAt: new Date() }).where(eq(s.chats.id, r.id));
          fetched++;
        } else await this.clearAvatar(r);
      } catch (e) {
        const code = (e as { output?: { statusCode?: number }; status?: number }).output?.statusCode ?? (e as { status?: number }).status;
        // 404: no photo; 401: hidden by their privacy settings. Either way, show initials.
        if (code === 404 || code === 401) await this.clearAvatar(r);
        else await this.db.update(s.chats).set({ avatarCheckedAt: null }).where(eq(s.chats.id, r.id));
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    await notifyChange(this.db, { ws: this.workspaceId, kind: 'chats' });
    return { fetched, looked_up: rows.length };
  }

  private async clearAvatar(r: { id: string; key: string | null }) {
    if (r.key) await this.c.deps.storage.delete(r.key).catch(() => undefined);
    await this.db.update(s.chats).set({ avatarKey: null, avatarCheckedAt: new Date() }).where(eq(s.chats.id, r.id));
  }

  async fetchMedia(attachmentId: string) {
    const [row] = await this.db
      .select({ att: s.attachments, msg: s.messages })
      .from(s.attachments)
      .innerJoin(s.messages, eq(s.messages.id, s.attachments.messageId))
      .where(and(eq(s.attachments.id, attachmentId), eq(s.attachments.workspaceId, this.workspaceId)));
    if (!row || row.msg.state !== 'active') return { ok: false, reason: 'unavailable' };
    const a = row.att;
    const fail = async (availability: 'failed' | 'unavailable', reason: string) => {
      await this.db.update(s.attachments).set({ availability, failureReason: reason, updatedAt: new Date() }).where(eq(s.attachments.id, a.id));
      await notifyChange(this.db, { ws: this.workspaceId, kind: 'media', chatId: row.msg.chatId });
      return { ok: false, reason };
    };
    if (!a.mediaRef || a.viewOnce) return fail('unavailable', 'no retrievable media reference');
    const ref = JSON.parse(openPacked(this.c.deps.key, a.mediaRef, `media:${a.id}`).toString('utf8')) as Record<string, string | number | null>;
    const maxBytes = this.c.deps.cfg.MAX_ATTACHMENT_MIB * 1024 * 1024;
    if (typeof ref.fileLength === 'number' && ref.fileLength > maxBytes) return fail('failed', 'file exceeds size limit');
    const used = await this.db.execute<{ n: number }>(sql`SELECT COALESCE(sum(byte_count),0)::bigint AS n FROM attachments WHERE workspace_id = ${this.workspaceId}::uuid AND availability = 'cached'`);
    const quota = this.c.deps.cfg.MAX_MEDIA_CACHE_MIB * 1024 * 1024;
    if (Number(used.rows[0].n) + Number(ref.fileLength ?? 0) > quota) return fail('failed', 'media cache quota exceeded; clear cached files');
    if (!this.sock) return fail('failed', 'companion not connected; retry when connected');
    const b = (v: unknown) => (typeof v === 'string' ? Buffer.from(v, 'base64') : undefined);
    const nk = row.msg.nativeKey as { remoteJid: string; participant?: string };
    const field = String(ref.field);
    try {
      const buf = (await downloadMediaMessage(
        {
          key: { remoteJid: nk.remoteJid, fromMe: row.msg.fromMe, id: row.msg.nativeId, participant: nk.participant ?? undefined },
          message: { [field]: { mediaKey: b(ref.mediaKey), directPath: ref.directPath, url: ref.url, mimetype: ref.mimetype, fileEncSha256: b(ref.fileEncSha256), fileSha256: b(ref.fileSha256), fileLength: ref.fileLength } },
        },
        'buffer',
        {},
        { logger: pino({ level: 'silent' }), reuploadRequest: this.sock.updateMediaMessage },
      )) as Buffer;
      if (buf.length > maxBytes) return fail('failed', 'file exceeds size limit');
      const key = attachmentObjectKey(this.workspaceId, a.id);
      const mime = sniffMime(buf) ?? a.declaredMime ?? 'application/octet-stream';
      await this.c.deps.storage.put(key, buf, mime);
      await this.db
        .update(s.attachments)
        .set({ availability: 'cached', objectKey: key, byteCount: buf.length, contentHash: sha256(buf), detectedMime: mime, failureReason: null, updatedAt: new Date() })
        .where(eq(s.attachments.id, a.id));
      await notifyChange(this.db, { ws: this.workspaceId, kind: 'media', chatId: row.msg.chatId });
      return { ok: true };
    } catch (e) {
      const status = (e as { output?: { statusCode?: number }; status?: number }).output?.statusCode ?? (e as { status?: number }).status;
      if (status === 404 || status === 410) return fail('unavailable', 'WhatsApp no longer serves this file');
      return fail('failed', 'download failed; retry later');
    }
  }
}


export class Companion {
  readonly instanceId: string;
  private sessions = new Map<string, Session>();
  // Phone numbers to link by pairing code instead of QR, per linked account (until linked or cancelled).
  readonly pairPhones = new Map<string, string>();
  private listener?: pg.Client;
  private loop?: ReturnType<typeof setInterval>;
  private busy = false;

  constructor(readonly deps: CompanionDeps) {
    this.instanceId = deps.instanceId ?? `companion-${crypto.randomUUID()}`;
  }

  async start() {
    await this.heartbeat();
    // A QR pairing lives only in a previous process's memory; let the browser offer a fresh one.
    await this.deps.db
      .update(s.connectionStatus)
      .set({ state: 'disconnected', detail: 'ThreadMap restarted during linking. Show a new QR code to continue.', updatedAt: new Date() })
      .where(eq(s.connectionStatus.state, 'pairing'));
    this.listener = new pg.Client({ connectionString: this.deps.dbUrl, ssl: pgSslOptions(), application_name: 'threadmap-companion-cmd' });
    await this.listener.connect();
    await this.listener.query(`LISTEN ${COMMAND_CHANNEL}`);
    this.listener.on('notification', () => void this.tick());
    this.loop = setInterval(() => void this.tick(), 5000);
    await this.tick();
    log('started', { instance: this.instanceId.slice(0, 18) });
  }

  /** Log out and stop a session whose device a newer scan of the same number replaces. */
  async retire(accountId: string) {
    await this.deps.db.update(s.linkedAccounts).set({ desiredState: 'disconnected' }).where(eq(s.linkedAccounts.id, accountId));
    const sess = this.sessions.get(accountId);
    if (!sess) return;
    this.sessions.delete(accountId);
    await sess.logout();
    await sess.stop('disconnected', 'Replaced by a newer linked device.');
  }

  async heartbeat() {
    await this.deps.db
      .insert(s.processHeartbeats)
      .values({ processName: 'companion', instanceId: this.instanceId, detail: { sessions: this.sessions.size } })
      .onConflictDoUpdate({ target: s.processHeartbeats.processName, set: { instanceId: this.instanceId, heartbeatAt: new Date(), detail: { sessions: this.sessions.size } } });
    for (const sess of this.sessions.values()) {
      await this.deps.db.update(s.connectionStatus).set({ heartbeatAt: new Date() }).where(eq(s.connectionStatus.linkedAccountId, sess.accountId));
    }
  }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.heartbeat();
      // Commands first: a disconnect must log out the live session before reconcile stops it.
      await this.processCommands();
      await this.reconcile();
      for (const sess of this.sessions.values()) {
        sess.buffer.expire();
        if (sess.buffer.count) await sess.releaseBuffer();
        if (this.deps.cfg.MEDIA_DOWNLOAD_MODE === 'opened_chat_images') await sess.fetchOpenedChatImages();
      }
    } catch (e) {
      log('tick_failed', { error: e instanceof Error ? e.name : 'unknown' });
    } finally {
      this.busy = false;
    }
  }

  /** Ensure a session runs for every account that wants to be active and has creds or a pair request. */
  private async reconcile() {
    const accounts = await this.deps.db.execute<{ id: string; workspace_id: string; desired_state: string; has_creds: boolean; pair_pending: boolean }>(sql`
      SELECT la.id, la.workspace_id, la.desired_state,
        EXISTS (SELECT 1 FROM auth_records ar WHERE ar.linked_account_id = la.id AND ar.category = 'creds') AS has_creds,
        EXISTS (SELECT 1 FROM connector_commands cc WHERE cc.linked_account_id = la.id AND cc.type = 'pair' AND cc.status IN ('pending','running')) AS pair_pending
      FROM linked_accounts la JOIN workspaces w ON w.id = la.workspace_id WHERE w.mode = 'private'`);
    // Accounts deleted underneath us (expired link attempts, replaced devices) stop here.
    const live = new Set(accounts.rows.map((a) => a.id));
    for (const [id, sess] of this.sessions) {
      if (live.has(id)) continue;
      this.sessions.delete(id);
      sess.abandon();
    }
    for (const a of accounts.rows) {
      const want = a.desired_state === 'active' && (a.has_creds || a.pair_pending);
      const sess = this.sessions.get(a.id);
      if (want && !sess) {
        const n = new Session(this, a.id, a.workspace_id);
        this.sessions.set(a.id, n);
        await n.start();
      } else if (!want && sess && a.desired_state !== 'active') {
        this.sessions.delete(a.id);
        await sess.stop(a.desired_state === 'paused' ? 'paused' : 'disconnected');
      }
    }
  }

  private async processCommands() {
    const cmds = await this.deps.db
      .select()
      .from(s.connectorCommands)
      .where(eq(s.connectorCommands.status, 'pending'))
      .orderBy(asc(s.connectorCommands.createdAt))
      .limit(20);
    for (const cmd of cmds) {
      const claimed = await this.deps.db.execute(sql`UPDATE connector_commands SET status = 'running' WHERE id = ${cmd.id}::uuid AND status = 'pending' RETURNING id`);
      if (!claimed.rows.length) continue;
      let result: Record<string, unknown> = {};
      let status: 'done' | 'failed' = 'done';
      try {
        result = await this.runCommand(cmd);
      } catch (e) {
        status = 'failed';
        result = { error: e instanceof Error ? e.message.slice(0, 160) : 'failed' };
      }
      await this.deps.db.update(s.connectorCommands).set({ status, result, completedAt: new Date() }).where(eq(s.connectorCommands.id, cmd.id));
    }
  }

  private async runCommand(cmd: typeof s.connectorCommands.$inferSelect): Promise<Record<string, unknown>> {
    const sess = this.sessions.get(cmd.linkedAccountId);
    const p = cmd.payload as Record<string, string>;
    switch (cmd.type) {
      case 'pair':
      case 'resume': {
        const phone = cmd.type === 'pair' ? (cmd.payload as { phone?: string }).phone : undefined;
        if (cmd.type === 'pair') {
          if (phone) this.pairPhones.set(cmd.linkedAccountId, phone);
          else this.pairPhones.delete(cmd.linkedAccountId);
          // Every link request gets a fresh socket: a pairing socket lives only ~2.5 min (its QR
          // refs run out), so a code requested late on an old one expires almost at once, and a
          // session that already ended would otherwise never pair again.
          const old = this.sessions.get(cmd.linkedAccountId);
          if (old && !old.open) {
            this.sessions.delete(cmd.linkedAccountId);
            await old.abandon();
          }
        }
        await this.reconcile();
        return { session: this.sessions.has(cmd.linkedAccountId) };
      }
      case 'pause':
        if (sess) {
          this.sessions.delete(cmd.linkedAccountId);
          await sess.stop('paused', 'Paused by owner. Messages sent meanwhile may be missed; history recovery is best effort.');
        }
        return { paused: true };
      case 'delete_account': {
        // Log the device out first so it leaves the phone's Linked Devices, then delete everything.
        let confirmed = false;
        if (sess) {
          this.sessions.delete(cmd.linkedAccountId);
          confirmed = await sess.logout();
          sess.abandon();
        }
        const [ws] = await this.deps.db.select({ owner: s.workspaces.ownerUserId }).from(s.workspaces).where(eq(s.workspaces.id, cmd.workspaceId));
        if (!ws) return { deleted: false, reason: 'already deleted' };
        const keys = await deleteAccountData(this.deps.db, ws.owner);
        for (const key of keys) await this.deps.storage.delete(key).catch(() => undefined);
        log('account_deleted', { remote_unlink_confirmed: confirmed, purged: keys.length });
        return { deleted: true, remote_unlink_confirmed: confirmed };
      }
      case 'disconnect': {
        this.pairPhones.delete(cmd.linkedAccountId);
        const confirmed = sess ? await sess.logout() : false;
        if (sess) {
          this.sessions.delete(cmd.linkedAccountId);
          await sess.stop('disconnected', confirmed ? 'Disconnected and unlinked.' : 'Local session removed; remote unlink not confirmed. Remove ThreadMap under WhatsApp → Linked Devices.');
        }
        await clearAuthState(this.deps.db, cmd.linkedAccountId);
        await this.deps.db.update(s.connectionStatus).set({ state: 'disconnected', remoteUnlinkConfirmed: confirmed }).where(eq(s.connectionStatus.linkedAccountId, cmd.linkedAccountId));
        return { remote_unlink_confirmed: confirmed };
      }
      case 'fetch_avatars': {
        const ids = (cmd.payload as { chatIds?: string[] }).chatIds ?? [];
        if (!sess) {
          // Not connected: release the claim so the photos are asked for again later.
          if (ids.length) await this.deps.db.update(s.chats).set({ avatarCheckedAt: null }).where(inArray(s.chats.id, ids));
          return { ok: false, reason: 'not connected' };
        }
        return sess.fetchAvatars(ids);
      }
      case 'fetch_media':
        if (!sess) {
          await this.deps.db.update(s.attachments).set({ availability: 'failed', failureReason: 'companion not connected' }).where(eq(s.attachments.id, p.attachmentId));
          return { ok: false };
        }
        return sess.fetchMedia(p.attachmentId);
      case 'request_history':
        if (!sess) return { ok: false, reason: 'not connected' };
        if (p.chatId && p.backfill) {
          void sess.backfillHistory(p.chatId).catch(() => undefined);
          return { started: true };
        }
        if (p.chatId) return sess.requestHistory(p.chatId);
        return { released: await sess.releaseBuffer() };
      default:
        return {};
    }
  }

  async shutdown() {
    if (this.loop) clearInterval(this.loop);
    for (const sess of this.sessions.values()) await sess.stop('reconnecting', 'Companion restarting.').catch(() => undefined);
    this.sessions.clear();
    await this.listener?.end().catch(() => undefined);
  }
}
