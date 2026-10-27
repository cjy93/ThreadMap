import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { deleteMyAccount } from '../src/server/api/connector';
import type { AuthCtx } from '../src/server/api/service';
import { deleteAccountData, ensureLinkedAccount, ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t?.close());

async function account() {
  const userId = await createUser(t.db);
  const ws = await ensurePrivateWorkspace(t.db, userId);
  const la = await ensureLinkedAccount(t.db, ws.id);
  await t.db.insert(s.chats).values({ workspaceId: ws.id, linkedAccountId: la.id, sourceKind: 'whatsapp', nativeJid: '1@g.us', kind: 'group', title: 'Team', avatarKey: `ws/${ws.id}/avatar/a` });
  const sessionId = crypto.randomUUID();
  await t.db.insert(s.session).values({ id: sessionId, token: crypto.randomUUID(), userId, expiresAt: new Date(Date.now() + 86_400_000) });
  const ctx: AuthCtx = { userId, workspaceId: ws.id, mode: 'private' };
  return { userId, ws, la, sessionId, ctx };
}

describe('Disconnect / Sign out deletes the account', () => {
  it('signs the browser out at once and asks the companion to unlink WhatsApp and delete', async () => {
    const a = await account();
    await deleteMyAccount(t.db, a.ctx);
    expect(await t.db.select().from(s.session).where(eq(s.session.id, a.sessionId))).toEqual([]);
    const cmds = await t.db.select().from(s.connectorCommands).where(eq(s.connectorCommands.workspaceId, a.ws.id));
    expect(cmds.map((c) => c.type)).toEqual(['delete_account']);
    // The account itself stays until the companion has logged the device out.
    expect(await t.db.select().from(s.chats).where(eq(s.chats.workspaceId, a.ws.id))).toHaveLength(1);
    await expect(deleteMyAccount(t.db, { ...a.ctx, mode: 'demo' })).rejects.toThrow(/demo/);
  });

  it('deletes the chat list and everything else, and hands back stored files to purge', async () => {
    const a = await account();
    const other = await account();
    expect(await deleteAccountData(t.db, a.userId)).toEqual([`ws/${a.ws.id}/avatar/a`]);
    expect(await t.db.select().from(s.user).where(eq(s.user.id, a.userId))).toEqual([]);
    expect(await t.db.select().from(s.workspaces).where(eq(s.workspaces.id, a.ws.id))).toEqual([]);
    expect(await t.db.select().from(s.chats).where(eq(s.chats.workspaceId, a.ws.id))).toEqual([]);
    expect(await t.db.select().from(s.linkedAccounts).where(eq(s.linkedAccounts.id, a.la.id))).toEqual([]);
    // Other accounts are untouched.
    expect(await t.db.select().from(s.chats).where(eq(s.chats.workspaceId, other.ws.id))).toHaveLength(1);
  });
});
