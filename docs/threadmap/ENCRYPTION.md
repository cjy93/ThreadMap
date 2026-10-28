# "Set up encryption" — runbook (after moving the database to Supabase)

**Trigger:** when the owner says **"set up encryption"**, do the steps below.
**Precondition:** ThreadMap's database has already been migrated to **Supabase**. If it
has not, stop and say so — this runbook does not do the migration.

**What "encryption" means here (owner's choice, 28 Oct 2026):** *connection + Supabase
at-rest encryption*:

| Layer | Who does it | What it protects against |
|---|---|---|
| **At rest** — AES-256 on Supabase's disks and backups | Supabase, always on ([supabase.com/security](https://supabase.com/security)) | someone getting the physical disks or backup files |
| **In transit** — TLS between ThreadMap (on NVIDIA Brev) and Supabase, certificate and hostname verified | ThreadMap + Supabase's *Enforce SSL* setting | anyone reading or tampering with traffic between Brev and Supabase |
| WhatsApp login (credentials and Signal keys) | ThreadMap already, with `WHATSAPP_AUTH_ENCRYPTION_KEY` (AES-256-GCM) | anyone who can read the database |

**Not included (by choice):** message text, summaries and topic titles are stored
readable in Postgres, so Supabase staff and anyone with the database password can read
them. App-side or per-user content encryption was offered and not chosen; it would move
search out of the database.

## Steps

### 1. Supabase: refuse unencrypted connections

1. Supabase dashboard → project → **Database settings** → turn on **Enforce SSL on
   incoming connections**. This restarts the database (a few minutes of downtime).
   Docs: [Postgres SSL Enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement).
2. In the same place (or the project's **Connect** panel), **download the server root
   certificate** (CA). Save it on the Brev instance as `deploy/vm/supabase-ca.crt`
   (git-ignored, see step 2) — it is not secret, but it pins which server ThreadMap trusts.

### 2. ThreadMap: verify Supabase's certificate on every connection

ThreadMap already verifies certificates when given a CA (`pgSslOptions` in
`src/server/db.ts`: `rejectUnauthorized: true`, hostname checked; any `sslmode=…` in a URL
is stripped so it cannot weaken this). With `APP_MODE=hosted` it **refuses to start
without a CA**, so a missing certificate can never silently fall back to plain text.

1. **Connection strings:** use Supabase's **Session pooler** (or direct) connection
   string for `DATABASE_URL`, `COMPANION_DATABASE_URL`, `WORKER_DATABASE_URL` and the
   migration URL. **Not the Transaction pooler (port 6543):** the WhatsApp companion
   holds a session advisory lock, and the web and worker processes use `LISTEN/NOTIFY`,
   which transaction pooling breaks.
2. **Settings** in `deploy/vm/.env.vm`:
   ```
   APP_MODE=hosted
   DATABASE_CA_CERT_FILE=/run/secrets/supabase-ca.crt
   ```
3. **Compose** (`deploy/vm/compose.yaml`): for `migrate` and `app`, take the database URLs
   from `.env.vm` instead of the local `db` service, mount the certificate, and drop the
   local `db` service and its `depends_on`:
   ```yaml
   volumes:
     - ./supabase-ca.crt:/run/secrets/supabase-ca.crt:ro
   ```
   `deploy/vm/supabase-ca.crt` is already in `.gitignore` (nothing of a deployment's
   configuration is committed).
4. Restart: `docker compose --env-file .env.vm up -d --build` (plus `--profile https` if
   Caddy is used).

### 3. Check it is really encrypted

1. The app starts (with `APP_MODE=hosted`, a missing or wrong CA stops it at startup).
2. In Supabase's SQL editor, while ThreadMap is running:
   ```sql
   SELECT a.application_name, s.ssl, s.version, s.cipher
   FROM pg_stat_ssl s JOIN pg_stat_activity a USING (pid)
   WHERE a.application_name LIKE 'threadmap%';
   ```
   Every ThreadMap row must show `ssl = true` (TLS 1.2 or later). Note: through the
   pooler, `pg_stat_ssl` shows the pooler's connection; the enforced-SSL setting plus
   ThreadMap's verified client TLS cover the hop from Brev.
3. Negative test: temporarily point `DATABASE_CA_CERT_FILE` at a wrong certificate —
   the app must refuse to connect. Put the right one back.

### 4. Afterwards

- Record in `docs/threadmap/DECISIONS.md` that the database runs on Supabase with
  enforced, verified TLS, and update `README.md` / `deploy/vm/README.md` (the
  "Where your data lives" tables) and `SUBMISSION.md`'s privacy notes.
- Keep the Supabase database password only in `.env.vm` (git-ignored). Rotate it if it
  was ever shared.
- Photos and downloaded files stay on the Brev instance's `objects` volume; they are not
  in Supabase and are not covered by this runbook.
