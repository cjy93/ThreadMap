// Provision the workspace owner (public sign-up stays disabled).
// Usage: OWNER_EMAIL=... OWNER_PASSWORD=... node dist/cli/create-owner.js
import crypto from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import * as s from '../db/schema';
import { closeDb, getDb } from '../server/db';
import { ensureLinkedAccount, ensurePrivateWorkspace } from '../server/workspace';

async function main() {
  const email = process.env.OWNER_EMAIL?.trim().toLowerCase();
  const password = process.env.OWNER_PASSWORD;
  if (!email || !password || password.length < 12) throw new Error('set OWNER_EMAIL and OWNER_PASSWORD (12+ characters)');
  const db = getDb();
  let [u] = await db.select().from(s.user).where(eq(s.user.email, email));
  if (!u) {
    const id = crypto.randomUUID();
    [u] = await db.insert(s.user).values({ id, name: process.env.OWNER_NAME ?? 'Owner', email, emailVerified: true }).returning();
    await db.insert(s.account).values({ id: crypto.randomUUID(), accountId: id, providerId: 'credential', userId: id, password: await hashPassword(password) });
  } else {
    await db.update(s.account).set({ password: await hashPassword(password), updatedAt: new Date() }).where(eq(s.account.userId, u.id));
  }
  const ws = await ensurePrivateWorkspace(db, u.id);
  await ensureLinkedAccount(db, ws.id);
  console.log(JSON.stringify({ owner: 'provisioned', workspace: ws.id }));
  await closeDb();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
