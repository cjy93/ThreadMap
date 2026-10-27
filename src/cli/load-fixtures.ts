// Development/rehearsal only: load the labeled synthetic fixture chats into a
// WhatsApp-linked account's workspace and analyze them with FixtureModelProvider.
// Accounts are created by scanning the QR; their email is wa-<fingerprint>@whatsapp.threadmap.invalid.
// Refuses hosted mode: fixture content must never pose as live evidence.
//   DATABASE_URL=... OWNER_EMAIL=... node dist/cli/load-fixtures.js
import { eq } from 'drizzle-orm';
import * as s from '../db/schema';
import { loadFixtureWorkspace } from '../fixtures/load';
import { closeDb, getDb } from '../server/db';
import { getStorage } from '../server/storage';
import { ensurePrivateWorkspace } from '../server/workspace';

async function main() {
  if (process.env.APP_MODE === 'hosted') throw new Error('load-fixtures is disabled in hosted mode');
  const email = process.env.OWNER_EMAIL?.toLowerCase();
  if (!email) throw new Error('set OWNER_EMAIL');
  const db = getDb();
  const [u] = await db.select().from(s.user).where(eq(s.user.email, email));
  if (!u) throw new Error('account not found; connect WhatsApp first');
  const ws = await ensurePrivateWorkspace(db, u.id);
  const r = await loadFixtureWorkspace(db, ws.id, { storage: getStorage() });
  console.log(JSON.stringify({ loaded: 'fixture replay (labeled synthetic)', inserted: r.stats.inserted, chats: Object.keys(r.chatIdByKey) }));
  await closeDb();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
