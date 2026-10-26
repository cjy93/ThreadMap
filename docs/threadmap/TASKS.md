# T01–T16 tracker

Status as of 25 Oct 2026. "Done" = implemented with passing automated evidence; "Blocked" = needs an owner-supplied external prerequisite.

| ID | Status | Evidence / remaining |
| --- | --- | --- |
| T01 Runtime, contracts, migrations, supervisor | Done | `src/db/schema.ts`, migrations 0000/0001 (cycle trigger), `src/processes/*`, `Dockerfile`, `compose.yaml`; image builds and runs 3 children locally. |
| T02 Fixtures and evaluation | Done | `fixtures/v1` (300 human msgs, 13 files, 16 URLs, 2 languages, six-level branch, control sequences, update-20), `evaluation.json` (60/20/10). |
| T03 Ownership, demo, authz | Done | `tests/graph-behaviour.test.ts` isolation suite; demo cannot pair/QR (`tests/connector.test.ts`, local curl checks). |
| T04 Baileys session service | Done (live smoke partial) | Encrypted auth store + lease tests; local image reached WhatsApp and delivered an owner-only QR. Real pairing: **Blocked** (owner scan). |
| T05 Capture, selection, revisions | Done | Fixture replay through the real normalizer; dedupe, aliases, out-of-order edit/revoke, tombstones, cutoff, history cap tests. |
| T06 Nebius model discovery/router | Done (live **Blocked**) | `src/cli/discover-models.ts`, router failure tests; no `NEBIUS_API_KEY` here. |
| T07 Vertical slice (real) | **Blocked** | Requires T04 pairing + T06 key. Fixture vertical slice passes. |
| T08 Full pipeline | Done (live **Blocked**) | Recursive frontiers under one ledger, budget pause/resume, stale-result rejection; `src/cli/live-inference.ts` ready for A18. |
| T09 Map/outline/depth/sizing/drawer | Done | Service + Playwright tests (depth invariance, deep file from depth 0/1, outline parity, legend, reduced motion, live update). |
| T10 Review semantics | Done | Revision-aware dwell, manual Missed, frozen bulk scopes, ancestor aggregates tests + e2e. |
| T11 Filters and search | Done | Date+Topic+Missed parity across map/content/bulk/resources/search at shallow and deep topics. |
| T12 Corrections and cross-chat links | Done | Move/merge/rename/cycle rejection tests; Super-verified links with evidence both sides; dismissals. |
| T13 Recovery, deletion, isolation | Done | Delete-before-purge, replay resurrection prevention, lease fencing, provider outage tests. |
| T14 Nebius deployment | **Blocked** | `deploy/nebius/deploy.sh` + runbook + `scripts/cloud-verify.mjs` (rehearsed locally); needs Nebius project/CLI/IAM/budget. |
| T15 Full checks and reports | Partial | Deterministic A01–A17 PASS; A18–A20 BLOCKED_EXTERNAL; reports in `reports/`. Human evaluation UNREVIEWED. |
| T16 Submission packet | Prepared | `README.md`, `LICENSE`, `docs/threadmap/SUBMISSION.md` (description, testing guide, feedback, 2:45 script). Publication not performed. |
