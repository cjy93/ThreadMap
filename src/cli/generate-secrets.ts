// Generate application secrets locally for storage in SecretStash (or an
// ignored local env file). Prints to stdout only; never writes them to the repo.
// Generate ONCE and retain: a new WHATSAPP_AUTH_ENCRYPTION_KEY makes saved
// WhatsApp sessions unreadable (relink required).
import crypto from 'node:crypto';

const out = {
  BETTER_AUTH_SECRET: crypto.randomBytes(32).toString('base64url'),
  WHATSAPP_AUTH_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
  DEPLOYMENT_ID: `tm-${crypto.randomBytes(4).toString('hex')}`,
};
const format = process.argv[2] ?? 'env';
if (format === 'json') console.log(JSON.stringify(out, null, 2));
else for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
