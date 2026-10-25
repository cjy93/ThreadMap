# Claude Code goal for ThreadMap

Version 2.1 — 25 October 2026 — cloud-hosted linked-device prototype with recursive topic hierarchies.

## How to use this handoff

Copy this package into the repository as docs/threadmap/. Read THREADMAP_BUILD_SPEC.md, NEBIUS_DEPLOYMENT.md, IMPLEMENTATION_TASKS.md, and existing repository instructions before editing.

Claude Code documents /goal as a completion-condition workflow; it does not change the session's permission mode. Use the permissions appropriate to the repository and authorized cloud project. [S22 in SOURCES.md]

## Paste this command

~~~text
/goal Implement ThreadMap from docs/threadmap/THREADMAP_BUILD_SPEC.md, docs/threadmap/NEBIUS_DEPLOYMENT.md and docs/threadmap/IMPLEMENTATION_TASKS.md until BUILD_READY is true: complete every P0 implementation/preparation portion of T01-T16 and obtain genuine passing evidence for A01-A20. Deploy the actual application image to a regular CPU Nebius Serverless Endpoint at its observed HTTPS URL. Prove owner-operated WhatsApp QR pairing, selected incoming/outgoing live messages, real Nemotron Ultra/Nano/Super processing, three-root maps with arbitrary finite content-supported topic depth, a display-only Show depth control, exact source/file navigation through at least six topic levels and directly from any ancestor, combined recursive descendant filters, revision-aware Read/Missed, cross-chat links, and durable external state through reconnect and Endpoint restart. Demonstrate cloud capture with the user's laptop runtime stopped and browser closed. Follow the execution rules below. A local app, deployment recipe, fixture/replay, or Token Factory calls alone cannot satisfy the cloud/live gates. Do not weaken criteria or claim completion while a required gate is blocked.
~~~

## Execution rules

1. Preserve unrelated repository work. Track T01–T16 and dependencies. Continue authorized routine, reversible implementation without repeatedly asking for permission; record substantive implementation decisions.

2. Use the specified TypeScript/Next.js app, Baileys companion, pg-boss worker, and PostgreSQL contracts. Supervise three separate Node processes in one Endpoint image; expose only the web port. Local Compose supports development, not final completion.

3. Keep source/auth/queue/review/configuration state in external Managed PostgreSQL, files in private Object Storage, and secrets in SecretStash. Endpoint disk must not be the only durable copy. Persist encrypted Baileys credentials and Signal keys; enforce one account lease.

4. Implement the deployment runbook, including verified database TLS, cloud egress, immutable image reference, trusted-origin database bootstrap, child supervision, health, replacement, and recovery. Do not trust arbitrary Host headers or invent resource IDs/URLs.

5. Provision only inside the owner's authorized project and configured infrastructure budget. Prepare the resource plan and validation first. Inference caps do not limit cloud charges. Do not add unapproved resources, purchases, or hosted services.

6. Fix shared schemas before parallel connector, UI, and model work; keep migrations under one owner. Use deterministic native-event fixtures for development and rare failure cases, clearly separated from genuine connection evidence.

7. Capture every eligible incoming and owner-sent message in selected chats. Preserve native identity, exact supported content, original time, revision, and available media associations. Deduplicate replay and history without collapsing distinct identical-text messages. Expose uncertain coverage.

8. Keep exactly Knowledge, General Chat, Resources per chat. Knowledge's suggested first-level subtopics are Programming, Music, Art, History; deeper examples include Programming → Hackathons/School work → Solutions/Tips and further meaningful levels. Use the same recursive tree engine under every root. These labels and stages are illustrative, not mandatory empty nodes or fixed levels. Support arbitrary finite content-supported depth without a hard-coded business/UI depth ceiling. A topic may contain child topics and discussions concurrently, with exact messages/files reachable at any depth. Store stable topic/parent IDs, enforce one primary parent in the same chat/root and reject self/ancestor cycles; cross-chat links are separate edges. Preserve user overrides and permit same-root subtree moves/merges at every depth. All claims and links need authorized current evidence. Pending analysis is a separate processing view, not another root.

9. Follow the review/filter contracts exactly across every descendant depth, including collapsed or unloaded branches: new messages and unreviewed edits are Missed; only deliberate actions or selected two-second foreground dwell mark a revision Read. Bulk actions freeze IDs/revisions; ancestor counts deduplicate canonical sources. Opening a parent, a results list, summaries, zooming, or neighboring context does not mark messages read. Use lazy child retrieval, branch focus, breadcrumbs and paginated/virtualized rendering to stay within 200 visible graph nodes without truncating stored depth. Add Show depth values 0/1/2/3, a custom nonnegative safe integer, and All levels with progressive loading. Default first visits to depth 2, using `MAP_DEFAULT_TOPIC_DEPTH=2`, `MAP_MAX_VISIBLE_NODES=200`, and `MAP_CONTENT_PAGE_SIZE=50`. Roots are depth 0; branch focus never renumbers depth. Persist per user/chat, with explicit URL depth override. Return `available_max_topic_depth`, offer current depths dynamically, and treat a larger requested value as all currently available depths without inventing nodes. Keep `max_topic_depth=integer|all` separate from content membership filters: depth-only changes preserve source IDs/counts/bulk scopes and any hidden topic selection chip/ancestors. Boundary nodes show deeper-topic indicators and Show next level. Any root/topic opens paginated matching messages/files from its entire descendant subtree through an independent content endpoint, showing actual source paths and citations without requiring deeper expansion. Expansion/navigation/depth changes use persisted state and make zero inference calls.

10. Keep ThreadMap read state separate from WhatsApp receipts. Provide no WhatsApp send/edit/delete controls. The owner operates QR pairing and sends harmless test messages manually. Do not collect WhatsApp passwords or automate test-message sending.

11. Discover and capability-test exact Nemotron role IDs through Token Factory. Ultra handles recursive taxonomy, Nano routine extraction, Super ambiguity/link verification. Let supported branches stop at different depths; avoid empty padding and redundant subdivisions. Bound work per request/job, save a continuation frontier and resume permitted branch work through the durable queue under the same logical rebuild/job budget ledger; continuation must not reset its caps. Budget/provider limits expose paused or incomplete analysis, never silently flatten deep paths or masquerade as completion. Keep budgeted retries bounded. Fixtures or undisclosed substitute models cannot pass real-inference requirements.

12. Suppress stale evidence immediately after observed edits/revocations/expiry; preserve tombstones against stale replay. Apply authorization to QR, files, jobs, sources, and commands. Public demo guests use isolated synthetic workspaces and cannot pair.

13. Run meaningful integrity, replay, revision, recursive depth/cycle/subtree, review, filter, isolation, and recovery tests, then lint, typecheck, and production image build. Do not finish with placeholders or browser-only persistence. Serverless Jobs, LangSmith, Tavily, embeddings, OCR, and Toloka/Tendem are optional.

14. Prepare reproducible deployment instructions, license/README, judge journey, submission copy, technology feedback, and a 2:45 video script. Publish only to already authorized destinations; distinguish prepared assets from actual publication.

## Exact completion scenario

Verify the following against persisted state:

- Load three synthetic chats totaling 300 human messages; each has the three fixed roots.
- Persist and reopen an evidence-supported branch with at least six topic levels below Knowledge, such as Programming → Hackathons → Solutions → Authentication → Tokens → Refresh flow, then navigate to its discussion, exact message and available file. Root/discussion/message/file do not count as topic levels; six is a regression case, not a maximum. Include shallower siblings, a topic with both discussions and subtopics, and same-titled nodes under different parents.
- Prove deep lazy expansion, breadcrumbs and search ancestry reveal make zero model calls, preserve the full path, and stay within 200 visible nodes. Move/merge a same-root subtree, reject cycle-creating edits, and preserve overrides, canonical source routes and reviewed revisions through reload/regeneration.
- Set Show depth to 0, 1, 2, 6 and All levels; verify identical matching canonical message sets, counts and frozen bulk scopes when no content filter changes. From Knowledge at depth 0 and Programming at depth 1, open a deeply nested source and file without expanding hidden topics. Confirm parent opening does not mark its descendants Read; preserve true paths, hidden selections, short-branch access, saved preference and explicit URL override. Depth changes make zero model calls and respect the visible-node budget.
- Pair through the hosted owner's UI; select a controlled group and individual chat, leaving another chat unselected.
- Receive incoming and phone-sent messages without refresh; verify unselected content is excluded.
- Process fresh captured content with real Nemotron; drill from map/outline to an exact source and retrieve/open a supported attachment. Separately, A18 must demonstrate an actual Ultra-generated, source-supported topic path beyond two levels using suitable synthetic evidence; a manually seeded deep fixture cannot replace that live recursive-model check.
- Combine Date + Topic + Missed at both shallow and deep topics and obtain the same expected IDs across map, list, search, resources, and counts, including unloaded descendants and deduplicated multiple placements.
- Mark only the focused revision Read; manually restore Missed without immediate auto-reversal. Confirm deep-source review/edit changes update all ancestor aggregates and bulk scopes never include unseen later revisions.
- Follow a supported cross-chat link and inspect evidence on both sides; preserve corrections/dismissals.
- Replay the fixture update containing twenty new messages exactly once; retain distinct repeated-text native messages and earlier review state.
- Observe a controlled edit/revocation; invalidate obsolete claims and prevent stale replay from restoring deleted content.
- Restart companion/worker; test reconnect, relink, pause/resume, disconnect, provider failure, and unauthorized access.
- Have the owner close the browser and turn off the laptop for a controlled test; confirm cloud capture from another device.
- Stop/start the Endpoint and verify sources, recursive graph/memberships, depth preferences, review state, refinement frontier/queue, cached files, and still-valid session survive externally.

## Gates and external prerequisites

T16 preparation is part of BUILD_READY; actual public repository/video publication and completed human review are additional SUBMISSION_READY work.

BUILD_READY requires all A01–A20: A18 real models, A19 actual WhatsApp linking/events, and A20 actual Nebius HTTPS deployment and restart evidence. Local success and deployment preparation cannot replace A20.

No Node.js/Baileys account is needed. The owner supplies WhatsApp pairing, Token Factory access, and separate Nebius AI Cloud project/IAM, funds, quotas, registry access, and infrastructure budget.

If these are missing, complete all independent implementation, tests, and preparation; then report BLOCKED_EXTERNAL with the precise gate and minimal owner action. Do not repeatedly retry unauthenticated requests, fabricate evidence, or silently substitute another host.

SUBMISSION_READY additionally requires completed human review meeting specified targets and actual required publication: judge access, public licensed repository, description/testing instructions, feedback, and public video. Missing cloud deployment blocks BUILD_READY; a missing public video blocks SUBMISSION_READY only. Report actual Devpost submission separately.

## Required final report

Write reports/acceptance.md, reports/live-inference.json, reports/live-connection.json, reports/cloud-deployment.json, reports/evaluation.md, and reports/performance.md. Use PASS, FAIL, BLOCKED_EXTERNAL, UNRUN, and UNREVIEWED accurately; never invent human-review scores.

Return both gate statuses, reproducible commands, actual HTTPS URL/image/model identifiers, A01–A20 evidence, measured limitations, and remaining owner actions. Exclude secrets, pairing QR, private bodies, phone numbers, and raw native account keys from reports.
