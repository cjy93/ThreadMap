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

> **Current database (29 Oct 2026): a new, empty Supabase project in Singapore
> (`ap-southeast-1`)**, chosen to be close to the owner (Tokyo was ~70 ms per query, which
> made linking and history sync fail — see DECISIONS). Enforce SSL verified on it the same way
> (`ESSLREQUIRED` without SSL; TLS 1.3 with `verify-full`); the same CA file works (Supabase
> uses one root CA for all projects). Being empty, it needed `bootstrap-origin` and a new
> WhatsApp link. `.env` and `.env.supabase` hold its Session pooler URL. The Tokyo project is
> no longer used.
>
> **Done 28 Oct 2026** (first project `tczzpsmsbqgdslaisrwt`, Tokyo `ap-northeast-1`, PostgreSQL 17.6):
> Enforce SSL switched on — verified: a connection with `sslmode=disable` is refused
> (`ESSLREQUIRED`), and `sslmode=verify-full` with the downloaded CA succeeds through the
> session pooler. The CA is at `deploy/vm/supabase-ca.crt` on the owner's machine (copy it
> to the Brev instance). The connection string is kept in the git-ignored `.env.supabase`.
> Dashboard path: **Database → Configuration → Settings → SSL configuration**.

1. Supabase dashboard → project → **Database settings** → turn on **Enforce SSL on
   incoming connections**. This restarts the database (a few minutes of downtime).
   Docs: [Postgres SSL Enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement).
2. In the same place (or the project's **Connect** panel), **download the server root
   certificate** (CA). Save it on the Brev instance as `deploy/vm/supabase-ca.crt`
   (git-ignored, see step 2) — it is not secret, but it pins which server ThreadMap trusts.

### 2. ThreadMap: verify Supabase's certificate on every connection

> **"Set up encryption" run on 28 Oct 2026:**
> - Local app: `DATABASE_REQUIRE_TLS=1` in `compose.override.yaml` — like hosted mode, a
>   missing certificate stops the app, but without hosted mode's HTTPS-only address (the local
>   app runs on `http://localhost`). Takes effect with the next image rebuild.
> - Checked live: a non-SSL connection is refused (`ESSLREQUIRED`); `verify-full` with a
>   wrong CA (the public CA bundle) is refused (`certificate verify failed`); the right CA works.
> - Supabase's session pooler allows **15 connections** (free plan); pools are capped
>   (`DB_POOL_MAX=2`, `COMPANION_DB_POOL_MAX=5`, `PGBOSS_POOL_MAX=1`, at most 14 in all) —
>   before this the app could hit `EMAXCONNSESSION`. With the companion at 2, saving a new
>   link's history starved its lease renewal and the link was logged out (fixed 28 Oct).
> - NVIDIA Brev: `deploy/vm/compose.supabase.yaml` (hosted mode, CA required, no bundled
>   database), ready for when the instance is set up.
>
> **Migration, 28 Oct 2026** (to the Tokyo project; superseded by the empty Singapore project): the database was migrated (all 57 tables'
> row counts matched) and the local ThreadMap runs on Supabase through
> `compose.override.yaml` (git-ignored): all three connections use the session pooler with
> `DATABASE_CA_CERT_FILE` (certificate + hostname verified), pools capped (see above). The URL is in the
> git-ignored `.env` (`SUPABASE_DB_URL`). Still to do: `APP_MODE=hosted` (so a missing
> certificate stops the app) — locally it stays `development`; and the same switch on the
> NVIDIA Brev instance (`deploy/vm`).

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
