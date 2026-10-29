# ThreadMap implementation decisions

Recorded during implementation (25 Oct 2026). Each entry states the decision and why.

## Stack and versions

- **Node 24.14.1** (local) / `node:24-bookworm-slim` (image). **Next.js 16.4.3**, React 19.3.1, **TypeScript 5.9.3** (TS 7 native compiler not used: Next's type-check integration expects the TS 5 API).
- **Baileys `7.0.0-rc14`** (npm `latest` dist-tag at implementation time; the 7.x line carries LID/PN alias support required by the spec; `legacy` is 6.7.24). Event shapes verified against `node_modules/baileys/lib/Types/Events.d.ts` and `Utils/process-message.js` of the pinned build: revocations and edits arrive as `messages.update` (`messageStubType: 1` / `editedMessage`), so the normalizer handles both those and protocol messages inside upserts/history.
- **pg-boss 12.38.0**, **Better Auth 1.7.12** (Drizzle adapter, PostgreSQL sessions, anonymous plugin for demo guests), **Drizzle ORM 0.45.4** + drizzle-kit migrations, Zod 4, @xyflow/react 12, Vitest 5, Playwright 1.64.

## Data model

- **Dedupe identity = (chat, native message id, fromMe).** The participant JID is stored but not part of the identity hash, because the same message can be redelivered addressed by LID or PN; WhatsApp message IDs are random per sender. Aliases are resolved separately (`participant_aliases`, `chat_aliases`) from authoritative `lid-mapping.update` / `remoteJidAlt` / `participantAlt` only.
- **Recursive topics:** one `topics` table with `parent_id`; depth derived from ancestry. Database trigger rejects self-parenting, cross-chat/root parents, retired parents and ancestor cycles (defense in depth beyond the application checks); a partial unique index enforces exactly one CATEGORY per root per chat. Taxonomy mutations lock the chat row so two concurrent valid-looking moves cannot combine into a cycle.
- **Graph versions:** publication is a single transaction that writes topics/placements/claims and bumps `chats.graph_version` (the atomic current pointer). Readers use REPEATABLE READ snapshots for tree + counts + versions. Full copy-on-write graph history was not implemented; the previous topology remains served until the publishing transaction commits, and stale claims/links are suppressed immediately on edit/revoke.
- **Counts:** computed per request with a recursive closure CTE over live topics joined to placements and the shared `matchingMessagesSql` filter — never by summing children. `count_version = g<graph>.s<source>.r<user review>`; `filter_fingerprint` hashes user + workspace + chats + content filter (not depth/pagination). Measured p95 ≤ 0.35 s at 10,000 messages / 1,011 topics, so no count cache was added (a cache would need the same keys).
- **Edited messages** keep their placements (membership) but become Missed for the new revision; claims and links citing them are invalidated immediately; the new revision is re-queued for analysis.
- **Merges** retire the topic (`retired_into`) and keep a transitive `topic_merge_map`, so saved filters/links resolve to the survivor.

## Analysis pipeline

- **Microbatch extraction (Nano)** per ≤60 messages / ≈0.6 × input-token cap, with 10 preceding context messages that may not be assigned. Uncovered messages get one retry, then a visible "Unclassified messages / Needs review" unit.
- **Initial taxonomy (Super, in windows of up to 40 discussions; was Ultra)** is debounced until no extraction for the chat is pending, then proposes a flat node list (max 40 nodes/call). Nodes flagged `may_subdivide` with ≥2 direct units become **refinement frontiers**; each frontier is a `refine` job sharing the originating `logical_job_id` and therefore the same `budget_ledger` row. Budget exhaustion marks the frontier `budget_paused`; `POST /api/jobs/:id/retry` (or `resumePausedFrontiers`) resumes it without resetting caps.
- **Single-child chains:** refinement requires ≥2 units, so a branch holding a single discussion is not subdivided further (spec: avoid redundant single-child chains). The fixture content was adjusted accordingly (e.g., *Event planning* holds the *Venue logistics* discussion rather than a one-child *Venue* topic).
- **Secondary placements** (a message also belonging elsewhere, e.g. a link under Resources) are validated like unit assignments and follow refinement.
- **JSON mode:** `json_object` by default; `json_schema` only for roles listed in `NEBIUS_JSON_SCHEMA_ROLES` after `models:discover` capability-tests them. Reasoning traces (`<think>`) are stripped before parsing; Zod validation always applies; one Super repair call per invalid output.
- **Fixture provider** answers from the manifest and emulates bounded output (≤2 new levels per call) so the real frontier machinery is exercised. Its runs are recorded with `provider='fixture'` and its placements with `provenance='fixture'`; it can never satisfy A18.
- Long bodies are truncated to 1,200 characters in prompts (marked `[truncated]`) rather than sliced into offset-bearing analysis slices; the intact source is always preserved. Recorded as a limitation.

## WhatsApp companion

- Auth state: AES-256-GCM per record with AAD `account|category|id`; creds and every Signal key category persisted through `keys.set`; wrong/missing key ⇒ `relink_required`, never a new key.
- Lease: session-scoped `pg_try_advisory_lock` on a dedicated connection **plus** a lease row with a monotonically increasing fencing token (expired, never deleted, on release). Auth writes and source ingestion check the fence inside their transactions; lease loss closes the socket.
- QR: delivered via `pg_notify('tm_qr')` (not durable, not logged) → web memory (≤120 s) → owner-only SSE notice → owner-only `GET /api/whatsapp/qr`. Never in command payloads or logs.
- `markOnlineOnConnect=false`; no `sendMessage`, `readMessages` or receipt calls anywhere in the codebase.
- A different WhatsApp account linking to an existing workspace is refused (`account_fingerprint` = SHA-256 of the account user id).

## Web, auth and origin

- `PUBLIC_ORIGIN_MODE=database_bootstrap`: until `runtime_settings` has a row for `DEPLOYMENT_ID`, Better Auth is not constructed, sign-in/pairing return 503 and `/api/health/ready` reports `origin_configured:false`. Host/forwarded headers are never used. The origin is reloaded every 15 s.
- Every mutation requires `Origin` == trusted origin (in addition to Better Auth's own checks). Public sign-up is disabled; owners are provisioned by CLI.
- Demo guests: Better Auth anonymous users, each with an isolated workspace seeded from the labeled fixture replay (≈2 s) and a 24 h expiry. Rate limits: email sign-in 10/min, anonymous 30/min, global 300/min per IP (in-memory; single web process per Endpoint).
- No Endpoint `--auth token`: the browser authenticates with ThreadMap sessions; a shared Endpoint bearer token would have to live in frontend code, which the spec forbids.

## Deployment

- Admin execution path inside the private network = one-off **Serverless Jobs** from the same image in the same subnet (`migrate`, `apply-grants`, `bootstrap-origin`, `create-owner`). This is an operational use of Jobs, not analysis offload; analysis stays in the Endpoint's pg-boss worker.
- Only Nebius CLI commands documented on docs.nebius.com are used (`ai endpoint create/get/list/stop/start/delete`, `ai job create/list/logs`, `mysterybox secret create`, `registry configure-helper`, `msp postgresql v1alpha1 cluster get-by-name`). Installing the Nebius CLI in this coding environment was not permitted, so the script has not been executed against a real account.

## Hosting on NVIDIA Brev (owner change, 28 Oct 2026)

- **Deployed on an NVIDIA Brev instance with Docker Compose** (`deploy/vm/`): PostgreSQL in a container with its data on the `pgdata` volume, the one ThreadMap image (web, companion, worker), and photos/files on the `objects` volume. Nemotron still runs on Nebius Token Factory; the instance only needs a CPU.
- **HTTPS:** either a Brev tunnel to port 3000 (Brev may ask visitors to sign in) or ports 80/443 opened with Caddy obtaining a certificate (`--profile https`). The app's port is bound to `127.0.0.1`, so it is never reachable on the public IP directly.
- **Origin:** `PUBLIC_ORIGIN_MODE=explicit` with `APP_URL=https://<DOMAIN>`, instead of the database bootstrap used for Serverless Endpoints. `APP_MODE=development` only so the database on Docker's private network is reached without TLS.
- **Why:** the owner's choice of platform. The Nebius Serverless Endpoint path (`deploy/nebius/`) is kept but not used.

## Delete on leave (owner change, 28 Oct 2026)

- **No ThreadMap page open for 30 minutes = Disconnect and delete my data.** Each open page posts to `/api/presence` every minute (and when the tab becomes visible), updating `workspaces.last_seen_at`. The worker's minute sweep (`deleteAbandoned`) queues the companion's `delete_account` command once per account (idempotency key), signs out its sessions; the companion logs the device out of WhatsApp and deletes the account with every stored file. An account that never linked a phone is deleted directly.
- **Why a timeout, not "on close":** a browser cannot reliably report being closed — the unload signal also fires on reloads and navigation, and never fires on crashes, sleep or lost connections. Thirty minutes survives reloads and short drops.
- **Trade-off:** capture no longer continues with the browser closed; reopening means scanning the QR again and rebuilding maps. `AUTO_DELETE_AFTER_MINUTES=0` turns it off (e.g. for development).

## 30 minutes to choose chats (owner change, 29 Oct 2026)

- **The pre-selection buffer holds unopened chats' linking history for 30 minutes** (`WHATSAPP_PRESELECTION_BUFFER_TTL_SECONDS=1800`, was 300), the same as auto-delete. Still memory only and bounded by `WHATSAPP_PRESELECTION_BUFFER_MIB` (32 MiB); it is never saved, logged or sent to a model, and an app restart, pause or disconnect clears it.
- **After the window the chat list shows only opened chats.** A fresh QR scan sets `connection_status.history_window_until` (scan time + TTL); a restart without a scan sets it to null, since the memory buffer is gone. The Connect page counts down while it is open; once closed it explains that a chat opened now would start empty and that adding people or groups means *Disconnect & delete my data* and scanning again.
- **Trade-off:** unopened chats' recent messages sit in server memory for up to 30 minutes instead of 5 — longer exposure to anyone with access to the server's memory, and up to 32 MiB per linked account held longer.

## Database on Supabase, encrypted connections (owner choice, 28 Oct 2026)

- **Choice:** *connection + Supabase at-rest*. Once the database is on Supabase: Supabase's AES-256 at-rest encryption (always on), **Enforce SSL** switched on, and ThreadMap connecting with the Supabase CA (`DATABASE_CA_CERT_FILE`, `APP_MODE=hosted` so it refuses to start without one), certificate and hostname verified. Session pooler or direct connections only (the companion's advisory lock and LISTEN/NOTIFY break under transaction pooling).
- **Not chosen:** app-side or per-user encryption of message text (it would move search out of the database). WhatsApp credentials stay app-encrypted (AES-256-GCM) as before.
- **Migrated 28 Oct 2026:** `pg_dump --no-owner --no-privileges` of the local database restored into Supabase in one transaction over `sslmode=verify-full`; all 57 tables' row counts matched; the WhatsApp link moved with the data (no rescan). Locally switched over with a git-ignored `compose.override.yaml` (session pooler, CA file, `DATABASE_REQUIRE_TLS=1`); the local `db` container is kept as a fallback. Enforce SSL verified: a non-SSL connection is refused.
- **Moved to Singapore, 29 Oct 2026:** a project's region cannot change, so the owner created a new, empty project in Singapore (`ap-southeast-1`) and pointed `.env` at it; Tokyo (~70 ms per query from Singapore) is no longer used. Same CA file; `bootstrap-origin` and a new WhatsApp link were needed.
- **Connection budget:** the free plan's session pooler allows 15 connections. Web 2+1, companion 5+1+1 (`COMPANION_DB_POOL_MAX`, a per-process override of `DB_POOL_MAX`), worker 2+1+1 (`PGBOSS_POOL_MAX=1`) = at most 14.
- **What a remote database broke, and the fixes** (all invisible on a local database, where a query takes under 1 ms):
  - *Linking failed* ("check your connection", WhatsApp code 503): Baileys stores 812 pre-keys at once and the key store wrote one row per round trip — over a minute. Keys are now written in multi-row batches of up to 500.
  - *The companion crash-looped and the new link was logged out:* history-sync writes held `FOR SHARE` on the lease row long enough to block the 10-second renewal past its 30-second TTL. Writes now take `FOR KEY SHARE`, which a renewal `UPDATE` does not wait for; a takeover locks the row `FOR UPDATE` first, so it still waits for writes fenced by the previous owner. The companion's pool was also raised from 2 to 5.
  - *"Generating QR code…" forever / Ask replies lost:* when Supabase dropped all connections, the pooled clients reconnected but the three LISTEN clients went silent without an error. `listenForever()` adds TCP keepalive, a 30-second ping and reconnect.
- **Remaining:** the same setup on the Brev instance (`deploy/vm/compose.supabase.yaml`, `APP_MODE=hosted`); runbook in `docs/threadmap/ENCRYPTION.md`. Turn off Supabase's Data API (unused; tables have no RLS because ThreadMap connects as the owner).

## UI theme

- Visual design: a dark navy **night** theme and a peach **twilight** light theme, frosted-glass panels, orange glowing primary buttons, Fraunces display headings, Albert Sans body text and Antonio uppercase labels. It is written in our own CSS, taking the general look of a public portfolio site as a reference; no markup, artwork or code was copied.
- Plain CSS variables in `src/app/globals.css`, not Tailwind: every component already uses semantic class names, so swapping the variables restyles the whole app without rewriting markup or adding a build dependency.
- `data-theme` on `<html>` is set before first paint by an inline script (`src/ui/theme.ts`): a stored choice wins, otherwise the OS `prefers-color-scheme`; without JavaScript the page uses night. The toggle renders only after hydration (`useSyncExternalStore`), so server and client HTML match.
- Map node geometry is part of the sizing contract (A16): the theme changes only colours, fills and the selection halo — never border widths, font sizes or diameters. Node fills use the solid `--surface` colour so edges never show through a node.
- `next/font` downloads the Google fonts at **build** time and self-hosts them, so the running app makes no font requests; the image build needs network access (as `npm ci` already does). The landing-page starfield is CSS-only and is switched off by the existing reduced-motion rule.

## Four fixed roots (owner change, 27 Oct 2026)

- The owner extended the spec's three roots to four: **Knowledge**, **General Chat**, **Events and Activities** (`EVENTS_ACTIVITIES`) and **Resources**, in that order. Events and Activities holds meetups, hackathons, sessions, trips, deadlines, dates, venues and the planning around them; General Chat keeps greetings, small talk and quick coordination.
- Existing chats get the new root from migration `0006_events_root`; new chats from `ensureRoots`. The `root` column is plain text, so no type change was needed.
- Fixtures: the event-like General Chat topics (Event planning, Scheduling, Plans) moved under Events and Activities. Message totals (300 = 120/100/80) are unchanged. The frozen evaluation split now has up to 20 distinct examples per root (74 total: Resources has only 14 distinct messages, where the old split repeated some).

## Tooling notes

- ESLint uses `eslint-config-next` (core-web-vitals + typescript). The React Compiler advisory rules `set-state-in-effect` and `preserve-manual-memoization` are warnings (fetch-on-change effects are intentional); all other rules are errors and pass.
- React Flow disables pointer events on non-selectable nodes; nodes set `pointer-events: all`. The size legend sits bottom-right with `pointer-events: none` so it never blocks map controls (both found by Playwright).
