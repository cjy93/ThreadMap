// Least-privilege grants for the three runtime roles (created beforehand in
// Managed PostgreSQL). Encrypted WhatsApp auth records are readable only by the
// companion role. Run with the migration identity after migrations.
//   TM_WEB_ROLE=... TM_COMPANION_ROLE=... TM_WORKER_ROLE=... node dist/cli/apply-grants.js
import { closeDb, getPool } from '../server/db';

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(s)) throw new Error(`invalid role name: ${s}`);
  return `"${s}"`;
};

async function main() {
  const roles = { web: process.env.TM_WEB_ROLE, companion: process.env.TM_COMPANION_ROLE, worker: process.env.TM_WORKER_ROLE };
  if (!roles.web || !roles.companion || !roles.worker) {
    console.log(JSON.stringify({ grants: 'skipped', reason: 'TM_WEB_ROLE/TM_COMPANION_ROLE/TM_WORKER_ROLE not set (single-role deployment)' }));
    return;
  }
  const pool = getPool();
  const all = [roles.web, roles.companion, roles.worker].map(ident).join(', ');
  const stmts = [
    `GRANT USAGE ON SCHEMA public TO ${all}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${all}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${all}`,
    `REVOKE ALL ON auth_records FROM ${ident(roles.web)}, ${ident(roles.worker)}`,
    `REVOKE UPDATE, DELETE ON runtime_settings FROM ${all}`,
    `REVOKE INSERT ON runtime_settings FROM ${all}`,
    // pg-boss maintains its own schema; only the worker needs to create it.
    `CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION ${ident(roles.worker)}`,
  ];
  for (const s of stmts) await pool.query(s);
  console.log(JSON.stringify({ grants: 'applied', roles: Object.keys(roles) }));
  await closeDb();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
