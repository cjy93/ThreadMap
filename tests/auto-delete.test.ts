import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { deleteAbandoned, markSeen } from '../src/server/presence';
import { ensureLinkedAccount, ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

// Forgetting "Disconnect and delete my data": with no ThreadMap page open for 30
// minutes, the account is deleted the same way (the companion unlinks the device,
// then deletes everything).
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t?.close());
afterEach(() => {
  delete process.env.AUTO_DELETE_AFTER_MINUTES;
});

async function account(opts: { linked: boolean; seenMinutesAgo: number }) {
  const userId = await createUser(t.db);
  const ws = await ensurePrivateWorkspace(t.db, userId);
  if (opts.linked) await ensureLinkedAccount(t.db, ws.id);
  await t.db.insert(s.session).values({ id: crypto.randomUUID(), token: crypto.randomUUID(), userId, expiresAt: new Date(Date.now() + 86_400_000) });
  await t.db.update(s.workspaces).set({ lastSeenAt: new Date(Date.now() - opts.seenMinutesAgo * 60_000) }).where(eq(s.workspaces.id, ws.id));
  return { userId, ws };
}
const deleteCommands = (wsId: string) => t.db.select().from(s.connectorCommands).where(and(eq(s.connectorCommands.workspaceId, wsId), eq(s.connectorCommands.type, 'delete_account')));

describe('deleting accounts nobody has open', () => {
  it('queues the delete once for an account left for 30 minutes, and leaves open ones alone', async () => {
    const left = await account({ linked: true, seenMinutesAgo: 31 });
    const open = await account({ linked: true, seenMinutesAgo: 1 });
    expect(await deleteAbandoned(t.db)).toBeGreaterThanOrEqual(1);
    expect(await deleteCommands(left.ws.id)).toHaveLength(1);
    expect(await deleteCommands(open.ws.id)).toHaveLength(0);
    // Signed out everywhere; asking again queues nothing more.
    expect(await t.db.select().from(s.session).where(eq(s.session.userId, left.userId))).toHaveLength(0);
    await deleteAbandoned(t.db);
    expect(await deleteCommands(left.ws.id)).toHaveLength(1);
  });

  it('keeps an account whose page checks in', async () => {
    const a = await account({ linked: true, seenMinutesAgo: 45 });
    await markSeen(t.db, a.ws.id);
    await deleteAbandoned(t.db);
    expect(await deleteCommands(a.ws.id)).toHaveLength(0);
  });

  it('deletes an account that never linked a phone straight away', async () => {
    const a = await account({ linked: false, seenMinutesAgo: 40 });
    await deleteAbandoned(t.db);
    expect(await t.db.select().from(s.user).where(eq(s.user.id, a.userId))).toHaveLength(0);
    expect(await t.db.select().from(s.workspaces).where(eq(s.workspaces.id, a.ws.id))).toHaveLength(0);
  });

  it('can be switched off', async () => {
    process.env.AUTO_DELETE_AFTER_MINUTES = '0';
    const a = await account({ linked: true, seenMinutesAgo: 600 });
    expect(await deleteAbandoned(t.db)).toBe(0);
    expect(await deleteCommands(a.ws.id)).toHaveLength(0);
  });
});
