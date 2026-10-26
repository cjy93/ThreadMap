# ThreadMap

ThreadMap turns busy WhatsApp conversations into navigable knowledge maps. Every selected chat gets three permanent roots — **Knowledge**, **General Chat** and **Resources** — with a recursive, evidence-backed topic hierarchy proposed by NVIDIA Nemotron (via Nebius Token Factory). Node size shows how many matching messages a branch holds (including every hidden descendant), and any root or topic opens the exact source messages and files beneath it, at any depth, without expanding the tree first.

> **Status (25 Oct 2026):** implementation, deterministic tests and local production-image runs are complete. The live gates — real Nemotron inference (A18), real WhatsApp pairing (A19) and the Nebius Endpoint deployment (A20) — are **BLOCKED_EXTERNAL** until the owner supplies credentials. See [`reports/acceptance.md`](reports/acceptance.md). Nothing in this repository claims a cloud deployment or live run that has not happened.

Built for the Nebius × NVIDIA Global AI Hackathon (Best Apps and Agents). Specification: [`docs/threadmap/`](docs/threadmap/README.md).

## How it works

```
 phone (owner) ──QR──► Baileys companion ─┐            ┌─► Next.js web/API ◄── browser (SSE)
                     (linked device)      │ PostgreSQL │
                                          ├────────────┤
 Nebius Token Factory ◄── pg-boss worker ─┘ (sources,  └─► Object Storage (cached files)
 (Nemotron Ultra/Nano/Super)               graph, review,
                                           queue, encrypted auth)
```

One container image, supervised as **three separate Node processes** (`dist/supervisor.js`): the web server (only exposed port, 3000), the WhatsApp companion and the analysis worker. All durable state is external: PostgreSQL (sources, recursive topics, placements, review state, depth preferences, refinement frontiers, queue, encrypted Baileys credentials + Signal keys, trusted origin) and S3-compatible Object Storage (cached attachments).

- **Capture:** incoming *and* owner-sent messages from selected chats only; native-key deduplication; revisions, edits, revocations with tombstones; out-of-order controls; PN/LID alias learning; bounded memory-only pre-selection buffer; new-only cutoff; history cap that never caps live capture. Sources commit with an analysis outbox *before* any model call.
- **Analysis:** Nano extracts discussion units; Ultra proposes a flat-node recursive taxonomy in bounded pieces and leaves a **refinement frontier** that continues under the *same* logical budget ledger; Super repairs invalid output, resolves ambiguous assignments and verifies cross-chat links. All output is validated in code (IDs, scope, roots, cycles, empty topics, evidence revisions) and published atomically.
- **Navigation:** Show depth 0/1/2/3/custom/All is display-only; counts, logical sizes, content and bulk scopes are identical at every depth. Node diameter `D(n) = sqrt(64² + (220² − 64²) · clamp(ln(1+n)/ln(1+10000), 0, 1))` from server-derived distinct matching counts. ≤200 visible nodes, lazy child paging and branch focus; stored depth is never truncated.
- **Review:** per-user, revision-aware Read/Missed; two-second foreground dwell marks only the focused revision; bulk actions freeze `(message, revision)` pairs; independent of WhatsApp receipts. ThreadMap never sends messages or read receipts.

## Quick start (local development)

Requirements: Node 24 LTS (tested 24.14.1), Docker (for PostgreSQL / the image).

```bash
npm ci
docker run -d --name tm-pg -e POSTGRES_USER=threadmap -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=threadmap -p 5432:5432 postgres:17-alpine
export DATABASE_URL=postgres://threadmap:devpass@127.0.0.1:5432/threadmap
npm run db:migrate
npm test                 # 43 integration/unit tests against real PostgreSQL
npm run lint && npm run typecheck
npm run image:build      # production image (docker build -t threadmap:local .)
```

Run the full image locally (development only — this cannot satisfy the cloud gate):

```bash
npm run secrets:generate > .env.compose          # then append the dev settings from .env.development.local.example
docker compose -p tmlocal up -d                  # db + migrate + app (3 supervised processes)
docker compose -p tmlocal exec app node dist/cli/bootstrap-origin.js <DEPLOYMENT_ID> http://localhost:3000
docker compose -p tmlocal exec -e OWNER_EMAIL=you@example.com -e OWNER_PASSWORD='12+ chars' app node dist/cli/create-owner.js
E2E_BASE_URL=http://localhost:3000 npm run test:e2e
```

Open http://localhost:3000 → **Try the demo** (isolated synthetic replay, pairing disabled) or sign in as the owner → **Connect WhatsApp**.

### Rebuild and restart after code changes

The containers run the `threadmap:local` image, so code changes (including UI/CSS) appear only after you rebuild the image and recreate the app:

```bash
npm run image:build                    # rebuild threadmap:local from the current code
docker compose -p tmlocal up -d        # recreates migrate + app on the new image; db is left running
docker compose -p tmlocal ps           # app should be "Up"; migrate "Exited (0)" is normal
docker compose -p tmlocal logs -f app  # watch startup (Ctrl+C stops following, not the app)
```

If `up -d` reports nothing to recreate, force it with `docker compose -p tmlocal up -d --force-recreate migrate app`. Then hard-refresh the browser (Ctrl+Shift+R) so it doesn't use cached styles.

Other everyday commands:

| Command | Effect |
| --- | --- |
| `docker compose -p tmlocal restart app` | Restart the app on the **same** image (does not pick up code changes). |
| `docker compose -p tmlocal stop` / `start` | Pause and resume the whole stack; data is kept. |
| `docker compose -p tmlocal down` | Remove the containers. **This loses the local database** (the `db` service has no named volume), so you must repeat `bootstrap-origin` and `create-owner` and pair WhatsApp again. |

On Windows, if Docker is installed only inside WSL, run these commands from a WSL shell in the repo folder (for example `cd "/mnt/c/Users/<you>/.../ThreadMap"`), or prefix each one with `wsl -e bash -lc '…'`. Inside WSL, use `docker build -t threadmap:local .` instead of `npm run image:build`: WSL may pick up the Windows `npm`, which cannot see WSL's Docker.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run db:migrate` | Apply Drizzle migrations under an advisory lock (`MIGRATION_DATABASE_URL`). |
| `npm run fixtures:generate` | Regenerate the deterministic native-event fixtures + manifest + evaluation split (`fixtures/v1`). |
| `npm run owner:create` | Provision the owner account (public sign-up is disabled). |
| `npm run secrets:generate` | Generate `BETTER_AUTH_SECRET`, `WHATSAPP_AUTH_ENCRYPTION_KEY`, `DEPLOYMENT_ID` once, for SecretStash. |
| `npm run origin:bootstrap` | In-network admin: write the observed HTTPS origin into `runtime_settings`. |
| `npm run models:discover` | Discover exact Nemotron IDs from `GET /v1/models` and capability-test each role (A18 prep). |
| `tsx src/cli/live-inference.ts` | A18: real pipeline run on fresh synthetic events → `reports/live-inference.json`. |
| `npm run perf:run` | 10,000-message performance check → `reports/performance-data.json`. |
| `deploy/nebius/deploy.sh <step>` | Nebius Endpoint deployment steps (see [`deploy/nebius/README.md`](deploy/nebius/README.md)). |

## Repository map

- `src/server/ingest` — Baileys event normalization (pinned 7.0.0-rc14 shapes), canonical persistence, pre-selection buffer.
- `src/server/graph` — recursive tree, shared content-filter contract, distinct recursive counts, projection, node content.
- `src/server/ai` — providers (Nebius, fixture), router (budget ledger, retries, repair), taxonomy validation, pipeline.
- `src/server/wa` — encrypted PostgreSQL AuthStateStore, single-owner lease with fencing, companion.
- `src/processes` — supervisor, companion and worker entrypoints. `src/app` + `src/ui` — Next.js routes and React UI.
- `src/app/globals.css` — the whole visual theme: CSS variables for the **night** (dark) and **twilight** (light) themes, glass panels, node colours. Fonts (Fraunces, Albert Sans, Antonio) load via `next/font` in `src/app/layout.tsx`; `src/ui/ThemeToggle.tsx` switches `<html data-theme>` and remembers the choice in `localStorage`.
- `fixtures/v1` — synthetic chats (300 human messages), control-event sequences, expected manifest, evaluation split.
- `tests/`, `e2e/` — Vitest integration tests (real PostgreSQL) and Playwright browser tests.

## Honest limitations

Baileys is an **unofficial** WhatsApp Web library; this is an experimental linked-device prototype and WhatsApp may restrict it. The deployment stores selected chats in its database and sends selected text to Nebius Token Factory. History recovery is best-effort and coverage gaps are shown, not hidden. A stopped Endpoint does not ingest messages. See [`docs/threadmap/DECISIONS.md`](docs/threadmap/DECISIONS.md) for implementation decisions and known gaps.

## License

MIT — see [LICENSE](LICENSE). Synthetic fixture content is original and fictional.
