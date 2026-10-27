import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { workspaceModeFor } from '../src/server/auth';
import { purgeExpiredDemos } from '../src/server/demo';
import { claimWhatsAppIdentity, ensureLinkedAccount, startWhatsAppLogin } from '../src/server/workspace';
import { createTestDb, type TestDb } from './helpers/db';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t?.close());

const fp = () => crypto.randomBytes(32).toString('hex');

/** A browser that pressed "Connect WhatsApp": anonymous user, live session, pending workspace. */
async function pendingBrowser() {
  const id = `anon_${crypto.randomBytes(4).toString('hex')}`;
  await t.db.insert(s.user).values({ id, name: 'Anonymous', email: `${id}@demo.threadmap.invalid`, isAnonymous: true });
  const sessionId = crypto.randomUUID();
  await t.db.insert(s.session).values({ id: sessionId, token: crypto.randomUUID(), userId: id, expiresAt: new Date(Date.now() + 86_400_000) });
  const ws = await startWhatsAppLogin(t.db, { id, isAnonymous: true });
  const la = await ensureLinkedAccount(t.db, ws.id);
  return { userId: id, sessionId, ws, la };
}

describe('WhatsApp is the sign-in', () => {
  it('gives a connecting browser a short-lived private workspace, reused on retry', async () => {
    const b = await pendingBrowser();
    expect(b.ws.mode).toBe('private');
    expect(b.ws.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await workspaceModeFor(t.db, { id: b.userId, isAnonymous: true })).toBe('private');
    const again = await startWhatsAppLogin(t.db, { id: b.userId, isAnonymous: true });
    expect(again.id).toBe(b.ws.id);
    // Anonymous without a private workspace stays a demo guest.
    expect(await workspaceModeFor(t.db, { id: 'nobody', isAnonymous: true })).toBe('demo');
  });

  const scan = (la: string, number: string) => claimWhatsAppIdentity(t.db, la, number, { freshScan: true });
  const sessionUser = async (id: string) => (await t.db.select().from(s.session).where(eq(s.session.id, id)))[0]?.userId;

  it('a first scan gives the browser a new, permanent, empty account', async () => {
    const b = await pendingBrowser();
    const number = fp();
    const r = await scan(b.la.id, number);
    if (r.outcome !== 'fresh') throw new Error(r.outcome);
    expect(r.workspaceId).not.toBe(b.ws.id);
    const owner = await sessionUser(b.sessionId);
    const [u] = await t.db.select().from(s.user).where(eq(s.user.id, owner!));
    expect(u.isAnonymous).toBe(false);
    expect(u.email).toBe(`wa-${number.slice(0, 32)}@whatsapp.threadmap.invalid`); // a fingerprint prefix, never the number
    const [ws] = await t.db.select().from(s.workspaces).where(eq(s.workspaces.id, r.workspaceId));
    expect(ws.ownerUserId).toBe(owner);
    expect(ws.expiresAt).toBeNull();
    expect(await t.db.select().from(s.user).where(eq(s.user.id, b.userId))).toEqual([]); // the pending account is gone
    // A reconnect from saved credentials keeps everything; a different number cannot take over.
    expect(await claimWhatsAppIdentity(t.db, b.la.id, number, { freshScan: false })).toEqual({ outcome: 'same' });
    expect(await claimWhatsAppIdentity(t.db, b.la.id, fp(), { freshScan: false })).toEqual({ outcome: 'mismatch' });
  });

  it('scanning the same number again, on any browser, starts from scratch and deletes the old account entirely', async () => {
    const number = fp();
    const first = await pendingBrowser();
    const r1 = await scan(first.la.id, number);
    if (r1.outcome !== 'fresh') throw new Error(r1.outcome);
    const oldOwner = await sessionUser(first.sessionId);
    await t.db.insert(s.chats).values({
      workspaceId: r1.workspaceId, linkedAccountId: first.la.id, sourceKind: 'whatsapp', nativeJid: '1@g.us', kind: 'group', title: 'Team', selected: true, avatarKey: `ws/${r1.workspaceId}/avatar/x`,
    });

    const second = await pendingBrowser();
    const r2 = await scan(second.la.id, number);
    if (r2.outcome !== 'fresh') throw new Error(r2.outcome);
    expect(r2.replacedAccountIds).toEqual([first.la.id]);
    expect(r2.purgeKeys).toEqual([`ws/${r1.workspaceId}/avatar/x`]); // stored photos/files are handed back for deletion
    // Old account, workspace, chats, device and the old browser's sign-in: all gone.
    expect(await t.db.select().from(s.user).where(eq(s.user.id, oldOwner!))).toEqual([]);
    expect(await t.db.select().from(s.workspaces).where(eq(s.workspaces.id, r1.workspaceId))).toEqual([]);
    expect(await t.db.select().from(s.linkedAccounts).where(eq(s.linkedAccounts.id, first.la.id))).toEqual([]);
    expect(await sessionUser(first.sessionId)).toBeUndefined();
    // The scanning browser has a new, empty account.
    expect(await t.db.select().from(s.chats).where(eq(s.chats.workspaceId, r2.workspaceId))).toEqual([]);
    const [ws] = await t.db.select().from(s.workspaces).where(eq(s.workspaces.id, r2.workspaceId));
    expect(ws.ownerUserId).toBe(await sessionUser(second.sessionId));
  });

  it('re-scanning while signed in also starts from scratch and keeps the browser signed in', async () => {
    const number = fp();
    const b = await pendingBrowser();
    const r1 = await scan(b.la.id, number);
    if (r1.outcome !== 'fresh') throw new Error(r1.outcome);
    await t.db.insert(s.chats).values({ workspaceId: r1.workspaceId, linkedAccountId: b.la.id, sourceKind: 'whatsapp', nativeJid: '2@g.us', kind: 'group', title: 'Old' });
    const r2 = await scan(b.la.id, number);
    if (r2.outcome !== 'fresh') throw new Error(r2.outcome);
    expect(r2.workspaceId).not.toBe(r1.workspaceId);
    expect(await t.db.select().from(s.chats).where(eq(s.chats.title, 'Old'))).toEqual([]);
    const [la] = await t.db.select().from(s.linkedAccounts).where(eq(s.linkedAccounts.id, b.la.id));
    expect(la.workspaceId).toBe(r2.workspaceId);
    expect(await sessionUser(b.sessionId)).toBeDefined();
  });

  it('discards link attempts that were never scanned, and never touches claimed accounts', async () => {
    const stale = await pendingBrowser();
    await t.db.update(s.workspaces).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(s.workspaces.id, stale.ws.id));
    const kept = await pendingBrowser();
    await scan(kept.la.id, fp());
    const keptOwner = await sessionUser(kept.sessionId);
    await purgeExpiredDemos(t.db);
    expect(await t.db.select().from(s.user).where(eq(s.user.id, stale.userId))).toEqual([]);
    expect(await t.db.select().from(s.user).where(eq(s.user.id, keptOwner!))).toHaveLength(1);
  });
});
