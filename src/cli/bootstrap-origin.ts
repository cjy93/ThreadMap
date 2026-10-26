// In-network admin CLI: write the exact HTTPS origin read from the Endpoint's
// control-plane metadata into runtime_settings for this DEPLOYMENT_ID.
// Usage (inside the private network, with the migration/admin role):
//   DATABASE_URL=... node dist/cli/bootstrap-origin.js <deployment-id> <https-origin>
import os from 'node:os';
import { closeDb, getDb } from '../server/db';
import { bootstrapOrigin } from '../server/origin';
import { sizingRevision } from '../lib/sizing';
import { loadViewConfig } from '../lib/config';

async function main() {
  const [deploymentId, origin] = process.argv.slice(2);
  if (!deploymentId || !origin) throw new Error('usage: bootstrap-origin <deployment-id> <https-origin>');
  const view = loadViewConfig();
  const revision = `${process.env.IMAGE_DIGEST ?? 'unknown-image'}|${sizingRevision(view.sizing)}|depth${view.defaultTopicDepth}|nodes${view.maxVisibleNodes}|page${view.contentPageSize}`;
  const o = await bootstrapOrigin(getDb(), deploymentId, origin, `cli@${os.hostname()}`, revision);
  console.log(JSON.stringify({ deployment_id: deploymentId, trusted_origin: o, config_revision: revision }));
  await closeDb();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
