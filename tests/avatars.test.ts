import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { avatarContent, discoveredChats, requestAvatars } from '../src/server/api/connector';
import type { AuthCtx } from '../src/server/api/service';
import { avatarObjectKey, getStorage } from '../src/server/storage';
import { deleteChat, ensureLinkedAccount, ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

let t: TestDb;
let dir: string;
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-avatars-'));
  process.env.STORAGE_DRIVER = 'local';
  process.env.LOCAL_STORAGE_DIR = dir;
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function account(chats: number) {
  const ws = await ensurePrivateWorkspace(t.db, await createUser(t.db));
  const la = await ensureLinkedAccount(t.db, ws.id);
  const rows = await t.db
    .insert(s.chats)
    .values(Array.from({ length: chats }, (_, i) => ({ workspaceId: ws.id, linkedAccountId: la.id, sourceKind: 'whatsapp' as const, nativeJid: `65${i}@s.whatsapp.net`, kind: 'direct' as const, title: `Friend ${i}` })))
    .returning();
  const ctx: AuthCtx = { userId: ws.ownerUserId, workspaceId: ws.id, mode: 'private' };
  return { ws, la, ids: rows.map((r) => r.id), ctx };
}
const commands = (wsId: string) => t.db.select().from(s.connectorCommands).where(and(eq(s.connectorCommands.workspaceId, wsId), eq(s.connectorCommands.type, 'fetch_avatars')));

describe('WhatsApp profile photos', () => {
  it('asks for each on-screen photo once, in capped batches, and never for other accounts', async () => {
    const a = await account(50);
    const other = await account(1);
    const r = await requestAvatars(t.db, a.ctx, { chat_ids: [...a.ids, other.ids[0]] });
    expect(r.requested).toBe(40); // batch cap
    const [cmd] = await commands(a.ws.id);
    expect((cmd.payload as { chatIds: string[] }).chatIds).toHaveLength(40);
    expect((cmd.payload as { chatIds: string[] }).chatIds).not.toContain(other.ids[0]);
    // Claimed: asking again for the same rows does nothing until the weekly re-check.
    expect((await requestAvatars(t.db, a.ctx, { chat_ids: a.ids.slice(0, 40) })).requested).toBe(0);
    await t.db.update(s.chats).set({ avatarCheckedAt: new Date(Date.now() - 8 * 86_400_000) }).where(eq(s.chats.id, a.ids[0]));
    expect((await requestAvatars(t.db, a.ctx, { chat_ids: [a.ids[0]] })).requested).toBe(1);
    await expect(requestAvatars(t.db, { ...a.ctx, mode: 'demo' }, { chat_ids: [a.ids[0]] })).rejects.toThrow(/demo/);
    await expect(requestAvatars(t.db, a.ctx, { chat_ids: ['not-a-uuid'] })).rejects.toThrow(/invalid/);
  });

  it('serves a stored photo only to its owner, with a versioned URL, and deletes it with the chat', async () => {
    const a = await account(2);
    const other = await account(1);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), crypto.randomBytes(60)]);
    const key = avatarObjectKey(a.ws.id, a.ids[0]);
    await getStorage().put(key, png, 'image/png');
    await t.db.update(s.chats).set({ avatarKey: key, avatarCheckedAt: new Date() }).where(eq(s.chats.id, a.ids[0]));

    const list = await discoveredChats(t.db, a.ctx);
    const withPhoto = list.chats.find((c) => c.id === a.ids[0])!;
    const without = list.chats.find((c) => c.id === a.ids[1])!;
    expect(withPhoto.avatar_url).toMatch(new RegExp(`^/api/chats/${a.ids[0]}/avatar\\?v=\\d+$`));
    expect(withPhoto.avatar_due).toBe(false);
    expect(without.avatar_url).toBeNull();
    expect(without.avatar_due).toBe(true);

    const res = await avatarContent(t.db, a.ctx, a.ids[0]);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await res.arrayBuffer()).equals(png)).toBe(true);
    await expect(avatarContent(t.db, other.ctx, a.ids[0])).rejects.toThrow(/not found/);
    await expect(avatarContent(t.db, a.ctx, a.ids[1])).rejects.toThrow(/no profile photo/);

    await deleteChat(t.db, a.ws.id, a.ids[0], (k) => getStorage().delete(k));
    expect(await getStorage().get(key)).toBeNull();
  });
});
