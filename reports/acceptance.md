# ThreadMap acceptance report

Generated 25 Oct 2026. Branch `feat/threadmap-p0` (uncommitted working tree on base `002e6b7`). Environment: Windows 11, Node 24.14.1, PostgreSQL 17 (Docker in WSL2), image built with Docker 29.8.2.

## Gate status

| Gate | Status | Reason |
| --- | --- | --- |
| **BUILD_READY** | **BLOCKED_EXTERNAL** | A01–A18 pass (A18 live on Token Factory, 26 Oct). A19 needs owner QR pairing; A20 needs cloud hosting, which the owner deferred to an optional Phase 2 (app runs locally with Token Factory for Phase 1). |
| **SUBMISSION_READY** | **BLOCKED_EXTERNAL** | Requires BUILD_READY, completed human review (UNREVIEWED), public repo/video/Devpost publication (prepared, not published). |

## Reproduce

```bash
npm ci
docker run -d --name tm-pg -e POSTGRES_USER=threadmap -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=threadmap -p 5432:5432 postgres:17-alpine
DATABASE_URL=postgres://threadmap:devpass@127.0.0.1:5432/threadmap npm run db:migrate
npm run typecheck && npm run lint && npm test          # 43/43
npm run build && docker build -t threadmap:local .
# compose stack + origin bootstrap + owner (README "Run the full image locally"), then:
E2E_BASE_URL=http://localhost:3000 npm run test:e2e   # 5/5 (also 10/10 with --repeat-each 2)
```

Results observed on 25 Oct 2026: typecheck 0 errors; ESLint 0 errors (9 React-Compiler advisory warnings); Vitest 5 files / 43 tests passed; `next build` succeeded with 0 warnings; production image built (`sha256:f9784ff7… (base pinned by digest)`); Playwright 5/5 passed against the production image.

## A01–A20

| ID | Status | Evidence | Notes |
| --- | --- | --- | --- |
| A01 | PASS | Image build; `compose.yaml` (db → migrate → app); demo loads (curl + Playwright). | Built from the working tree; re-verify from a clean clone after the owner commits. Cloud execution is A20. |
| A02 | PASS | `tests/fixture-pipeline.test.ts` (4 roots per chat, 300 = 120/100/80, six-level branch, same-title Tips under different parents, mixed topic/discussion children); zero-count roots render outlined with "0 messages"; unknown counts render dashed "loading" (`MapView`). | No depth cap anywhere (DB, prompts, UI). |
| A03 | PASS | Native-shaped Baileys events → real normalizer: incoming/outgoing, Unicode/multiline, group/direct, system stub, attachments, history/live overlap, PN/LID learning, out-of-order edit/revoke, unsupported (location, poll, view-once), reactions/receipts ignored (`tests/unit.test.ts`, `tests/fixture-pipeline.test.ts`). | |
| A04 | PASS | `validateTaxonomy` rejects unknown parents/refs, cycles, cross-root assignments, empty topics; DB trigger rejects self/ancestor cycles and cross-chat/root parents; stale revisions not placed (`tests/ai-failures.test.ts`, `tests/unit.test.ts`, `tests/graph-behaviour.test.ts`). | |
| A05 | PASS | Deep file/source opened from Knowledge at depth 0 and Programming at depth 1 with full 7-element path, sender, time; unavailable/failed media states (service tests + Playwright). | |
| A06 | PASS | Replays add no duplicates (`update-20` replay: 0 inserted / 20 duplicates); fingerprinted jobs prevent repeated inference; review/overrides preserved. | Companion process restart against a real session: part of A19 (blocked). |
| A07 | PASS | Exactly +20 human messages, initially Missed; identical "Sounds good"/"Thanks!" kept distinct; new-only cutoff and history cap (30) with live capture continuing (`tests/connector.test.ts`). | |
| A08 | PASS | Revision-aware Read; stale revision rejected; edit → Missed across all ancestors; manual Missed persists with no auto-reversal; opening lists/maps changes no review rows (service tests + Playwright 2 s dwell). | |
| A09 | PASS | Multi-placement dedup at every ancestor; frozen bulk snapshot: concurrent edit → `changedRevision: 1`, 20 new arrivals stay Missed, idempotent re-execution; All vs Missed size behavior (`tests/graph-behaviour.test.ts`). | |
| A10 | PASS | Date+Topic+Missed identical IDs across map counts, content (all pages), bulk, resources, search at shallow and deep topics; depth 0/1/2/6/All invariance of IDs, counts, diameters, bulk scope; hidden selected topic chip/path; stale responses discarded by request generation (UI) and cursor fingerprints (API). | |
| A11 | PASS | Subtree move at depth 5, merge with dedup + merge-map resolution, rename lock; cycle and cross-root rejection; depth preference per user/chat, URL override, isolation. | Survival through *live* regeneration covered by override-respecting publish path; fixture rebuild exercised. |
| A12 | PASS | Super-verified links (fixture provider) with evidence on both sides; unrelated "practice" overlap rejected; dismissals persist (`related` excludes dismissed). | Live Super verification is part of A18. |
| A13 | PASS | Cross-workspace denial for chats, content, messages, counts, review, topic edits, search, bulk snapshots, related; demo cannot pair/QR/list chats; unselected canary never stored; buffer size/TTL unit test; per-child env allowlists. | |
| A14 | PASS | 429/timeout retried within bounds, invalid JSON repaired once, invented refs dropped, outage leaves sources visible and analysis "failed"; budget-paused frontier resumes on the same ledger without cap reset and reaches depth 6 when the cap is raised. | |
| A15 | PASS | Deletion unsubscribes first and blocks replay resurrection until reselection; revocation purges body, revisions, file access and claims; stale replay stays tombstoned; object keys derived from IDs; downloads use sanitized `filename*`, `nosniff`, sandbox CSP. | |
| A16 | PASS | Zero model calls for navigation/depth/content/bulk preview (model_runs unchanged); ≤200 nodes with child paging and focus (unit); 200-node layout 0 overlaps (unit + perf); outline constant row heights and keyboard; reduced motion; live review update keeps drawer and camera (Playwright). | |
| A17 | PASS | Tests, lint, typecheck, production build and image build pass; no placeholder P0 workflow. | |
| A18 | **PASS** (26 Oct 2026) | `reports/live-inference.json` `a18_pipeline.status: PASS`: real Token Factory calls on fresh synthetic events. 9/9 jobs completed; Nano `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` 11/11 extract ok; Ultra `nvidia/Nemotron-3-Ultra-550b-a55b` taxonomy + refine (2 invalid outputs repaired by Super); Super `nvidia/nemotron-3-super-120b-a12b` 17/17 ok (extract escalation, repair, link verification: 2 verified / 3 rejected). Ultra path beyond two levels: Knowledge → Algorithms → Dynamic Programming → Longest Common Subsequence. | First run FAILED: Nano spent its whole output budget on its reasoning trace (finish_reason `length`). Fix: reasoning off for Nano and repairs (`NEBIUS_THINKING_OFF_ROLES`), 20-message extraction calls, uncovered messages escalate once to Super, truncated output detected. Live depth was 2–3 levels, not the fixture's 6 (the model decides depth from content). |
| A19 | **BLOCKED_EXTERNAL** | `reports/live-connection.json`. Local image reached WhatsApp and produced an owner-only QR (not scanned). | Owner: scan QR on the **hosted** UI and send test messages (after A20 deploy). |
| A20 | **BLOCKED_EXTERNAL** | `reports/cloud-deployment.json`; runbook and scripts prepared; local container-recreate rehearsal reconstructed identical counts/sizes. | Owner: Nebius project, CLI profile, registry, PostgreSQL, bucket, SecretStash, subnet, CPU preset, budget. |

## Exact completion scenario coverage

Verified against persisted state (fixtures, local): 300 messages / 4 roots per chat; six-level branch persisted and reopened; lazy/deep access with zero model calls and ≤200 nodes; move/merge/cycle rejection; depth 0/1/2/6/All invariance; sizing formula cases 0…10,001; size-aware layout; combined filters; focused-revision Read and manual Missed; cross-chat links; twenty-message replay once; edit/revocation; container restart reconstruction (local only).

Not yet verifiable (blocked): hosted QR pairing, live incoming/phone-sent messages, real Nemotron processing of fresh capture, Ultra-generated live path beyond two levels, laptop-off cloud capture, Endpoint stop/start.

## Measured limitations

- Long message bodies are truncated (1,200 chars) in prompts rather than sliced with offsets.
- No copy-on-write graph history; atomic transactional publication instead (see DECISIONS.md).
- Demo workspaces are seeded per guest (~2 s) and expire after 24 h.
- Image size 1.18 GB (full production `node_modules` for the companion/worker).
- Human semantic review not performed (`reports/evaluation.md`).
