# ThreadMap

ThreadMap turns busy WhatsApp conversations into navigable mind maps. Every opened chat gets four permanent roots — **Knowledge**, **General Chat**, **Events and Activities** and **Resources** — with a topic hierarchy NVIDIA Nemotron builds top-down (via Nebius Token Factory): broad subjects first, then narrower ones, at most six branches per node. Node size shows how many messages a branch holds, and any node opens the exact source messages and files beneath it, with a summary whose points cite their messages.

> **Status (28 Oct 2026):** running locally against real Nemotron inference (Token Factory) and a real WhatsApp link. The NVIDIA Brev deployment ([`deploy/vm`](deploy/vm/README.md)) is next. [`reports/acceptance.md`](reports/acceptance.md) predates the live runs and has not been updated.

Built for the Nebius × NVIDIA Global AI Hackathon (Best Apps and Agents). Specification: [`docs/threadmap/`](docs/threadmap/README.md).

## How it works

```
 phone (owner) ──QR──► Baileys companion ─┐            ┌─► Next.js web/API ◄── browser (SSE)
                     (linked device)      │ PostgreSQL │
                                          ├────────────┤
 Nebius Token Factory ◄── pg-boss worker ─┘ (messages, └─► file store (photos, downloaded files):
 (Nemotron Nano/Super/VL)                  maps, review,    a Docker volume, or S3-compatible storage
                                           queue, encrypted auth)
```

One container image, supervised as **three separate Node processes** (`dist/supervisor.js`): the web server (only exposed port, 3000), the WhatsApp companion and the analysis worker. Durable state lives outside the container: PostgreSQL (messages, topics, placements, review state, queue, encrypted Baileys credentials + Signal keys, trusted origin) and a file store for photos and downloaded files.

- **Capture:** incoming *and* owner-sent messages from opened chats only; native-key deduplication; revisions, edits, revocations with tombstones; out-of-order controls; phone-number/hidden-ID (PN/LID) alias learning, merging a contact seen under both into one chat; bounded memory-only pre-selection buffer (32 MiB, 30 minutes after a scan; afterwards only opened chats are listed); on-demand history requests; history cap that never caps live capture. Messages commit with an analysis outbox *before* any model call.
- **Reading (Nemotron Nano):** messages are segmented into discussions, each read with the conversation around it and its reply chain; small replies split off from the discussion they answer are joined back in code; small talk is screened off the map (anything a summary cites stays); images are described by Nemotron VL.
- **Map building (Nemotron Super):** top-down — the first level under each root, then each topic refined one level at a time, with a hard limit of six children per node enforced in code; roots are re-checked on a fresh rebuild; named software goes under Knowledge › Software; topics are named by subject. Windows shrink when an answer is cut off at the output limit; each refinement has its own call budget. All output is validated in code (IDs, scope, roots, cycles, empty topics, evidence revisions) and published atomically.
- **Navigation:** node diameter `D(n) = sqrt(64² + (220² − 64²) · clamp(ln(1+n)/ln(1+10000), 0, 1))` from server-derived distinct matching counts; ≤200 visible nodes, lazy child paging and branch focus. *Map from: Everyone / Others / You* shows a separate map built from one side's messages only.
- **Messages:** *Discussion* (reply chain, including answers given without Reply that Nemotron linked), *Chatroom* (the chat in time order, paging either way) and *Topic thread*; text is selectable, double-click opens.
- **Ask:** Nano turns a question into terms, including corrected spellings and other names the chat uses for the same thing; matching is fuzzy (pg_trgm); Super answers from the matches and discussion summaries with cited sources. Slow answers arrive when ready. No internet search.
- **Delete on leave:** every open page checks in each minute; when no page of an account has checked in for `AUTO_DELETE_AFTER_MINUTES` (30; `0` turns it off), the worker queues the same deletion as *Disconnect and delete my data* — the companion unlinks the device, then deletes the account, chats, messages, maps and files.
- **Review:** per-user, revision-aware Read/Missed; two-second foreground dwell marks only the focused revision; bulk actions freeze `(message, revision)` pairs; independent of WhatsApp receipts. ThreadMap never sends messages or read receipts.

## Quick start (local development)

Requirements: Node 24 LTS (tested 24.14.1), Docker (for PostgreSQL / the image).

```bash
npm ci
docker run -d --name tm-pg -e POSTGRES_USER=threadmap -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=threadmap -p 5432:5432 postgres:17-alpine
export DATABASE_URL=postgres://threadmap:devpass@127.0.0.1:5432/threadmap
npm run db:migrate
npm test                 # 137 integration/unit tests against real PostgreSQL
npm run lint && npm run typecheck
npm run image:build      # production image (docker build -t threadmap:local .)
```

Run the full image locally (development only — this cannot satisfy the cloud gate):

```bash
npm run secrets:generate > .env.compose          # then append the dev settings from .env.development.local.example
docker compose -p tmlocal up -d                  # db + migrate + app (3 supervised processes)
docker compose -p tmlocal exec app node dist/cli/bootstrap-origin.js <DEPLOYMENT_ID> http://localhost:3000
E2E_BASE_URL=http://localhost:3000 npm run test:e2e
```

Open http://localhost:3000 → **Try the demo** (isolated synthetic replay, pairing disabled) or **Connect WhatsApp** and scan the QR. There are no passwords: the WhatsApp account you scan with becomes your ThreadMap account. Every scan starts from scratch: the earlier account for that number (chats, messages, maps, photos) is deleted and a new, empty one is created. Reconnecting from a saved session (for example after a restart) keeps everything.

### Rebuild and restart after code changes

The containers run the `threadmap:local` image, so code changes (including UI/CSS) appear only after you rebuild the image and recreate the app:

```bash
npm run image:build                    # rebuild threadmap:local from the current code
docker compose -p tmlocal up -d        # recreates migrate + app on the new image; db is left running
docker compose -p tmlocal ps           # app should be "Up"; migrate "Exited (0)" is normal
docker compose -p tmlocal logs -f app  # watch startup (Ctrl+C stops following, not the app)
```

If `up -d` reports nothing to recreate, force it with `docker compose -p tmlocal up -d --force-recreate migrate app`. Then hard-refresh the browser (Ctrl+Shift+R) so it doesn't use cached styles.

### Start from an empty database (delete all data)

This deletes every account, chat, map and file. Afterwards WhatsApp must be linked again. With the database on Supabase (`compose.override.yaml`), run in WSL from the repo folder:

```bash
docker compose -p tmlocal rm -sf app                      # stop the app (frees its connections)
docker run --rm --env-file <(grep '^DATABASE_URL=' .env.compose) -v "$PWD/deploy/vm/supabase-ca.crt:/ca.crt:ro"   -e PGSSLMODE=verify-full -e PGSSLROOTCERT=/ca.crt postgres:17-alpine   sh -c 'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
    DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE;
    DROP SCHEMA public CASCADE; CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO postgres;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;"'
docker volume rm tmlocal_tm-objects                       # stored photos and files
docker compose -p tmlocal up -d                           # migrate recreates every table
docker compose -p tmlocal exec app sh -c 'node dist/cli/bootstrap-origin.js "$DEPLOYMENT_ID" http://localhost:3000'
```

- Drop **all four** schemas: the migration history lives in `drizzle`; if it survives, `migrate` thinks everything is applied, creates nothing, and the app crash-loops on missing tables.
- The last line is needed on every empty database (also a new Supabase project): until it runs, the page says *starting up* and linking is disabled.
- Before linking again, remove the old **Ubuntu** entry under WhatsApp → Linked Devices: the wipe does not tell the phone.

Other everyday commands:

| Command | Effect |
| --- | --- |
| `docker compose -p tmlocal restart app` | Restart the app on the **same** image (does not pick up code changes). |
| `docker compose -p tmlocal stop` / `start` | Pause and resume the whole stack; data is kept. |
| `docker compose -p tmlocal down` | Remove the containers. **This loses the local database** (the local `db` service has no named volume), so you must repeat `bootstrap-origin` and scan WhatsApp again. Photos and files are kept in the `tm-objects` volume. |

On Windows, if Docker is installed only inside WSL, run these commands from a WSL shell in the repo folder (for example `cd "/mnt/c/Users/<you>/.../ThreadMap"`), or prefix each one with `wsl -e bash -lc '…'`. Inside WSL, use `docker build -t threadmap:local .` instead of `npm run image:build`: WSL may pick up the Windows `npm`, which cannot see WSL's Docker.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run db:migrate` | Apply Drizzle migrations under an advisory lock (`MIGRATION_DATABASE_URL`). |
| `npm run fixtures:generate` | Regenerate the deterministic native-event fixtures + manifest + evaluation split (`fixtures/v1`). |
| `npm run secrets:generate` | Generate `BETTER_AUTH_SECRET`, `WHATSAPP_AUTH_ENCRYPTION_KEY`, `DEPLOYMENT_ID` once, for SecretStash. |
| `npm run origin:bootstrap` | In-network admin: write the observed HTTPS origin into `runtime_settings`. |
| `npm run models:discover` | Discover exact Nemotron IDs from `GET /v1/models` and capability-test each role (A18 prep). |
| `tsx src/cli/live-inference.ts` | A18: real pipeline run on fresh synthetic events → `reports/live-inference.json`. |
| `npm run perf:run` | 10,000-message performance check → `reports/performance-data.json`. |
| `deploy/vm` | **NVIDIA Brev (or any VM)** with Docker: PostgreSQL and files on volumes, optional HTTPS with Caddy (see [`deploy/vm/README.md`](deploy/vm/README.md)). |
| `deploy/nebius/deploy.sh <step>` | The original plan, **not used**: a Nebius Serverless Endpoint with Managed PostgreSQL and Object Storage (see [`deploy/nebius/README.md`](deploy/nebius/README.md)). ThreadMap is hosted on NVIDIA Brev instead. |

## Repository map

- `src/server/ingest` — Baileys event normalization (pinned 7.0.0-rc14 shapes), canonical persistence, pre-selection buffer.
- `src/server/graph` — recursive tree, shared content-filter contract, distinct recursive counts, projection, node content.
- `src/server/ai` — providers (Nebius, fixture), router (budget ledger, retries, repair), taxonomy validation, pipeline.
- `src/server/wa` — encrypted PostgreSQL AuthStateStore, single-owner lease with fencing, companion.
- `src/processes` — supervisor, companion and worker entrypoints. `src/app` + `src/ui` — Next.js routes and React UI.
- `src/app/globals.css` — the whole visual theme: CSS variables for the **night** (dark) and **twilight** (light) themes, glass panels, node colours. Fonts (Fraunces, Albert Sans, Antonio) load via `next/font` in `src/app/layout.tsx`; `src/ui/ThemeToggle.tsx` switches `<html data-theme>` and remembers the choice in `localStorage`.
- `fixtures/v1` — synthetic chats (300 human messages), control-event sequences, expected manifest, evaluation split.
- `tests/`, `e2e/` — Vitest integration tests (real PostgreSQL) and Playwright browser tests.

## Security and encryption

- **WhatsApp login** (credentials and Signal keys) is encrypted by ThreadMap itself (AES-256-GCM, `WHATSAPP_AUTH_ENCRYPTION_KEY`) before it reaches the database.
- **Database: Supabase** (since 28 Oct 2026; Singapore `ap-southeast-1` since 29 Oct, PostgreSQL 17). Supabase encrypts data at rest (AES-256); *Enforce SSL* is on, and ThreadMap verifies Supabase's certificate and hostname on every connection (`DATABASE_CA_CERT_FILE`), through the session pooler. Locally this is switched on by the git-ignored `compose.override.yaml`; the address is `DATABASE_URL` in `.env.compose` (Supabase's Session pooler URI), the only secrets file. Delete the override to fall back to the local `db` container. Remaining steps are in [`docs/threadmap/ENCRYPTION.md`](docs/threadmap/ENCRYPTION.md) ("set up encryption"). Message text itself is not encrypted by the app (by choice), so it stays searchable in the database.
- **Deletion:** *Disconnect and delete my data*, or no ThreadMap page open for 30 minutes, deletes the account with all its data and files.

## Honest limitations

Baileys is an **unofficial** WhatsApp Web library; this is an experimental linked-device prototype and WhatsApp may restrict it. The deployment stores opened chats in its database and sends the text being analysed to Nebius Token Factory. WhatsApp sends a chat's full history only once, at linking; a chat opened later recovers older messages only if the phone answers on-demand requests. A stopped instance does not capture messages. See [`docs/threadmap/DECISIONS.md`](docs/threadmap/DECISIONS.md) for implementation decisions and known gaps.

## License

MIT — see [LICENSE](LICENSE). Synthetic fixture content is original and fictional.
