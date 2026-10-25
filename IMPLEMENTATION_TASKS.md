# ThreadMap implementation tasks and action plan

Version 2.1 — 25 October 2026 — cloud-hosted linked-device prototype with recursive topic hierarchies.

Read THREADMAP_BUILD_SPEC.md and NEBIUS_DEPLOYMENT.md first. P0 uses a real Baileys linked-device session and an actual Nebius Serverless Endpoint. The specification's A01–A20 gates control completion. These tasks are instructions for future implementation, not work already performed.

## 1. Before implementation

Inspect repository instructions and preserve unrelated work. Copy this handoff into docs/threadmap/, create a tracked T01–T16 checklist and record fixed decisions. Use a branch where appropriate. An existing stack may be adapted if it preserves the stated behavior, selected services and completion gates.

The owner supplies a repository, WhatsApp pairing access, Token Factory credentials, and an authorized Nebius AI Cloud project with a concrete infrastructure budget. No Baileys or Node.js account is required. End users need no Node installation: the runtime is in the hosted container.

Build independent code/tests if an account is unavailable. Do not wait for secrets to implement the UI, adapter interfaces, deterministic event replay, schema validation or deployment manifests. Missing cloud access prevents final hosted completion, not useful development.

## 2. Dependency-ordered tasks

| ID | Task and concrete deliverable | Dependencies | Exit evidence |
| --- | --- | --- | --- |
| T01 | Bootstrap Next.js/TypeScript, recursive source/graph contracts, PostgreSQL migrations, pg-boss, auth integration, test commands, Dockerfile, process supervisor and development Compose. Pin compatible Node/Baileys versions after primary-doc checks. | None | Clean build/start; stable parent IDs and root/chat-scoped acyclic topic trees support arbitrary finite depth; web/companion/worker are separate entrypoints; lockfile, health endpoints and no secrets in source. |
| T02 | Create three synthetic conversations totaling 300 human messages, expected native keys/revisions, files/URLs, history/replay/control events and a twenty-message update. Include a supported six-topic-level Knowledge branch and uneven sibling depths. Add FixtureSourceAdapter and FixtureModelProvider. | T01 | Versioned expected manifests cover deep ancestry, descendants, mixed topic/discussion children, identical titles under different parents and exact source/file endpoints; no native-data/private-account dependencies; distinguish source replay from real connection. |
| T03 | Implement private ownership, isolated synthetic demo guests, owner provisioning, application login, authorized data/media routes, and pairing permission checks. | T01 | Cross-user/demo negative tests; demo cannot pair, inspect a QR, or reach private jobs. |
| T04 | Implement Baileys connection/session service: QR, encrypted PostgreSQL AuthStateStore, credentials plus Signal keys, lease/fencing, bounded reconnect, heartbeat, pause/resume and disconnect/relink. | T01, T03 | Session-store and lifecycle tests; real QR smoke test when owner access exists; no send/seen controls or raw credential logs. |
| T05 | Implement chat discovery/selection, bounded preselection memory, native-event normalization, incoming/outgoing capture, available-history/new-only modes, identity aliases, replay deduplication, source revisions, edits/revocations and ingestion outbox. | T02, T04 | A03/A06/A07/A15; source browsing independent of LLM; unselected sources excluded; deleted events cannot resurrect content. |
| T06 | Implement Nebius model discovery, exact role IDs, schema/capability checks, model router, validation, retries and token/cost reservations. | T01 | Genuine Ultra/Nano/Super smoke results when credentials exist; precise blocker otherwise. |
| T07 | Prove an early vertical slice: authenticated QR → selected incoming/outgoing message → durable source → real Nano classification → visible exact source and category. | T04–T06 | A genuine small end-to-end run before investing in full map polish; fixture mode remains clearly labeled. |
| T08 | Implement full durable pipeline: Nano extraction, recursive Ultra taxonomy, Super escalation/link validation, evidence/revision checks, bounded branch work with persisted continuation, incremental reuse and atomic graph publication. | T05, T06 | A02/A04/A14; evidence-supported paths extend beyond two or three topic levels without flattening; source progress and model budget states; old evidence suppressed immediately after edit/revoke. |
| T09 | Build recursively expandable map and outline, Show depth selector, ancestry breadcrumbs, branch focus and paginated children, direct subtree-content drawer, source/context drawer, media fetch/cache/view, connection/history/analysis status, SSE/refetch and accessible responsive views. | T03, T05; shared graph contract permits parallel work with T08 | A05/A16; any root/topic opens descendant messages/files without drilling; depth 0/1/2/6/All levels preserve membership and reach deep files; at most 200 visible graph nodes without a storage-depth cutoff; expansion/depth changes make zero model calls; updates preserve camera/focus. |
| T10 | Implement revision-aware Read/Missed, two-second foreground focus, manual reversal, frozen recursive bulk scopes and distinct aggregate counts across all descendant depths. | T05, T09 | A08/A09; duplicate placements count once at every ancestor; deep-source reads/edits update ancestors correctly; concurrent edits/new arrivals remain Missed; no deliberate WhatsApp read calls. |
| T11 | Implement common date/topic/status/chat filtering and Unicode-aware search across graph/list/files/counts, using recursive descendants; keep max_topic_depth as an independent display projection; separate context and full-topic summary coverage. | T09, T10 | A10/A16 exact-ID assertions at root, shallow and six-level topics across every surface; depth-only changes preserve source sets/counts/bulk scopes, hidden topic selections and access to collapsed/unloaded descendants. |
| T12 | Implement persistent rename/reparent/subtree-merge corrections at every topic depth, bounded cross-chat candidates, Super evidence verification, related-source view and dismissals. | T08, T09, T11 | A11/A12; reject cycles and cross-root topic moves; corrections and source/review IDs survive reanalysis/reload; unrelated candidates rejected; relation edges never become hierarchy parents. |
| T13 | Finish recovery, deletion/expiry, quota handling, media authorization, prompt-data separation, sanitized telemetry, account lease competition and source-generation fences. | T03–T12 | A13–A17; interrupted workers/connections do not corrupt current sources or republish deleted data. |
| T14 | Package and actually deploy the application on Nebius Serverless Endpoints with external Managed PostgreSQL/Object Storage/SecretStash. Implement trusted-origin bootstrap, image digest recording, health/restart/rollback runbook and isolated hosted demo. | T01, T03; begin provisioning validation early; final workflow after T13 | A20; actual HTTPS URL, Endpoint ID, laptop-independent capture, persisted restart and deployment report. |
| T15 | Run complete deterministic, real WhatsApp, real model and cloud checks; measure performance and conduct/prepare human evaluation; fix concrete failures. | T13, T14 | A01–A20 accurately reported; six required evidence reports; no fixture result counted as live. |
| T16 | Prepare the hackathon packet: licensed repository/README, English description/testing guide, feedback and video script/assets; publish to configured authorized destinations for submission. | T15 | BUILD_READY requires prepared materials; SUBMISSION_READY additionally requires completed human review and actual public repository/video/submission assets. Hosting already passes T14/A20. |

### T01: Runtime and service boundaries

Target a maintained Node LTS release, with Node 24 LTS as the baseline; pin exact tested package versions and review applicable Baileys advisories. Do not select a release solely from an old example or install unpinned master.

For the hosted prototype, one custom Endpoint container supervises three processes: web, companion and analysis worker. Keep their entrypoints/modules separable. The web exposes the only public HTTP port. Database, persistent session state and cached media live outside the Endpoint disk. Development Compose is a convenience, not the submission deployment.

Model every topic with a stable ID, chat/root identity and one primary parent ID, using the same recursive tree contract under all three roots. Do not encode fixed columns or UI components for topic, subtopic and sub-subtopic levels. Validate parent existence, scope and absence of self/ancestor cycles before publishing or applying a move/merge. Keep cross-chat relation edges separate from parent/child edges. A topic may contain child topics and direct discussion memberships together; exact messages and available files remain reachable at any depth.

Provide explicit scripts for setup, migrations, fixtures, typecheck, lint, tests, production image build, deployment validation and evidence generation. Commands named in these instructions are requirements to implement, not commands this package already provides.

### T02: Fixtures and evaluation

Use recognizable synthetic chats such as Builders and Hackathons, Programming Study Group, and Music and Community. Every chat contains real Knowledge, General Chat and Resources examples. Knowledge's suggested first-level subtopics are **Programming, Music, Art, History**. These are examples to populate only when supported by actual messages; the LLM may propose other useful subject areas.

Create a deterministic evidence-supported path with at least **six topic levels below Knowledge**, for example Knowledge → Programming → Hackathons → Solutions → Authentication → Tokens → Refresh flow → discussion → source message → available file. The root, discussion, message and attachment do not count toward those six topic levels. Include a shallower branch such as Knowledge → Programming → School work → Tips, a topic with both child topics and its own discussions, and the same topic title under different parents. Every test hierarchy must be grounded in corresponding synthetic source content, rather than empty padding. Vary branch depth and place a source through multiple branches to verify deduplication. Six levels is a regression example, not a product maximum.

Include at least twelve file references, fifteen URLs, two languages, interleaved discussions, resource-plus-explanation messages, identical text with distinct native IDs, and shared concepts across chats. Add the following event sequences:

- Initial history plus duplicate live/append delivery.
- Twenty new distinct human messages, with incoming and owner-sent examples.
- Authoritative PN/LID alias learning after first observation.
- An edit/revocation before its original event, and stale replay after removal.
- Receipt-only updates, unsupported types, expiry and missing/expired media.
- New-only cutoff and bounded history-buffer overflow.
- Deliberately misleading instructions embedded in ordinary chat content.

Freeze a labeled evaluation split containing sixty root examples, twenty cross-chat candidate pairs and ten finding tasks. Include at least two finding tasks that retrieve deep messages/files while displaying only categories or first-level topics, plus one that deliberately expands deeper. Do not tune on every held-out example or hide failures. Semantic review is performed by a human; deterministic test expectations may be authored by the developer.

### T04–T05: Session, ingestion and deletion

Persist credentials AND Signal key-store changes using a tested encrypted AuthStateStore. The SecretStash encryption key survives redeployments. A disposable multi-file auth spike is insufficient for the release gate. Use database permissions and a single-owner lease; losing the lease closes the socket.

Selection is an app retention/analysis filter, not WhatsApp-scoped authorization. Only the bounded cloud-memory preselection buffer may briefly hold unselected content. No unselected bodies enter permanent source storage, media jobs, model requests or logs.

Process every item in message batches, including fromMe. Deduplicate by account/chat/native identity and authoritative aliases, not text/timestamp. Keep stable IDs across reconnect; preserve original sent time on edits; reject stale control events and use tombstones for removed sources.

Capture sources before inference. Use an outbox/transaction to avoid losing downstream work after a source commit. If persistence is unavailable, close/pause capture and expose a possible gap. Do not keep accepting events while silently dropping them.

Deselect stops future capture/dispatch. Delete first unsubscribes and advances the deletion generation, then purges content. Active external model calls cannot be recalled; their results must fail generation checks. Replaying a deleted chat cannot recreate it without explicit reselection.

### T06–T08: Model behavior

If NEBIUS_API_KEY is absent, finish provider interfaces and fixture tests, mark live checks UNRUN/BLOCKED_EXTERNAL, and continue. Never search unrelated credential stores or expose keys.

Resolve exact IDs from the account catalog, then capability-test Ultra, Nano and Super with the real output schemas. An older or different model renamed as Ultra does not satisfy A18. Display any explicitly configured fallback as degraded mode.

Use Nano for routine extraction/assignments, Ultra for initial/rebuilt taxonomy, and Super for ambiguity/output repair/related-link evidence. Ultra must propose recursive content-supported hierarchies, including deeper topics after Solutions or Tips when meaningful. It must not treat Programming → Hackathons/School work → Solutions/Tips as mandatory stages or stop automatically after two or three levels. Branches end when further subdivision would not help distinguish supported content; avoid empty nodes and redundant single-child chains.

Bound tokens, nodes and work per model request/job; persist the unprocessed branch frontier and resume through the durable queue when permitted by the existing budget. All continuation jobs share the original logical rebuild/job budget ledger, so splitting work cannot reset or bypass its limits. If budget or provider limits pause work, expose incomplete analysis and keep sources accessible. Never silently flatten a valid deep path or claim the whole taxonomy complete because one response was bounded. Incremental calls use the relevant ancestry, immediate children, representative evidence and overrides instead of requiring the entire archive/tree in every prompt. Coalesce incoming work into bounded microbatches; preserve pending source access. Ordinary zoom, expansion, Show depth changes, filters, search and review mutations consume zero inference calls; UI projection and expansion read persisted graph data.

Track concurrent reservations, actual usage and bounded repair/retries. Separate inference budgets from cloud resource charges. A pg-boss analysis job is not a Nebius Serverless Job; do not claim use of the latter unless it actually runs.

### T09–T12: Product behavior

The initial filter is Missed, with an obvious All option. Reading a source marks only its current revision Read after the specified foreground dwell. Explicit Mark Missed disables the observer until deliberate reopen. A currently open source stays visible when filtered results change.

Render the stored tree recursively with lazy child retrieval, branch focus, breadcrumbs and a navigable outline. Keep the visible-node budget at 200 or fewer through collapse, pagination or virtualization; do not turn it into a storage-depth ceiling. Preserve full ancestry and allow search results or saved source routes to reveal deep branches without first expanding every sibling. A node can show both deeper topics and discussions at that same level.

Add **Show depth** as a display-only control: category roots are depth 0 and their first-level topics are depth 1. Support 0, 1, 2, 3, a custom nonnegative safe integer, and All levels with progressive loading. The first-visit default is 2; this is a presentation preference, not a taxonomy cap. Persist this preference per user/chat; an explicit URL depth overrides that preference. Branch focus does not renumber depths. The API accepts `max_topic_depth=integer|all` separately from date/topic/status/chat membership filters and returns `available_max_topic_depth`; offer currently available depths dynamically. A requested value above the current maximum shows all available depths without inventing nodes or changing source membership. Use `MAP_DEFAULT_TOPIC_DEPTH=2`, `MAP_MAX_VISIBLE_NODES=200`, and `MAP_CONTENT_PAGE_SIZE=50` as configuration defaults. Boundary nodes show that deeper topics exist and provide Show next level, which explicitly advances the displayed depth. If a selected topic is deeper than the display boundary, retain its filter chip and visible ancestors; never silently clear its selection.

Clicking **any category root or topic**, including a depth-boundary node, opens paginated matching source messages and files from its entire descendant subtree. Supply a descendant-content endpoint independent of map projection; users must reach a deeply nested message/file directly from Knowledge at depth 0 or Programming at depth 1 without expanding hidden levels. Preserve the actual topic path, canonical source IDs and claim citations in the drawer. Merely opening a parent or listing results does not mark its subtree Read; only selecting and viewing a particular source applies the existing revision-aware dwell rule. Changing only Show depth must leave matching canonical IDs, counts and frozen bulk review scopes unchanged. Shorter branches still expose their available content normally.

Use one server-side definition of filters and deduplicated source IDs over all recursive descendants, including branches not loaded in the browser. Bulk operations freeze IDs plus revisions, so new messages and concurrent edits are not accidentally marked read. Reading a deep source updates every relevant ancestor aggregate while counting a canonical source once. Whole-topic summaries cannot appear to summarize a narrower filtered subset; full-input coverage includes any descendant messages used to create the summary.

Allow topic rename and same-root subtree move/merge at every depth, plus explicit message-placement corrections; preserve those overrides through regeneration. Reject self-parenting, a move beneath a descendant, or any merge that would create an ancestor cycle. Recompute ancestry and affected summaries/counts without changing canonical source/review IDs or stable source routes. Do not use a shared title as topic identity. Cross-chat relationships are P0 and can connect deep topics. Start with aliases, keywords and shared URLs, then use Super to validate evidence. Embeddings can wait.

### T14: Mandatory cloud deployment

Read NEBIUS_DEPLOYMENT.md. Start cloud feasibility early: confirm project permission, common region, CPU preset/quota, registry, secrets, private database and object storage. Do not discover deployment blockers on the final day.

Deploy the real app image to a regular CPU Nebius Serverless Endpoint. Use the returned HTTPS URL, external PostgreSQL with verified TLS and private Object Storage. The persistent Baileys process runs in Nebius, not on the owner's computer. Native desktop packaging is unnecessary.

Configuration changes can require Endpoint recreation and a new URL. Implement authorized database-backed origin bootstrap after the URL is known; do not blindly trust Host headers or embed a changing placeholder in immutable environment values. Restrict bootstrap to an authenticated in-network administration path.

Supervise child processes, but provide health alerting and manual Endpoint recovery because a child supervisor does not restart stopped cloud infrastructure. Record actual resource identity, image digest and costs. Keep the owner-provided resource budget and judging availability period visible.

P0 chooses Endpoints as the mandatory hosting route. Nebius Serverless Jobs are optional P1 for finite backfill/evaluation work; they do not own the persistent WhatsApp socket or run once per arriving message.

## 3. Parallel implementation

After T01 and shared database/event/graph types are fixed, parallelize connector/event work (T04–T05), UI against fixture contracts (T09), and model work (T06–T08). Begin T14 account/network/container feasibility concurrently. One owner controls migrations and shared types.

The first critical demonstration is T07. Once it proves capture and real analysis, finish map detail, review/filter semantics, cross-chat evidence and recovery. Do not spend the first days on a polished canvas without proving the actual WhatsApp and hosted paths.

## 4. Proposed calendar — Singapore time

This assumes work begins on 24 October and focuses on the required hosted prototype.

| Date | Focus | Checkpoint |
| --- | --- | --- |
| 24 Oct evening | Repository, account/budget setup, T01/T02/T06; early T14 feasibility | Build starts; real model access and cloud permissions are verified or specifically blocked. |
| 25 Oct | T03–T07; initial real Endpoint skeleton | Genuine QR → message → source → model classification; hosted network can reach required services. |
| 26 Oct | T08–T09; cloud durable state | Three-root map with deep recursive branches and exact source/media paths; app accessible at real Nebius HTTPS URL. |
| 27 Oct | T10–T12 | Reading, combined filters, corrections and evidence-backed cross-chat navigation. |
| 28 Oct | T13–T15 | Core checks, cloud restart, laptop-independent capture, quality/performance measurement. |
| 29 Oct | T16 | Stable hosted judge journey, licensed public repo, written materials and video draft. |
| 30 Oct | Fix blockers, final recording and submission | Personal target: submit by 8:00 p.m. SGT, five hours before cutoff. |

Official cutoff: **31 October 2026, 1:00 a.m. Singapore time**. Optional Tavily, embeddings, OCR, transcription, Serverless Jobs and richer telemetry do not displace the required live/hosted product.

## 5. Account and tool action plan

| Priority | Owner action | What the coding/deployment runtime needs |
| --- | --- | --- |
| Now | Join Devpost and select Best Apps and Agents. | Event requirements and submission access when publication is due. |
| Now | Enable Token Factory, claim eligible benefits and choose inference caps. | Server-side NEBIUS_API_KEY; model IDs discovered against the real account. |
| Now | Enable Nebius AI Cloud project, region, billing/eligible infrastructure credits, IAM and quotas. | Scoped Cloud CLI/service-account access; project/network IDs and infrastructure budget. |
| Now | Provide repository and image registry destination. | Project-scoped source/image push permission; no broad credential sharing. |
| Early | Configure Managed PostgreSQL, private Object Storage and SecretStash. | Private TLS DB connections, restricted credentials, bucket and persistent app/auth encryption secrets. |
| Early | Prepare harmless WhatsApp test chats and phone access. | Owner scans the hosted QR and manually sends controlled test messages; no export files or password. |
| Optional | Create LangSmith or Tavily access. | Keys only for separately enabled features; private content tracing disabled. |
| Later | Arrange Toloka/Tendem human review if needed. | Separate synthetic/consented evaluation task and explicit budget. |
| Before submission | Make repository/video/public demo materials available. | Actual URLs and testing instructions, without exposing real chat data. |

Node.js, Baileys and public package installation need no service account. The end user will not install them; the build includes them in the cloud image. The cloud deployment identity, Token Factory key, Object Storage credentials and app credentials have different purposes.

Verify event/Builder benefits in SOURCES.md. Do not treat an inference-credit offer as proof that persistent Endpoint/database/storage costs are covered. Store credentials in the coding runtime or SecretStash, not this document or assistant chat.

## 6. Verification and final evidence

Use tests for actual risks: event order/identity, selection, revision/tombstone rules, auth persistence, recursive hierarchy integrity, filters/review, permissions, media lifecycle, model evidence validation and interrupted work. The deep fixture must prove six topic levels survive storage/reload, lazy navigation, subtree edits and regeneration; same-title nodes remain distinct; cycles are rejected; mixed children remain reachable; descendant filters/bulk review/counts include unloaded branches and deduplicate placements. Verify a reviewed deep source becomes Missed after an edit and updates ancestor counts, and that neither expansion nor depth changes trigger inference. Test display depths 0, 1, 2, 6 and All levels against identical canonical matching sets, counts and bulk scopes; open a deep source/file directly at depths 0 and 1; verify parent opening does not mass-mark Read; test short branches, hidden selected topics, persisted/URL-overridden depth and bounded progressive loading. Run meaningful integration/end-to-end tests, not implementation-mirroring tests for every helper.

The six required reports are:

- reports/acceptance.md — A01–A20 status, commands, expected/observed outcomes and evidence.
- reports/live-inference.json — genuine Ultra/Nano/Super execution metadata.
- reports/live-connection.json — actual hosted QR/live/reconnect outcomes, with no raw account secrets or private content.
- reports/cloud-deployment.json — actual Endpoint/HTTPS/image/region and persistence/network/restart checks.
- reports/evaluation.md — human review counts or explicit UNREVIEWED status.
- reports/performance.md — measured UI/queue/model latency, cloud configuration and costs.

A18 needs real model calls, including an actual Ultra-generated source-supported topic path beyond two levels using suitable synthetic evidence; the six-level deterministic fixture alone cannot pass that check. A19 needs actual WhatsApp pairing/messages. A20 needs actual cloud execution, including persistent recursive maps, view preferences and refinement checkpoints after restart. All three must pass BUILD_READY. Local tests can support these gates, but cannot replace their external evidence.

A missing hosted URL blocks BUILD_READY. A missing public YouTube URL can leave an achieved BUILD_READY intact while SUBMISSION_READY remains blocked. Never write PASS for an unrun check or fabricate human quality ratings.

## 7. Proposed 2:45 demonstration

| Time | Show |
| --- | --- |
| 0:00–0:15 | Problem: a useful idea/resource disappears inside a busy conversation. |
| 0:15–0:35 | Hosted ThreadMap URL, connected test chat and a new manually sent WhatsApp message appearing without refresh. Never expose an active QR. |
| 0:35–1:05 | Nemotron analysis places it under a fixed root; expand Knowledge → Programming → Hackathons → Solutions and deeper supported topics, then the exact source/file. |
| 1:05–1:30 | Set Show depth to 1; open Programming to find a deeper message/file directly. Apply Date + Topic + Missed and show consistent Read state. |
| 1:30–1:55 | Follow a related idea into another chat and inspect evidence on both sides. |
| 1:55–2:20 | Show hosted persistence/reconnect and another incoming message; identify synthetic replay segments when used. |
| 2:20–2:45 | Brief actual Nebius Endpoint/Token Factory model-role evidence and the use case. |

Use genuine recorded runs and harmless test material. Cached analysis or event replay is explicitly labeled; it is not presented as a fresh live call. Never publish credentials, active pairing QR, private chat content or unlicensed assets.

## 8. Submission packet and stopping condition

Prepare the working demo/test-build URL, public repository with visible open-source license and reproducible README, English description/testing instructions, technology feedback and public YouTube video under three minutes. Describe the actual linked-device integration and its experimental status; do not imply Meta or organizer approval.

The required hosted app and real gates complete BUILD_READY. Completed human review and actually published required submission artifacts complete SUBMISSION_READY. The owner performs any still-unavailable account/publication steps; the agent prepares all independent work and states the exact blocker. Maintain free judge access for the required period through 16 December 2026, 4:00 a.m. Singapore time. See S1–S4.
