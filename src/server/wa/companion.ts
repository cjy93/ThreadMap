// Long-running Baileys companion. One socket per linked account, guarded by a
// database lease. Receives incoming AND owner-sent messages, persists selected
// sources before any analysis, never sends messages or read receipts.
import crypto from 'node:crypto';
import makeWASocket, { Browsers, DisconnectReason, downloadMediaMessage, makeCacheableSignalKeyStore, type WAMessageKey, type WASocket } from 'baileys';
import { and, asc, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import pino from 'pino';
import * as s from '../../db/schema';
import type { WhatsAppConfig } from '../../lib/config';
import { COMMAND_CHANNEL } from '../api/connector';
import { EncryptionKeyError, openPacked, sealPacked } from '../crypto';
import { pgSslOptions, type Db } from '../db';
import { ingestEvents, type IngestContext } from '../ingest/ingest';
import { nativeToNormalized } from '../ingest/native';
import { PreselectionBuffer } from '../ingest/preselection';
import type { NormalizedEvent } from '../ingest/types';
import { notifyChange, QR_CHANNEL } from '../notify';
import { attachmentObjectKey, type StorageAdapter } from '../storage';
import { sha256 } from '../util';
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

const HANDLED_EVENTS = ['messaging-history.set', 'messages.upsert', 'messages.update', 'messages.delete', 'chats.upsert', 'chats.update', 'groups.upsert', 'groups.update', 'lid-mapping.update'] as const;

class Session {
  sock?: WASocket;
  lease?: Lease;
  stopped = false;
  attempts = 0;
  disconnectedAt: Date | null = null;
  buffer: PreselectionBuffer;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private c: Companion,
    readonly accountId: string,
    readonly workspaceId: string,
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
    await this.status(auth.hasStoredCreds ? 'connecting' : 'pairing', null);
    const logger = pino({ level: 'silent' });
    const sock = makeWASocket({
      auth: { creds: auth.state.creds, keys: makeCacheableSignalKeyStore(auth.state.keys, logger) },
      logger,
      browser: Browsers.ubuntu('ThreadMap'),
      markOnlineOnConnect: false,
      syncFullHistory: this.c.deps.cfg.WHATSAPP_INITIAL_SYNC_MODE === 'available_history',
      shouldSyncHistoryMessage: () => this.c.deps.cfg.WHATSAPP_INITIAL_SYNC_MODE === 'available_history',
      getMessage: async () => undefined,
      qrTimeout: 60_000,
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
      // Transient owner-only delivery; never persisted or logged.
      await this.db.execute(sql`SELECT pg_notify(${QR_CHANNEL}, ${JSON.stringify({ ws: this.workspaceId, qr: u.qr, ttlMs: 60_000 })})`);
      await this.status('pairing', 'Scan the QR code in WhatsApp → Linked Devices.');
    }
    if (u.connection === 'open') {
      await this.db.execute(sql`SELECT pg_notify(${QR_CHANNEL}, ${JSON.stringify({ ws: this.workspaceId, qr: null })})`);
      const me = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0] : null;
      const fp = me ? sha256(`wa-account:${me}`) : null;
      const [la] = await this.db.select().from(s.linkedAccounts).where(eq(s.linkedAccounts.id, this.accountId));
      if (la.accountFingerprint && fp && la.accountFingerprint !== fp) {
        // A different WhatsApp account must not inherit this workspace's records.
        await this.status('relink_required', 'A different WhatsApp account was linked. Disconnect it; this workspace belongs to the previously linked account.');
        await sock.logout().catch(() => undefined);
        await clearAuthState(this.db, this.accountId);
        this.closeSocket();
        return;
      }
      await this.db.update(s.linkedAccounts).set({ accountFingerprint: fp, connectionGeneration: sql`${s.linkedAccounts.connectionGeneration} + 1`, updatedAt: new Date() }).where(eq(s.linkedAccounts.id, this.accountId));
      const gap = this.disconnectedAt ? [{ from: this.disconnectedAt.toISOString(), to: new Date().toISOString(), reason: 'disconnected' }] : [];
      await this.status('connected', null, {
        connectedSince: new Date(),
        ...(gap.length ? { uncertainIntervals: sql`(${s.connectionStatus.uncertainIntervals} || ${JSON.stringify(gap)}::jsonb)` as unknown as never } : {}),
      });
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
    }
    if (u.connection === 'close') {
      this.sock = undefined;
      this.disconnectedAt ??= new Date();
      const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      if (this.stopped) return;
      if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden) {
        await clearAuthState(this.db, this.accountId);
        await this.status('relink_required', 'WhatsApp ended this linked session. Pair again to resume.');
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

  async requestHistory(chatId: string) {
    if (!this.sock) return { ok: false, reason: 'not connected' };
    const [oldest] = await this.db
      .select({ nativeId: s.messages.nativeId, fromMe: s.messages.fromMe, nativeKey: s.messages.nativeKey, sentAt: s.messages.sentAt })
      .from(s.messages)
      .where(and(eq(s.messages.chatId, chatId), sql`${s.messages.sentAt} IS NOT NULL`))
      .orderBy(asc(s.messages.sentAt))
      .limit(1);
    if (!oldest?.sentAt) return { ok: false, reason: 'no anchor message' };
    const nk = oldest.nativeKey as { remoteJid: string; participant?: string };
    const key: WAMessageKey = { remoteJid: nk.remoteJid, fromMe: oldest.fromMe, id: oldest.nativeId, participant: nk.participant ?? undefined };
    await this.sock.fetchMessageHistory(50, key, Math.floor(oldest.sentAt.getTime() / 1000));
    return { ok: true };
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

export function sniffMime(b: Buffer): string | null {
  if (b.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (b[0] === 0x89 && b.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';
  if (b.subarray(4, 8).toString('latin1') === 'ftyp') return 'video/mp4';
  return null;
}

export class Companion {
  readonly instanceId: string;
  private sessions = new Map<string, Session>();
  private listener?: pg.Client;
  private loop?: ReturnType<typeof setInterval>;
  private busy = false;

  constructor(readonly deps: CompanionDeps) {
    this.instanceId = deps.instanceId ?? `companion-${crypto.randomUUID()}`;
  }

  async start() {
    await this.heartbeat();
    this.listener = new pg.Client({ connectionString: this.deps.dbUrl, ssl: pgSslOptions(), application_name: 'threadmap-companion-cmd' });
    await this.listener.connect();
    await this.listener.query(`LISTEN ${COMMAND_CHANNEL}`);
    this.listener.on('notification', () => void this.tick());
    this.loop = setInterval(() => void this.tick(), 5000);
    await this.tick();
    log('started', { instance: this.instanceId.slice(0, 18) });
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
      await this.reconcile();
      await this.processCommands();
      for (const sess of this.sessions.values()) {
        sess.buffer.expire();
        if (sess.buffer.count) await sess.releaseBuffer();
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
      case 'resume':
        await this.reconcile();
        return { session: this.sessions.has(cmd.linkedAccountId) };
      case 'pause':
        if (sess) {
          this.sessions.delete(cmd.linkedAccountId);
          await sess.stop('paused', 'Paused by owner. Messages sent meanwhile may be missed; history recovery is best effort.');
        }
        return { paused: true };
      case 'disconnect': {
        const confirmed = sess ? await sess.logout() : false;
        if (sess) {
          this.sessions.delete(cmd.linkedAccountId);
          await sess.stop('disconnected', confirmed ? 'Disconnected and unlinked.' : 'Local session removed; remote unlink not confirmed. Remove ThreadMap under WhatsApp → Linked Devices.');
        }
        await clearAuthState(this.deps.db, cmd.linkedAccountId);
        await this.deps.db.update(s.connectionStatus).set({ state: 'disconnected', remoteUnlinkConfirmed: confirmed }).where(eq(s.connectionStatus.linkedAccountId, cmd.linkedAccountId));
        return { remote_unlink_confirmed: confirmed };
      }
      case 'fetch_media':
        if (!sess) {
          await this.deps.db.update(s.attachments).set({ availability: 'failed', failureReason: 'companion not connected' }).where(eq(s.attachments.id, p.attachmentId));
          return { ok: false };
        }
        return sess.fetchMedia(p.attachmentId);
      case 'request_history':
        if (!sess) return { ok: false, reason: 'not connected' };
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
