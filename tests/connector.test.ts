import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { fixtureContext } from '../src/fixtures/load';
import { loadFixtureBundle, normalizeFixtureEvents, replayFixtureStep } from '../src/fixtures/source';
import { connectionStatus, discoveredChats, enqueueCommand, fetchAttachment, putSelections, startPairing } from '../src/server/api/connector';
import type { AuthCtx } from '../src/server/api/service';
import { EncryptionKeyError } from '../src/server/crypto';
import { ingestEvents } from '../src/server/ingest/ingest';
import { childEnv, CHILDREN } from '../src/processes/supervisor';
import { clearAuthState, loadPgAuthState } from '../src/server/wa/auth-store';
import { acquireLease, LeaseLostError } from '../src/server/wa/lease';
import { applySelections, deleteChat, ensureLinkedAccount, ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

let t: TestDb;
let ctx: AuthCtx;
let accountId: string;
const KEY = crypto.randomBytes(32);

beforeAll(async () => {
  t = await createTestDb();
  const u = await createUser(t.db);
  const ws = await ensurePrivateWorkspace(t.db, u);
  ctx = { userId: u, workspaceId: ws.id, mode: 'private' };
  accountId = (await ensureLinkedAccount(t.db, ws.id)).id;
});
afterAll(async () => t?.close());

describe('encrypted auth store and lease', () => {
  it('persists creds and Signal keys encrypted, restores them, and refuses a wrong key', async () => {
    const lease = await acquireLease(t.db, t.url, accountId, 'owner-a');
    expect(lease).not.toBeNull();
    const a = await loadPgAuthState(t.db, accountId, KEY, 1, lease!.fence);
    expect(a.hasStoredCreds).toBe(false);
    await a.saveCreds();
    await a.state.keys.set({ 'pre-key': { '1': { public: new Uint8Array([1, 2]), private: new Uint8Array([3, 4]) } }, session: { 'abc.0': new Uint8Array([9, 9, 9]) } });
    const raw = await t.db.select().from(s.authRecords).where(eq(s.authRecords.linkedAccountId, accountId));
    expect(raw.length).toBe(3);
    // Ciphertext never contains the plaintext noise key material.
    const noise = Buffer.from(a.state.creds.noiseKey.private).toString('base64');
    expect(raw.every((r) => !r.ciphertext.toString('latin1').includes(noise))).toBe(true);
    const b = await loadPgAuthState(t.db, accountId, KEY, 1, lease!.fence);
    expect(b.hasStoredCreds).toBe(true);
    expect(Buffer.from(b.state.creds.noiseKey.private).equals(Buffer.from(a.state.creds.noiseKey.private))).toBe(true);
    const pk = await b.state.keys.get('pre-key', ['1', '2']);
    expect(Buffer.from(pk['1'].private)).toEqual(Buffer.from([3, 4]));
    expect(pk['2']).toBeUndefined();
    await b.state.keys.set({ session: { 'abc.0': null } });
    expect(await b.state.keys.get('session', ['abc.0'])).toEqual({});
    await expect(loadPgAuthState(t.db, accountId, crypto.randomBytes(32), 1, lease!.fence)).rejects.toThrow(EncryptionKeyError);
    await lease!.release();
  });

  it('allows only one companion to hold an account and fences writes after loss', async () => {
    const first = await acquireLease(t.db, t.url, accountId, 'owner-a');
    expect(first).not.toBeNull();
    const second = await acquireLease(t.db, t.url, accountId, 'owner-b');
    expect(second).toBeNull();
    const store = await loadPgAuthState(t.db, accountId, KEY, 1, first!.fence);
    await first!.release();
    await expect(store.saveCreds()).rejects.toThrow(LeaseLostError);
    const third = await acquireLease(t.db, t.url, accountId, 'owner-b');
    expect(third).not.toBeNull();
    expect(third!.token).toBeGreaterThan(first!.token);
    await third!.release();
    await clearAuthState(t.db, accountId);
    expect((await t.db.select().from(s.authRecords).where(eq(s.authRecords.linkedAccountId, accountId))).length).toBe(0);
  });
});

describe('owner controls and demo restrictions', () => {
  it('demo guests cannot pair, see QR/connection commands, or list discovered chats', async () => {
    const demo: AuthCtx = { ...ctx, mode: 'demo' };
    await expect(startPairing(t.db, demo)).rejects.toThrow(/demo/);
    await expect(discoveredChats(t.db, demo)).rejects.toThrow(/demo/);
    await expect(enqueueCommand(t.db, demo, 'disconnect')).rejects.toThrow(/demo/);
    const st = await connectionStatus(t.db, demo);
    expect(st.pairing_allowed).toBe(false);
  });

  it('owner pairing creates a pair command (no auth state in payload) and status reports separately', async () => {
    const r = await startPairing(t.db, ctx);
    const [cmd] = await t.db.select().from(s.connectorCommands).where(eq(s.connectorCommands.id, r.attempt_id));
    expect(cmd.type).toBe('pair');
    expect(cmd.payload).toEqual({});
    const st = await connectionStatus(t.db, ctx);
    expect(st.connection.state).toBe('disconnected');
    expect(st.analysis).toBeDefined();
  });
});

describe('selection, new-only cutoff, history cap and deletion', () => {
  it('excludes unselected content, honors new-only cutoff and the history cap without capping live capture', async () => {
    const bundle = loadFixtureBundle();
    const fctx = { ...fixtureContext(ctx.workspaceId), historyCapPerChat: 30 };
    await replayFixtureStep(t.db, fctx, 'discover', bundle);
    const disc = await t.db.select().from(s.chats).where(eq(s.chats.workspaceId, ctx.workspaceId));
    const builders = disc.find((c) => c.nativeJid === bundle.manifest.chats.builders.jid)!;
    const study = disc.find((c) => c.nativeJid === bundle.manifest.chats.study.jid)!;
    // study: new messages only from a cutoff after all initial history
    await applySelections(t.db, ctx.workspaceId, [
      { chatId: builders.id, selected: true, historyMode: 'available_history' },
      { chatId: study.id, selected: true, historyMode: 'new_only' },
    ], new Date('2026-10-01T00:00:00Z'));
    const stats = await replayFixtureStep(t.db, fctx, 'initial', bundle);
    expect(stats.excludedUnselected).toBeGreaterThan(0); // music + family not selected
    const count = async (chatId: string) => (await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM messages WHERE chat_id = ${chatId}::uuid`)).rows[0].n;
    expect(await count(study.id)).toBe(0);
    const capped = await count(builders.id);
    const [cov] = await t.db.select().from(s.syncCoverage).where(eq(s.syncCoverage.chatId, builders.id));
    expect(cov.historyState).toBe('limited');
    expect(cov.historyCount).toBe(30);
    // Only live-delivered (notify) duplicates beyond the history cap were added.
    expect(capped).toBe(30 + cov.liveCount);
    const [scov] = await t.db.select().from(s.syncCoverage).where(eq(s.syncCoverage.chatId, study.id));
    expect(scov.excludedBeforeCutoff).toBeGreaterThan(0);
    // Live arrivals after the cap and after the cutoff are captured.
    await replayFixtureStep(t.db, fctx, 'update-20', bundle);
    expect(await count(builders.id)).toBe(capped + 12);
    expect(await count(study.id)).toBe(8);
  });

  it('deleting a chat unsubscribes first, purges content and prevents replay resurrection', async () => {
    const bundle = loadFixtureBundle();
    const [builders] = await t.db.select().from(s.chats).where(eq(s.chats.nativeJid, bundle.manifest.chats.builders.jid));
    await deleteChat(t.db, ctx.workspaceId, builders.id);
    const fctx = fixtureContext(ctx.workspaceId);
    const res = await ingestEvents(t.db, fctx, normalizeFixtureEvents(bundle, bundle.steps['update-20']));
    expect(res.stats.inserted).toBe(0); // study already captured; builders excluded
    expect(res.stats.excludedUnselected).toBe(12);
    const n = await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM messages WHERE chat_id = ${builders.id}::uuid`);
    expect(n.rows[0].n).toBe(0);
    const topics = await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM topics WHERE chat_id = ${builders.id}::uuid`);
    expect(topics.rows[0].n).toBe(0);
    // Explicit reselection re-enables capture with fresh roots.
    await putSelections(t.db, ctx, { selections: [{ chat_id: builders.id, selected: true }] });
    const roots = await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM topics WHERE chat_id = ${builders.id}::uuid`);
    expect(roots.rows[0].n).toBe(4);
  });

  it('refuses media fetch for revoked/other-workspace attachments', async () => {
    await expect(fetchAttachment(t.db, ctx, crypto.randomUUID())).rejects.toThrow(/not found/);
  });
});

describe('supervisor environment allowlists', () => {
  it('gives each child only its own secrets and database role', () => {
    const env = { DATABASE_URL: 'web', COMPANION_DATABASE_URL: 'comp', WORKER_DATABASE_URL: 'work', NEBIUS_API_KEY: 'nk', WHATSAPP_AUTH_ENCRYPTION_KEY: 'wk', BETTER_AUTH_SECRET: 'bs', PATH: '/bin' };
    const web = childEnv(CHILDREN[0], env);
    const comp = childEnv(CHILDREN[1], env);
    const work = childEnv(CHILDREN[2], env);
    expect(web.NEBIUS_API_KEY).toBeUndefined();
    expect(web.WHATSAPP_AUTH_ENCRYPTION_KEY).toBeUndefined();
    expect(web.BETTER_AUTH_SECRET).toBe('bs');
    expect(comp.WHATSAPP_AUTH_ENCRYPTION_KEY).toBe('wk');
    expect(comp.NEBIUS_API_KEY).toBeUndefined();
    expect(comp.DATABASE_URL).toBe('comp');
    expect(work.NEBIUS_API_KEY).toBe('nk');
    expect(work.WHATSAPP_AUTH_ENCRYPTION_KEY).toBeUndefined();
    expect(work.BETTER_AUTH_SECRET).toBeUndefined();
    expect(work.DATABASE_URL).toBe('work');
  });
});
