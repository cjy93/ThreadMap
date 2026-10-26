// WhatsApp companion entrypoint (separate Node process).
import { loadWhatsAppConfig } from '../lib/config';
import { parseEncryptionKey } from '../server/crypto';
import { getDb } from '../server/db';
import { getStorage } from '../server/storage';
import { Companion } from '../server/wa/companion';

async function main() {
  const cfg = loadWhatsAppConfig();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not configured');
  // Fails closed: a missing/invalid key never silently generates a new one.
  const key = parseEncryptionKey(cfg.WHATSAPP_AUTH_ENCRYPTION_KEY);
  const companion = new Companion({ db: getDb(), dbUrl: url, storage: getStorage(), cfg, key });
  await companion.start();
  const stop = async () => {
    await companion.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}

main().catch((e) => {
  console.log(JSON.stringify({ at: new Date().toISOString(), proc: 'companion', msg: 'fatal', error: e instanceof Error ? e.message.slice(0, 160) : 'unknown' }));
  process.exit(1);
});
