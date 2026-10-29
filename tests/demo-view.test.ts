import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { viewsDemo, workspaceModeFor } from '../src/server/auth';
import { ensureDemoWorkspace, purgeExpiredDemos } from '../src/server/demo';
import { markSeen } from '../src/server/presence';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// A signed-in WhatsApp account can open the demo without signing out (which would
// delete its data): the demo is a separate view and the account is untouched.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t?.close());

describe('demo view for a WhatsApp account', () => {
  it('reads the view cookie', () => {
    expect(viewsDemo('a=1; tm_view=demo')).toBe(true);
    expect(viewsDemo('tm_view=demo')).toBe(true);
    expect(viewsDemo('tm_view=mine; x=tm_view=demo2')).toBe(false);
    expect(viewsDemo(null)).toBe(false);
  });

  it('switches the view, keeps the account seen and alive, and drops only the expired demo', async () => {
    const userId = await createUser(t.db);
    const priv = await ensurePrivateWorkspace(t.db, userId);
    const u = { id: userId, isAnonymous: false };
    expect(await workspaceModeFor(t.db, u)).toBe('private');
    expect(await workspaceModeFor(t.db, u, true)).toBe('demo');
    // An anonymous WhatsApp link attempt ignores the cookie.
    expect(await workspaceModeFor(t.db, { id: userId, isAnonymous: true }, true)).toBe('private');

    const demo = await ensureDemoWorkspace(t.db, userId);
    expect(demo.mode).toBe('demo');
    expect((await t.db.select().from(s.chats).where(eq(s.chats.workspaceId, demo.id))).length).toBeGreaterThan(0);

    // Checking in from the demo keeps the private account from auto-delete.
    await t.db.update(s.workspaces).set({ lastSeenAt: new Date(0) }).where(eq(s.workspaces.id, priv.id));
    await markSeen(t.db, demo.id, userId);
    const [p] = await t.db.select().from(s.workspaces).where(eq(s.workspaces.id, priv.id));
    expect(p.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 60_000);

    // The demo expires: it is purged, the account and its private workspace stay.
    await t.db.update(s.workspaces).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(s.workspaces.id, demo.id));
    await purgeExpiredDemos(t.db);
    expect(await t.db.select().from(s.user).where(eq(s.user.id, userId))).toHaveLength(1);
    expect(await t.db.select().from(s.workspaces).where(eq(s.workspaces.id, priv.id))).toHaveLength(1);
    expect(await t.db.select().from(s.workspaces).where(and(eq(s.workspaces.ownerUserId, userId), eq(s.workspaces.mode, 'demo')))).toHaveLength(0);

    // An expired demo that was not purged yet is replaced by a fresh one.
    const again = await ensureDemoWorkspace(t.db, userId);
    await t.db.update(s.workspaces).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(s.workspaces.id, again.id));
    const fresh = await ensureDemoWorkspace(t.db, userId);
    expect(fresh.id).not.toBe(again.id);
    expect(fresh.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });
});
