# ThreadMap product proposal and build specification

Version 2.2 — 25 October 2026 — message-count node sizing, recursive topics and selectable display depth for the cloud-hosted linked-device prototype

This revision supersedes the export-based version. The owner approved ThreadMap web interface + a Node.js companion using Baileys + PostgreSQL and the Nemotron processing pipeline, with the app hosted on Nebius Serverless Endpoints. This document specifies work to implement; it does not claim a working connection or completed tests.

The owner's v2.1 change replaces the previous two-topic-level limit with a recursive hierarchy. Knowledge starts with content-supported subjects such as Programming, Music, Art, and History, then can branch through Hackathons or School work, Solutions or Tips, and further meaningful levels. A Show depth control determines how many topic levels are visible. Every category or topic also opens the matching messages and files throughout its subtree, so reaching content never requires expanding to the deepest level.

The owner's v2.2 change makes mindmap node size reflect message volume. Count distinct eligible messages matching the current content filters in each node's complete subtree, including hidden descendants. Use one bounded compressed-area scale, show the exact count, and keep the same logical size when only display depth, expansion or pagination changes.

## 1. Product proposal

ThreadMap turns busy WhatsApp conversations into navigable knowledge maps. Every selected individual or group chat has three permanent entry points: **Knowledge**, **General Chat**, and **Resources**. Nemotron identifies meaningful subjects and progressively narrower subtopics beneath them. Larger nodes indicate more matching messages, with exact numeric labels. Users choose a visible depth, expand branches when useful, or open any ancestor's content directly to reach exact captured messages and available attachments. New messages arrive automatically through a WhatsApp linked-device session; no transcript export or upload is required.

The product addresses two concrete tasks: finding something buried in one busy chat, and recognizing how ideas or resources in different chats relate. Its distinguishing behavior is evidence-preserving navigation: an overview always leads back to the messages that support it. Reading progress helps users return to material they have not reviewed.

Initial audience: people in active programming, research, hackathon, study, and professional community groups. A useful first demonstration is finding a Python resource shared in a hackathon chat, following its discussion, and discovering a related explanation in a study chat.

### Terminology

| Term | Meaning |
| --- | --- |
| Chat / conversation | One selected WhatsApp individual or group conversation. |
| Topic | A reusable subject inferred from messages, such as Python or hackathon preparation. |
| Topic depth | The number of parent-topic edges below a category root: root 0, first-level topic 1, its child 2, and so on. Discussion/message/file details do not add topic-depth levels. |
| Subtree content | Distinct eligible messages assigned to a category/topic itself or anywhere under its descendants, plus those messages' associated resources/files. |
| Show depth | A view preference controlling the deepest topic level displayed; it does not exclude deeper source content from a selected subtree. |
| Node size count | The distinct eligible canonical messages matching active content filters in a node's scope; category/topic scopes include their direct and all descendant memberships. |
| Discussion | An inferred grouping of related messages within one chat; its members need not be adjacent. |
| Source message | One canonical captured message, with exact received text, native identity, sender, timestamp, and content revision. |
| Resource | A URL or attachment shared in a message. |
| Review status | A user's Read or Missed state within ThreadMap. |

Inferred discussions are not presented as native WhatsApp reply threads. The source timeline is authoritative about message order.


## 2. Scope and external constraints

### Prototype scope

Build a responsive web application with a desktop mindmap and a usable mobile outline/detail view. Host the web server, long-running Node.js Baileys companion, and AI worker on a regular CPU Nebius Serverless Endpoint; keep PostgreSQL and files in external Nebius managed services. One private workspace may link one WhatsApp account and select multiple conversations. A native mobile application is a later project. No user-computer companion, localhost service, or browser-to-desktop bridge is required in the delivered app.

The chosen track is **Best Apps and Agents**. The event requires qualifying NVIDIA-model usage; the owner additionally requires Nebius cloud hosting. The chosen P0 route is **Nebius Serverless Endpoints**. Actual Endpoint deployment is mandatory for this project even though the event encourages rather than requires that specific deployment service. The hosted app provides isolated synthetic judge workspaces with pairing disabled; a separate demo deployment is optional. [S1–S3, S34–S36]

### WhatsApp integration contract

The required connector is **WhatsAppLiveAdapter**, implemented with Baileys in a separate persistent Node.js process. The owner starts Connect WhatsApp in ThreadMap and scans its QR with WhatsApp → Linked Devices. Baileys communicates through the WhatsApp Web protocol and is an unofficial library, not a Meta-approved consumer API. Compatibility and account restrictions remain possible. Describe this honestly as an experimental linked-device prototype. [S5, S23, S30]

Node.js and Baileys require installation, not service accounts or API keys. Pairing uses an existing WhatsApp account. This path does not require Meta developer onboarding or a WhatsApp Business Platform token. [S5, S23, S30, S32]

“No download” means no manual transcript export/upload. The companion necessarily receives data; ThreadMap retains selected source records in its cloud database, and sends selected analysis content to Nebius. The linked session has broader capabilities than the app exposes. Chat selection controls application retention and analysis; it is not a WhatsApp-enforced permission scope.

Closing the browser or turning off the owner’s computer does not stop the hosted companion. Endpoint stoppage, infrastructure failure, credential revocation, or cloud network loss can pause receipt; expose resulting coverage uncertainty. This is a persistent hosted prototype, not an uptime guarantee. See Section 10 and NEBIUS_DEPLOYMENT.md for lifecycle and persistence. [S34, S37, S43]

P0 does not send messages, edit/delete WhatsApp messages, change group membership, or deliberately send WhatsApp read receipts. Ordinary protocol/authentication acknowledgements may still occur. A native message key is useful for deduplication; the guaranteed navigation endpoint remains the captured message inside ThreadMap. Do not manufacture an arbitrary historical-message deep link into native WhatsApp. [S7, S25, S28]

### Required and deferred work

**P0, required:** owner QR pairing; selected-chat capture; incoming and owner-sent messages; durable sessions; bounded reconnect; best-effort available history; exact source/revision preservation; three-root per-chat maps; recursively nested LLM-created topics; message-count node sizing with exact labels; a Show depth view control; direct messages/files access from any ancestor; on-demand media retrieval; date/topic/status filters; persistent Read/Missed; replay deduplication; edit/revocation handling; evidence-backed cross-chat links; keyword search; taxonomy corrections; real Nebius integration; recoverable jobs; user isolation; synthetic demo; reproducible Nebius cloud deployment.

**P1, after P0:** semantic retrieval, cited catch-up summaries, Tavily public-link enrichment, richer evaluation views, more message-type support, optional automatic media caching, and finite large-backfill/evaluation runs on Nebius Serverless Jobs.

**Later:** official Business API connector, other messaging platforms, export importer, native apps, cloud-to-local companion bridge, OCR/transcription/file-content understanding, shared team workspaces, automatic human review, arbitrary cross-chat causal/contradiction reasoning. Business coexistence is a different access model; it is not the selected integration. [S6]


## 3. User journey and interface

1. Open the deployed HTTPS URL and sign in to the private workspace. Isolated public demo sessions use labeled synthetic events with pairing disabled.
2. Choose Connect WhatsApp. Read a brief explanation of cloud capture, selected-content processing through Nebius, and experimental connector status.
3. Scan the fresh owner-only QR from WhatsApp Linked Devices. Display pairing, restart, connection, and relink states without exposing credentials.
4. Select individual/group chats from the discovered chat list. Choose Available history + new messages (default) or New messages from now for each.
5. Capture selected sources immediately and show Analysis pending while the model works. Display connection, history coverage, and AI backlog separately.
6. Open a chat's map or outline/tree. Use node size and its exact count to spot message-heavy branches. Choose Show depth, expand a branch, or click any of Knowledge, General Chat, Resources, or their topics to view all matching content beneath it.
7. Select an exact message from that paginated content view; inspect its sender, source time, full topic path, context, and available attachment. No deepest-leaf navigation is required.
8. Combine date, topic, and review-status filters, or search. Adjust display depth independently. Follow Related in other chats and inspect both sources.
9. See subsequent messages and map updates without a page refresh. Pause/resume capture, deselect a chat, or disconnect through explicit controls.

### Layout

- **Left panel:** conversation list, Connect/manage connection, selected chat controls, overall distinct message/missed counts, and last event time.
- **Top bar:** current chat, search, date range, topic selector, All / Missed / Read, Show depth, map/outline toggle.
- **Status strip:** connection state, observed history range, uncertain gaps, pending-analysis count, and last successful analysis.
- **Center:** expandable map with message-count-sized nodes, an exact count badge and size legend, pan, zoom, fit-to-view, ancestor breadcrumbs, focused-branch navigation, and readable labels. Outline/tree offers the same counts, depth and content controls with constant-height rows.
- **Right drawer:** selected node's grounded summary where valid, paginated Messages and Files from the whole filtered subtree, selected exact source, and separately labeled neighboring context. Every item retains its actual topic path and source provenance.
- **Across chats view:** selected authorized chat scope and compact concept map; a relationship opens both sides.

At a wide zoom level, display category/topic labels. At a close level, reveal available discussions and source counts. Do not mount every message as a graph node. Camera zoom, branch expansion, and Show depth are distinct controls; changing camera zoom must not silently change the depth preference. Expansion, node-content access, and depth selection must also work through click and keyboard.

### Show depth and content access

Count category roots as depth 0 and their first topic children as depth 1. Offer 0 (categories only), 1, 2, 3, a custom nonnegative safe integer, and All levels. Show the deepest currently available topic depth. First use defaults to 2; this is a display preference, not a taxonomy-generation limit. Persist the preference per user and chat. An explicit URL value overrides the saved value for that navigation; a user's subsequent control change updates the saved preference. A requested value greater than the available depth simply shows all currently available levels without creating topics.

Show depth is an upper bound on displayed topic depth, not a demand to expand every branch. Keep explicit expand/collapse state within that bound. On first use, show the first two levels progressively within the visible-node budget. A node at the chosen boundary shows a deeper-topics indicator, its matching descendant counts, View messages/files, and Show next level. Show next level explicitly increases the bound enough to reveal that node's children. When a branch is shorter than the chosen depth, its content remains available at its existing endpoint.

Clicking a category or topic label opens its content; a separate expand control opens children. Content is the union of direct and recursively descendant message memberships after the active date/topic/status/chat filters, deduplicated by canonical message ID. Files are associated with those matching messages; a content-filtered file list must not independently reintroduce excluded messages. Show the matching count and paginate messages/files instead of loading an entire branch. Opening this overview does not select every source or mark the branch Read.

For example, with Show depth = 1, Knowledge → Programming is visible. Clicking Programming can immediately display a message/file from Programming → Hackathons → Solutions → Authentication → Tokens → Refresh flow. Its full ancestry appears in the drawer even though those deeper topics remain hidden on the map. Users may reveal that path deliberately, but it is not a prerequisite for opening the source.

All levels permits navigation through the entire stored hierarchy with lazy loading, child pagination, focused branches, and a virtualized outline. Enforce at most 200 visible graph nodes at one time, including structural/discussion nodes; source rows remain in the paginated drawer. Do not truncate the stored hierarchy or force topics into shallower parents to satisfy the rendering budget. Preserve the selected source and root-based depth definition when focusing a branch; compact breadcrumbs can replace out-of-focus ancestors without renumbering their depths.

New uncategorized messages appear in a Pending analysis source list, with their Missed state. This is a processing view, not a fourth root. Chat totals include eligible pending messages; root totals include assigned messages, and the UI explains the difference. A failed model never hides an already captured source.

Preserve the selected source drawer when a Read update removes its message from the active Missed filter. Live additions and map versions must not reset the camera, steal focus, or close the source.

### Node size reflects matching message count

For each category or topic v, define N(v) as the size of the set of eligible canonical human message IDs assigned directly to v or anywhere in its recursive descendant subtree, intersected with the active date/topic/status/chat filters and authorized workspace scope. A discussion node uses its distinct matching member messages. Include incoming and owner-sent messages under the existing eligibility rules. The count must agree with that node's complete matching Messages list, even when its children or later content pages have not been loaded.

Count each canonical message once per node. A message placed in two descendant topics still contributes one to their common ancestor. Parent and sibling counts therefore cannot be obtained by blindly summing displayed child counts. A supported file-only human message contributes one message; multiple files, words, reply references, revisions or child topics do not add units. System/protocol records, unsupported markers, tombstones, expired/revoked content and unassigned analysis-pending sources do not enlarge assigned nodes. Pending sources remain visible in the existing Pending analysis view and may enter node counts once valid placements are published. Across-chat concept nodes, if aggregating several topics, use the authorized union of their matching source IDs without double-counting shared placements.

Node size follows the currently matching message count. With All selected, it reflects all eligible messages matching the other content filters; with Missed selected, it reflects matching missed messages; with Read selected, matching read messages. Show the exact label, such as 120 matching messages and 18 missed when those are the filtered counts. Use a legend: Size represents matching messages on a compressed scale. Size must not imply importance, confidence, file size, or a linear ratio between counts.

**Deterministic P0 scale:** render the count-encoding body as a circle. In graph-coordinate pixels at camera zoom 1, compute:

~~~text
t = clamp(ln(1 + N) / ln(1 + C), 0, 1)
D(N) = sqrt(D_min^2 + (D_max^2 - D_min^2) * t)

D_min = MAP_NODE_MIN_DIAMETER_PX = 64
D_max = MAP_NODE_MAX_DIAMETER_PX = 220
C     = MAP_NODE_SIZE_REFERENCE_COUNT = 10000
~~~

This encodes a logarithmically compressed count in circle area between readable bounds. Use the same scale/configuration for categories, topics and discussions in every chat and depth; never normalize against the currently visible nodes, a branch maximum, a category maximum, or the selected filter's largest count. Equal counts produce equal logical diameters. Computed diameter increases for increasing integer counts below C; counts at or above C share the maximum and keep their full exact numeric labels. Pixel rounding may make nearby counts look equal. The reference count is a visual saturation threshold, not a capture, storage, analysis or hierarchy limit. Validate finite positive bounds with D_max > D_min, positive safe-integer C, and nonnegative safe-integer counts; reject malformed values instead of producing NaN or fabricated sizes.

Keep all three roots visible even at zero: minimum-sized outlined bodies with 0 messages and no Read/Missed badge. Other zero-match topics may be omitted by the existing filtered projection or retained for selected ancestry; if retained, use the same zero style. A count still loading or unavailable is not zero: show a neutral loading/unavailable state without an exact count claim or quantitative size encoding. Never carry counts from one filter/workspace into another as if current.

Changing only Show depth, expansion, focused branch or graph/content pagination leaves N and unzoomed D unchanged. Camera zoom uniformly magnifies the map without changing the logical size/count. Selection/focus uses an outline or halo, not a larger count-encoding body. Keep fonts readable and independent of count, with bounded labels/badges beside or within the circle and a full title/count available on hover and keyboard focus. Long titles must not enlarge the encoded circle. The accessible outline keeps constant row heights and exact numeric counts; it may show a small bounded size marker but must not encode volume through row height.

Recompute counts when valid placements, content eligibility, review state or filters change. Reading a source in All updates the missed badge without shrinking the body if matching membership stays the same; in Missed it can shrink or remove a node. New classified sources can enlarge affected ancestors; replay cannot. Revocation, expiry, deletion and subtree correction update affected sets. Attachment downloads/cache changes do not change N. Apply latest counts, badge values and diameters together using the matching filter fingerprint and count version; discard stale responses after a later filter/read/source update. Sizing and count queries use deterministic code and persisted data, with zero model calls.

Layout must reserve each actual circle's dimensions plus its external label/badge bounds and spacing. Coalesce live updates and adjust local positions to avoid overlap without a continuous unstable physics simulation or automatic fit-to-screen. Preserve the selected node's anchor where possible, camera, keyboard focus and source drawer when nodes grow, shrink or disappear from the current filter; honor reduced-motion preferences. The 200-visible-node budget still applies and must not flatten stored depth or omit hidden-descendant counts.

### Example hierarchy

| Root | Possible subtopics | Possible deeper levels |
| --- | --- | --- |
| Knowledge | Programming, Music, Art, History | Programming → Hackathons → Solutions → Authentication → Tokens → Refresh flow → discussion → source message → available file; Programming → School work → Tips → Algorithms → discussion → messages |
| General Chat | Announcements, Coordination, Introductions, Casual chat | Event planning → venue discussion → messages |
| Resources | Books, Web links, Code repositories, Documents, Media | Programming books → shared PDF → source message and file |

These are examples, not a required populated taxonomy or mandatory sequence of levels. The three roots always exist, including an empty state. Programming, Music, Art, and History are suggested first-level Knowledge subjects, with other relevant subjects allowed. Hackathons, School work, Solutions, and Tips may occur where the messages support them. Branches can end at different depths, and a topic may contain discussions/messages while also containing narrower topics. Do not manufacture empty or repetitive levels just to make a deep tree.

## 4. Taxonomy and graph behavior

### Classification rubric

- **Knowledge:** explanations, reusable advice, technical reasoning, lessons, or substantive subject discussion.
- **General Chat:** coordination, greetings, scheduling, social updates, and context with little reusable subject content.
- **Resources:** an item to retrieve or reuse, including books, links, repositories, files, and media references.

A hackathon explanation can be Knowledge; arranging who attends can be General Chat; sharing its rules URL can be Resources. A message explaining Python and linking a PDF may be shown through both Knowledge and Resources.

Each successfully analyzed human message receives one primary root and may have additional topic/resource placements. Placements reference one canonical message ID. They never duplicate the message or its review state. Retain system events in the source timeline, with a system-event label; they do not count toward missed messages.

### Recursive hierarchy constraints

- Exactly three category roots per chat, with internal enum values KNOWLEDGE, GENERAL_CHAT, RESOURCES and the specified display labels.
- Use one recursive topic representation under all three roots. Support arbitrary finite, content-supported topic depth with no hard-coded two/three-level business rule, database-column ladder, prompt depth ceiling, or UI depth cutoff. A branch stops when the available content no longer supports a useful subdivision. Per-request resource bounds limit work, not representable hierarchy depth.
- Every non-root topic has one primary parent, in the same chat and category root. Store parent IDs and use recursive traversal or a maintained ancestry index; do not implement separate subtopic/sub-subtopic tables or fixed-length path fields. The application derives depth from ancestry. A topic may have child topics and direct discussions/source placements concurrently. Messages/files can be reached from any ancestor's content view.
- Stable application-generated IDs; no graph ID generated from a mutable title or array position. Identical titles under different parents are valid distinct topics. Use full ancestor paths and IDs to disambiguate them.
- No cycles, self-parenting, orphan non-root nodes, cross-chat/root containment, empty AI-created topics, or nonexistent source IDs. A topic with descendant evidence is not empty just because it has no direct messages. Validate the proposed graph before atomic publication; cross-chat relationship edges never become containment parents.
- Initially aim for 3–8 meaningful children per populated parent when the evidence supports them. This is a readability guideline, not a quota or breadth cap. Avoid synonym-only chains and single-child repetition that add no useful distinction; preserve justified narrow branches.
- Retain low-confidence material in a clearly labeled Needs review subtopic beneath its provisional root. Preserve the source even when AI processing fails.
- Top-level roots are fixed. Users can rename topics and move/merge whole subtrees within the same root at any depth. Reject moving a topic beneath itself or a descendant, and validate merge-induced containment before committing. Move/reparent descendants together; recompute ancestry and aggregate memberships transactionally. Never silently merge different child topics merely because their titles match. Cross-root correction applies to explicitly selected message placements; whole-topic moves across roots are deferred.
- User corrections are persistent overrides. Regeneration respects locked titles, parent relationships, and memberships, records a new taxonomy version, and leaves source and review IDs unchanged. Merges retain a surviving stable ID and resolve retired IDs through an explicit mapping for saved links/preferences; never silently discard filters pointing at an affected topic.
- Every category/topic aggregates distinct eligible messages across its own memberships and all descendants, irrespective of displayed depth, collapsed state, page size, or duplicate placements. Summary evidence, topic filters, review counts, bulk scope, resources, and deletion invalidation must use that same recursive membership contract.

Hierarchy creation itself is P0. It is not sufficient to store a manually seeded deep tree while prompting Nemotron to produce only two levels. Taxonomy generation proposes useful recursive subdivisions in bounded pieces, persists any unfinished refinement frontier, and visibly distinguishes pending/budget-paused refinement from completed analysis. User expansion only reads validated stored state; it does not run a model to invent the next visible level.

### Cross-chat relationships

P0 must connect at least two selected chats. Use shared resource URLs, canonical concept aliases, topic keywords, and named entities to propose bounded candidate pairs; ask Super to validate topical relationships using the provided evidence. Embeddings and pgvector are an optional later candidate generator.

Store the two chat/topic endpoints, relation type, a brief reason, source message IDs on both sides, generation version, and user-dismissed status. P0 relation types are RELATED_TOPIC and SHARED_RESOURCE. Similarity alone never becomes a causal, agreement, or contradiction claim.

Offer at most five related items per selected topic initially, including topics at any stored depth. Users can inspect why a link exists and dismiss it. Preserve each source's original chat identity. A link to a hidden deep topic can open its evidence directly and show its ancestry without automatically changing Show depth. Scope candidates, prompts, caches, and queries to the current authorized workspace and selected chat IDs.


## 5. Exact message and resource provenance

Every discussion and factual summary bullet references stored source message IDs and the analyzed content revisions. Each topic records representative evidence and complete membership. Reject invented references and cross-workspace references before publication.

The source drawer shows the exact supported body/caption last received, sender identity/display label, original source timestamp, display timezone, chat name, received time, and edited status where relevant. Store the native message key, available reply reference, source event type, and normalized revision digest privately. Nearby context follows source timestamps and a stable tie-breaker, not network arrival order. If exact ordering between equal timestamps is unknown, do not claim otherwise.

An internal route such as /chats/{chatId}/messages/{messageId} opens the same canonical message after reconnect, restart, or taxonomy changes, subject to authorization. ThreadMap IDs are separate from native keys. Keep the original sent_at when an edit event supplies a newer edit timestamp.

Source fidelity means fidelity to captured supported content; capture may miss earlier revisions or unavailable history. Unsupported types get an explicit content-free marker instead of a guessed transcript. System/protocol-only records, unsupported markers, and revoked/expired tombstones do not count as reviewable human messages.

### Attachments

- Capture available metadata with the source: media type, caption, filename when supplied, size when known, and the native message association.
- Use Available to fetch, Fetching, Cached, Unavailable/expired, Unsupported, and Failed states. A media reference is not proof the bytes remain retrievable.
- Retrieve supported non-view-once media through the companion only after an authorized user request. Stream with size limits; store successful results in a private cache with detected MIME, byte count, and content hash. Baileys provides media download and re-request mechanisms, but neither establishes indefinite availability. [S27]
- Support image/plain-text previews, safe PDF viewing/download, and ordinary download for other supported files. Do not imply OCR, transcription, or file-content comprehension.
- Derive storage paths from application IDs; never use an untrusted filename as a path. Keep media decryption keys/native download fields out of browser responses, logs, and models.
- A book mention without a link or attachment is a text mention. Deduplicate cached bytes only within a workspace while preserving source relationships.
- Cache filling or eviction does not change message identity or review state. A cache miss can require a running companion and may fail if WhatsApp no longer serves the file.
- P0 does not fetch, index, or analyze view-once content. Honor known disappearing-message expiry in indexed content. If supported parsing cannot determine safe expiry semantics, retain only an unsupported marker for that message type.

### Edits, revocations, and expiry

An observed text/caption edit changes the current content revision, keeps the canonical ID and original sent time, and invalidates dependent summaries, source placements needing reanalysis, search snippets, and links. Preserve user overrides as instructions, but require their evidence to remain valid. Mark the changed revision Missed through the revision-aware rule in Section 6. Receipt-only or display-name updates do not count as content edits.

Handle both explicit delete events and revocation/edit updates in the selected Baileys version. Upstream revocations can appear through messages.update; listening only for messages.delete is insufficient. Verify event shapes against the pinned package, rather than assuming documentation for another branch applies. [S25, S33]

On observed revocation, deletion, or known expiry, remove body/caption, media retrieval material and unreferenced cached bytes, search content, and affected visible summaries/links. Keep a minimal key/revision tombstone for idempotency so stale history cannot restore removed content. Do not expose superseded text through old graph versions or debug payloads. An out-of-order edit/revoke can create a pending control record before its base message arrives.

A background expiry task and read-time checks prevent expired content being served after downtime. Missing events remain an acknowledged coverage limitation; the app cannot remove an unobserved change it does not know about.

## 6. Read and Missed contract

Review status is local to ThreadMap and per user. It is not synchronized with WhatsApp read receipts.

The authoritative review record is (user_id, message_id, status, reviewed_revision, read_at, updated_at). Effective Read requires status=Read and reviewed_revision=current_content_revision. Missing records, explicit Missed, and changed unreviewed revisions mean Missed. Every new eligible human message starts Missed, including outgoing messages and messages already seen in WhatsApp. An observed content edit becomes Missed for the new revision; receipt metadata changes do not.

| Action | Required effect |
| --- | --- |
| Open chat, summary, category/topic content list, or its Files tab | No message status changes; do not auto-select a source when opening the list. |
| Pan, zoom, expand/collapse, focus a branch, or change Show depth | No message status changes. |
| Focus a loaded source message for two continuous seconds in the foreground | Mark only that selected message Read. |
| View neighboring context without selecting it | No automatic status change. |
| Open/download a file directly | Does not by itself mark the source message Read. |
| Mark Read / Mark Missed | Immediately set the selected canonical message's status. |
| Mark these N messages Read / Missed | Update a frozen set of distinct, authorized (message ID, current revision) pairs in scope. |
| Receive genuinely new messages | New messages Missed; unrelated earlier states preserved. |
| Observe a substantive edit | New content revision Missed; old Read applies only to the prior revision. |
| Rebuild taxonomy | Review states unchanged. |

The dwell timer pauses/resets when the browser tab is hidden, the drawer closes, a different message is selected, or the selected content revision changes. Read mutations carry the observed revision; a stale request cannot mark a newer revision Read. After an explicit Mark Missed in the active drawer, suppress auto-read until that message is deliberately reopened. Auto-read is an interface heuristic; offer a setting to disable it.

For any nonempty chat/topic/discussion scope S, Read means all distinct eligible human messages in S are Read; Missed means at least one is Missed. A category/topic scope includes its direct and all recursive descendant memberships, even when deeper topics are collapsed or hidden by Show depth. Show the actual count, for example 4 missed / 18 messages. An empty scope has no Read or Missed badge.

The initial status filter is Missed, with an obvious All option. When no missed messages remain, show All caught up and View all messages.

Bulk actions display the count and scope before execution. New messages arriving after the selection snapshot remain Missed. A concurrent edit is not marked Read by a bulk request for an older revision; return a changed-revision count. Chat-list counts are overall counts. Filtered map counts are explicitly matching-message counts, not the number of visible nodes. A bulk action on a category/topic includes the complete matching subtree, not only rendered descendants or the current content page. Changing only Show depth cannot change that frozen scope.

## 7. Filtering and search contract

### Content filters

Date, topic, status, and current chat selection combine by intersection. Multiple topics selected within the topic control combine by union. Include the selected topic's own memberships and all descendants recursively, at every stored depth. All matches are deduplicated by canonical message ID. Topic pickers/search display ancestor breadcrumbs so identically named topics under different parents remain distinguishable.

Date uses the native original sent timestamp, not receipt time, edit time, or analysis time. Preserve its supplied numeric value/precision and normalized UTC time. The chosen display timezone defaults to Asia/Singapore and is user-adjustable; it is not claimed to be the sender’s timezone. A calendar-day range is start-inclusive and next-day-exclusive in that display timezone. Unknown timestamps are explicit and excluded from dated ranges unless the user includes undated messages.

Apply the same matching IDs to the map, ancestor-content source list, search results, resource cards, bulk actions, and counts. Retain ancestor paths to matching nodes within the chosen display-depth bound and expose full paths in breadcrumbs/detail views. Keep the three category roots visible with empty states when necessary. Files are derived from the same matching source messages and retain their exact source links.

### Display-depth filter

The UI may present Show depth alongside filters, but implement it as a separate graph projection parameter, max_topic_depth = a nonnegative safe integer or all. Category roots have absolute depth 0 in both map and tree/outline. Default to MAP_DEFAULT_TOPIC_DEPTH=2; allow later values deeper than the currently available hierarchy. Return available_max_topic_depth from the stored graph version. Focusing a branch does not renumber depths. Keep the depth preference per user/chat, with explicit URL override as specified in Section 3.

Compute eligible message IDs from content filters first. Then choose which topic nodes to render under the depth/expansion/page constraints. For a fixed selected node, depth 0, 1, 2, 6, and All levels must yield exactly the same matching source IDs, file associations, total/missed counts, unzoomed count-encoding diameter, and bulk-review candidate set. The labels and visible branches can change; the selected node's content membership cannot. This control does not mean Messages assigned exactly at depth N or Exclude messages below N.

A selected topic hidden by the depth bound remains an active filter, shown as a chip with its full path. Keep its visible ancestor chain up to the bound and an indicator that matching content continues deeper. Offer Reveal selected path to explicitly increase the depth bound and load the required ancestors. Never clear the filter, change its scope to an ancestor, or increase depth silently. A direct message URL, search result, or cross-chat link can open exact content regardless of the current display depth.

Collapsed, hidden, or not-yet-loaded descendants remain included in node-content queries and counts. Opening an ancestor always offers Messages and Files, with pagination independent of graph pages. A depth change preserves the selected node/content drawer, active filters, and review state, even if that node becomes invisible. Display changes query cached/database state and cause zero inference calls or implicit taxonomy rebuilds.

Context messages outside a filter may appear in the source drawer, clearly marked Context outside current filter. They do not enter counts or bulk selections.

A cached summary over all dates must not masquerade as a summary of a filtered subset. Whenever content filters narrow the summary's complete input/membership set, hide its prose from the filtered preview and offer View full-topic summary labeled with its coverage. Comparing only representative citation IDs is insufficient. Store the full input-ID set or its verifiable membership version/digest, including all descendant inputs actually summarized. Changing only display depth does not narrow that set and must not invalidate an otherwise valid summary. P1 may generate a separately cached summary of the exact selected IDs.

P0 search matches message text, sender, filename, URL, and topic title with case-insensitive Unicode-aware substring search and appropriate indexes. PostgreSQL full-text search may supplement it; do not rely solely on English stemming for Chinese or mixed-language chats. Results show snippets and open the exact source. Semantic search is P1.


## 8. Linked-device connection and incremental synchronization

### Pairing and persistent session

Use current primary documentation and the installed package's types. Target a supported Node LTS release (Node 24 LTS is the baseline), resolve a maintained patched Baileys package, lock exact versions, and record a real smoke-test result. Do not install an unpinned GitHub master or assume a website's version navigation matches the installed release. [S30–S32]

Implement an AuthStateStore adapter with encrypted PostgreSQL records in a companion-only schema/role. Persist both credentials and Signal key updates durably and use Baileys-compatible binary serialization. Encryption uses a privately generated 32-byte key held in Nebius SecretStash, passed only to the companion process, and retained across Endpoint replacements. A missing/wrong key produces a setup/relink error, never silent session replacement. The documented multi-file helper may be used for a disposable development spike, but it is not the release auth store. [S24]

Only the authenticated workspace owner can begin pairing and receive its current QR. Expire/replace QR state and clear it after pairing/cancel. Deliver QR transiently through internal companion-to-web notifications and owner-scoped SSE; exclude it from durable command payloads, logs, tracing, screenshots, and public assets. The web may keep the current QR only in bounded memory until expiry. Never request a WhatsApp password or upload saved session files.

Acquire a PostgreSQL advisory lock or renewable ownership lease so only one companion socket operates on an account. Persist credentials/key changes before completing their writes. Handle expected restart-required transitions, transient errors with bounded backoff/jitter, and logged-out/revoked credentials with Relink required instead of an infinite reconnect loop. [S23, S24]

Set markOnlineOnConnect=false. Do not invoke readMessages, chat mark-read, sendMessage, remote message edit/delete, or participant-modification methods as part of indexing or review. Incoming and owner-sent messages must both be processed; do not discard fromMe. [S25, S28]

### Chat selection and initial history

Discover minimal chat identity/title/type metadata for the chooser; display-name equality never merges chats. The session can receive broader data than the selection. Apply the selected-chat allowlist before durable source storage, model calls, media fetch, and content logging.

Initial history may arrive before selection. The approved P0 policy is a **cloud memory-only preselection buffer**, bounded to 32 MiB and five minutes, disclosed in the connection explanation. Do not write its content to persistent storage, logs, traces, or another service. Release selected eligible records through normal ingestion and promptly discard the remainder. On expiry/overflow, discard buffered content, record a content-free coverage warning, and attempt bounded available-history retrieval only after selection. Clearing this buffer does not imply the library/OS never transiently handled account data.

For each selected chat, persist one of:

- **Available history + new messages:** ingest eligible history actually returned, with an initial 10,000-message per-chat backfill cap; then continue new arrivals.
- **New messages from now:** freeze a UTC selection cutoff. Index eligible messages whose native sent_at is at/after that cutoff, including qualifying messages redelivered through history after reconnect. Do not include older buffered/history messages just because they arrived later. Unknown-time records stay outside this mode with an explicit count.

If the cutoff appears inconsistent with source clocks, show a warning and offer a deliberate cutoff/mode change; do not silently shift it. Edits to messages already indexed still apply regardless of the initial cutoff. Reselecting a paused chat resumes its previous selection; changing to available history is explicit.

Handle messaging-history.set, history append events, and supported bounded history requests. Merge every accepted event through the same canonical source path. Expose observed earliest/latest timestamps and counts, not an assertion of complete archive coverage. syncFullHistory, isLatest, or a Connected status is not proof that all history or offline gaps were recovered. [S25, S26]

### Native identity, event order, and idempotency

Maintain a stable linked_account_id independent of connection attempts. Re-pairing the verified same account can reuse its account/chat/message identities; a different account cannot inherit another account's records. Use library-provided PN/LID normalization and authoritative alias mappings; never infer identity merely from a display name, phone-like string, or payload text. [S29]

Persist the complete supported native message key. Canonical deduplication is scoped by workspace + linked account + stable chat + native message ID, with fromMe/participant discriminators as required by the pinned type and its tested key semantics. Apply uniqueness after authoritative alias resolution; retain raw key aliases. Account/chat/native-key equality deduplicates retries and backfill; sender + timestamp + body does not. Keep distinct native IDs even when content and timestamps are identical.

Process every message in each upsert batch. Separate notify/append/history, edits, revocations, system events, receipts, and unsupported types using the actual installed event shapes. Preserve original sent_at, received_at, content revision, and control-event ordering. Duplicate/older events cannot overwrite a newer observed edit or tombstone. Uncertain conflicting updates remain flagged rather than silently replacing evidence.

Persist selected source changes and an idempotent analysis outbox in one transaction before invoking any model. Job identity includes message IDs, content revisions, scope, and pipeline version. Replayed identical events do not reset Read/Missed, duplicate files, or regenerate completed analysis. If persistence is unavailable, stop/close the session and show degraded/gap status rather than continuing indefinitely while dropping content.

### Connection, coverage, and analysis states

Track these separately:

| Dimension | States/information |
| --- | --- |
| Connection | Disconnected, Pairing, Connecting, Connected, Reconnecting, Paused, Relink required, Error; companion heartbeat and last source-event time. |
| History | Not requested, Receiving, Settled for now, Limited, Unavailable; observed range, selected cutoff, count and uncertain intervals. |
| Analysis | Pending, Running, Up to date for captured revisions, Budget paused, Incomplete/failed; queue depth and last successful version. |

“Up to date” refers to captured eligible revisions only. After any disconnection, disclose the uncertain interval until evidence supports narrower coverage; do not invent an exact number of missed WhatsApp messages. After SSE loss, the browser refetches authorized state by version/cursor; an ephemeral notification is never the only source of truth.

### Pause, deselect, disconnect, and delete

- **Pause synchronization:** close the account socket and retain encrypted auth state plus selected data. Resume reconnects; show possible gaps.
- **Deselect a chat:** stop new durable capture/model submission for that chat, invalidate not-yet-dispatched analysis, and retain existing indexed data until explicitly deleted. In-flight external requests cannot be recalled; discard their later output for the withdrawn scope.
- **Disconnect/unlink:** close/logout the session, remove saved credentials/Signal keys, clear transient QR/buffers, and require pairing to resume. Retain indexed chats unless deletion is separately chosen. If remote unlink cannot be confirmed while offline, say so and show WhatsApp Linked Devices removal instructions.
- **Delete indexed chat:** unsubscribe first, invalidate jobs and pending events using a subscription/deletion generation, purge content/derivatives, and retain a minimal exclusion marker. Later live/history events cannot recreate it until explicit reselection.
- **Delete workspace:** disable/disconnect its session and invalidate jobs before deleting its data. Document actual backup retention.

### Source and analysis limits

Backfill caps limit initial history only; they must not stop live capture at message 10,001. Keep a visible Limited history indicator with actual coverage. Media downloads default to at most 50 MiB per file and a 500 MiB workspace cache; handle quota exhaustion explicitly and allow authorized cache clearing.

Batch new analysis for up to three seconds or 60 messages, with bounded source context and token limits. Persist sources even when model budgets are exhausted. Queue/backfill work is resumable. If storage fails, stop capture and expose uncertainty rather than silently evicting source records.

Published graphs use immutable validated versions and an atomic current pointer. Keep the previous valid topology while reanalysis runs, but immediately suppress claims/links whose source revisions were edited, revoked, expired, or deleted. Cancellation/generation checks prevent stale jobs from publishing after deletion or selection withdrawal.

## 9. Nemotron pipeline and model routing

Use Nebius Token Factory's OpenAI-compatible API at https://api.tokenfactory.nebius.com/v1/. The OpenAI client library is a transport choice; the inference provider is Nebius and the selected models are NVIDIA Nemotron. [S8]

| Role | Preferred model | Work |
| --- | --- | --- |
| Reasoning | Nemotron 3 Ultra | Initial per-chat recursive taxonomy, bounded deeper-branch refinement, difficult topic merges, explicit taxonomy rebuilds. |
| Fast | Nemotron 3 Nano | Chunk extraction, candidate labels, resource mentions, short grounded discussion summaries, incremental assignments. |
| Balanced | Nemotron 3 Super | Ambiguous assignments, bounded output repair, cross-chat link verification, optional cited answers. |
| Deterministic code | No model | Event normalization, IDs, distinct recursive counts, node sizing/layout, permissions, timestamps, media association, deduplication, read state, graph validation, and writes. |

Nebius's published examples show these IDs: Ultra nvidia/Nemotron-3-Ultra-550b-a55b; Super nvidia/nemotron-3-super-120b-a12b; Nano nvidia/nvidia-nemotron-3-nano-30b-a3b. They are configuration candidates, not guaranteed account-level aliases. Preserve the exact casing returned by GET /v1/models, and run a small capability call before use. Do not include a framework prefix such as nebius: in the API model field. [S9–S12]

If a selected model is unavailable, report the failed role and configured identifier. The app may use an explicitly configured fallback, displayed in diagnostics. A fallback execution does not count as proof of Ultra use. Never silently substitute another provider or the older Llama-Nemotron Ultra family.

### Processing steps

1. Normalize and persist selected native events as canonical source records before calling the model.
2. Create bounded overlapping chunks, initially up to 60 messages and approximately 8,000 input tokens, with up to ten messages of overlap. Split oversized bodies into analysis slices with source offsets while preserving the intact source.
3. Nano returns discussion candidates, root proposals, topic terms, resource references, and concise summary bullets with evidence IDs.
4. Ultra receives compact candidate digests, representative source snippets, relevant current ancestors/children, and user overrides. It proposes a coherent recursive hierarchy beneath the three fixed roots, using Programming, Music, Art, and History as illustrative Knowledge subjects when supported. It may refine any existing branch further; do not prescribe a two-level JSON shape or a terminal depth.
5. Map extraction units to stable topic IDs at the supported depth, with full ancestor context to disambiguate same-title topics. A topic may retain direct discussions alongside narrower children. Escalate unresolved assignments to Super.
6. Validate IDs, scope, root enums, parent references, all-depth cycle constraints, distinct descendant memberships/counts, source revisions, and per-call output limits in code.
7. Publish an atomic graph version. Reuse summaries only when their evidence and prompt/model versions still match.
8. Propose bounded cross-chat candidates and validate them with Super.

Do not run Ultra on every message or every expansion. Ordinary map navigation, Show depth changes, branch expansion, ancestor-content pagination, filtering, search, and review updates cause **zero inference calls**. Initial history analysis is asynchronous. Live microbatches analyze new/changed revisions with bounded previous context rather than reprocessing the archive. Debounce initial history delivery to avoid repeatedly rebuilding taxonomy while the first history batches settle.

Refine the tree in bounded work units instead of asking one call to return an entire unbounded nested object. Persist a refinement frontier containing parent ID, scoped input-unit/source revisions, continuation/checkpoint, and pending/completed/budget-paused status. Context may summarize distant ancestors while retaining their stable IDs and validated relationships. Stop adding levels when content supports no useful narrower grouping; do not create filler levels to match a selected display depth.

When token/output/call/time limits interrupt useful refinement, preserve the valid partial hierarchy and unfinished frontier, expose pending work, and resume through the durable worker within the original logical analysis/rebuild budget and daily ledger. Continuation must not reset spend/call caps or trigger an endless auto-retry loop. The UI's requested depth never determines how deeply stored topics may be classified. If the frontier is exhausted, report the actual supported depth; if budget-paused, do not label the hierarchy complete.

### Output contracts

Use application-side Zod/JSON-schema validation regardless of provider response mode. Nebius supports JSON output options, but its documentation asks users to check model-specific support. Prefer a capability-tested JSON Schema mode; otherwise use a tested JSON-object/text path with strict validation. [S13]

An illustrative extracted unit, with synthetic IDs:

~~~json
{
  "unit_key": "chunk-2-unit-3",
  "primary_root": "KNOWLEDGE",
  "topic_terms": ["Python", "generators"],
  "message_ids": ["m104", "m108"],
  "summary_bullets": [
    {
      "text": "The discussion compares generators with materialized lists.",
      "evidence_message_ids": ["m104", "m108"]
    }
  ],
  "resource_refs": [],
  "needs_review": false
}
~~~

Only supplied IDs are admissible. Resource references select an extracted URL or attachment ID; the model cannot invent a downloadable file. Require a small nonempty evidence set per factual bullet, with claim-level citations rather than one uninformative citation for a whole page.

Taxonomy proposals use a flat collection of nodes and parent references rather than a fixed-level object. Each proposed node has a temporary proposal key, an existing/proposed parent reference, root, title, aliases, direct member-unit keys, and representative source IDs. Assignments may target existing stable topic IDs. Parent references may point only to supplied authorized nodes or keys defined in the current proposal. The application assigns stable node IDs, validates containment against the existing graph, derives depth and recursive membership, and records old-to-new mappings. Do not accept a model-supplied depth as authoritative. A reasoning model's explanations do not override permissions or validation.

### Failure handling and budget

Separate network retries from output repair. Use timeouts and bounded exponential retries for transient errors; cap attempts and total calls per analysis job and per day. Permit one schema-repair call for an invalid extraction, then mark that unit Needs review. Invalid source references are never persisted as valid evidence.

Treat model self-reported confidence as a heuristic. Escalate also on missing evidence, conflicting classifications, unsupported roots, and user corrections.

Maintain a budget ledger with reservations before concurrent requests. Use current provider prices when available and count actual reported tokens, including billed reasoning/output categories. A cost estimate is not an invoice guarantee. Enforce the configured call/token ceiling even when price metadata is unavailable. Stop at the user's budget and preserve resumable work.

Cache by workspace, selected scope, source-content digest, model ID, prompt version, and schema version. Do not cache raw private data in a shared cross-user namespace.

Provide FixtureModelProvider for deterministic local tests and NebiusModelProvider for live operation. Fixture responses have a visible mode indicator and never pass a live-inference gate.

## 10. Application architecture

### Required deployment and component placement

P0 is a publicly reachable application on an actual **Nebius Serverless AI Endpoint**. Localhost or Token Factory usage alone does not satisfy deployment. Nebius supports custom CPU containers and managed HTTPS URLs. The companion runs in Nebius; users need a browser and their phone for pairing. [S34–S36]

| Component | P0 location and implementation |
| --- | --- |
| Web interface and API | Next.js/TypeScript Node process in the Endpoint container; React Flow with an accessible outline alternative. |
| WhatsApp companion | Separate long-running Node process in that same container; pinned Baileys version and one active socket owner per linked account. |
| AI worker | Separate Node process using pg-boss; calls Nemotron through Token Factory. Model weights and GPUs are unnecessary on this endpoint. |
| Process supervision | Container entrypoint supervises all three processes, forwards termination signals, and performs bounded child restarts. |
| Durable database | Nebius Managed PostgreSQL, private read-write endpoint, certificate-verified TLS, Drizzle migrations, application authentication and job tables. |
| Durable attachments | Private Nebius Object Storage bucket through an S3 StorageAdapter; container temporary files are disposable. |
| Secrets | SecretStash injection for Token Factory credentials, database/storage credentials, Better Auth secret, and a persistent WhatsApp-auth encryption key. |
| Browser authentication | Better Auth with PostgreSQL sessions; private user workspaces and isolated synthetic demo guest sessions. |
| Build and verification | One repository, locked dependencies, reproducible Docker image, Zod, Vitest and Playwright. Compose is a development convenience. |

Use one regular CPU Endpoint with a supported project resource preset. Expose only the web port through managed HTTPS; companion control and worker interfaces remain internal. A typed pipeline and PostgreSQL are sufficient; no Redis, Neo4j or agent framework is required. [S18–S20, S35]

### Durable state and network boundaries

An Endpoint's container disk is removed when it is stopped or deleted. Persist messages, graph versions, jobs, review state, runtime settings, and encrypted Baileys credentials/Signal keys externally before relying on them. Store downloaded files in Object Storage before reporting them as cached. Keep the encryption key stable across releases and independent from the encrypted database records. Never use a local auth folder as the release's only session copy. [S34, S37, S39, S40]

Place the Endpoint and PostgreSQL in the same Nebius network and compatible region. Use the database's private read-write hostname with the documented CA and full certificate verification. Select session pooling for connections that use session-scoped advisory locks; do not place those locks over transaction pooling. Set finite connection-pool limits across all three processes. Private connectivity and outbound internet routing are separate requirements. Verify the chosen subnet can reach WhatsApp over WSS and Token Factory over HTTPS; the documented default egress route supports public destinations. [S38, S45, S46]

A private Object Storage bucket is not a public download directory. File access passes workspace authorization before an application stream or short-lived scoped download grant is issued. Preserve attachment availability, expiry and deletion contracts. Nebius credentials, auth state and media decryption material never enter browser bundles. [S39]

### Persistent entities

Native message identity, received events and revisions replace export-oriented `imports` and `message_occurrences` tables.

| Entity | Essential information |
| --- | --- |
| users, sessions, workspaces | Auth identity, workspace ownership, private/demo mode and isolated guest lifecycle. |
| linked_accounts, auth_records | Stable account identity; connection generation; encrypted credentials and typed Signal key records, with key version. |
| connector_leases, connector_commands | Account lease owner/expiry/fencing token; authorized control commands and acknowledgments. |
| chats, chat_aliases, selections | Stable chat identity, native JID aliases, discovery metadata, inclusion setting, selection epoch and history choice. |
| sync_events, coverage, tombstones | Scoped native event identity, processing checkpoint, observed history bounds, gap/status information and deletion protection. |
| messages, message_revisions | Stable canonical ID, native key, sender aliases, direction, original sent time, received time, current body/caption, edit time and content revision. |
| attachments, message_attachments | Private object key, source message, MIME/hash/size, availability, expiry and permitted retrieval metadata. |
| resources, message_resources | Original link or mention, optional canonical URL and exact source relationships. |
| topics, discussions, placements | Topics: stable hierarchy-node ID, CATEGORY/TOPIC kind, chat/root IDs, parent ID (null only for the three roots), and taxonomy version. Discussions and source placements are separate records attached to these nodes, with direct source/unit memberships and user/model provenance; they do not add topic-depth levels. All-depth ancestry and distinct descendant membership are derived or transactionally indexed. |
| summary_claims, claim_evidence | Claims, exact source message IDs and analyzed content revisions; full summary input membership. |
| concept_aliases, cross_chat_links | Both chat/topic endpoints, evidence on both sides, relationship reason and dismissed state. |
| review_state, taxonomy_overrides | Per-user canonical message review state; durable title/parent/membership corrections and locks independent of regeneration; explicit topic-merge ID mappings. |
| user_chat_view_preferences | User/chat-scoped Show depth (nonnegative integer or all), optional expansion/focus preferences, and update revision; no fixed-depth enum or source-selection effect. |
| jobs, outbox, model_runs, taxonomy_frontiers | Input fingerprint/revisions, parent/refinement checkpoints, model/prompt/schema versions, usage, safe errors and retry/budget state. Continuations retain the original logical job/rebuild ID and budget ledger. |
| runtime_settings | Deployment ID, exact trusted public origin, configuration revision and bootstrap audit metadata. |

Enforce tenant-scoped uniqueness, foreign keys and authorized queries. Index native identity, chat/time/order, user/message reviews, topic memberships and search paths. Store only the protocol metadata needed for recovery and provenance; do not retain unselected message bodies in a generic event archive. Revision/event history must also purge revoked, expired or deleted bodies; retaining a revision number does not authorize retaining its removed text. Replayed events cannot recreate deleted content or reset existing reviews.

Index (workspace, chat, root, parent_id) and direct message placements. Use recursive queries or a maintained ancestry/closure index for ancestor-content queries, descendant filtering, counts, cycle checks and subtree corrections; no query may assume only child/grandchild levels exist. Keep a single validated graph version for each paged hierarchy response. Apply subtree edits with transactional concurrency/version checks so simultaneous valid-looking moves cannot introduce a cycle. If upgrading an earlier shallow schema, preserve existing IDs, source placements, overrides and review revisions while removing the depth restriction; an existing map must not be deleted and recreated solely for this change.

Derive matching_message_count and matching_missed_count from authorized canonical source sets. Cache keys include workspace/user, authorized chat scope, node, graph/source/placement/review versions and content-filter fingerprint; Show depth and graph pagination do not define count membership. Invalidate affected ancestors after source, review or placement changes. A count_version identifies the coherent aggregate snapshot, including the current user's review revision when relevant. Pixel sizes are derived presentation from that count and the shared sizing-configuration revision, never independently authoritative stored data or model output.

### Public-origin bootstrap

Endpoint configuration is immutable after creation, while the managed HTTPS URL is learned from the created resource. Use `PUBLIC_ORIGIN_MODE=database_bootstrap` and a unique, non-secret `DEPLOYMENT_ID`. Before the matching `runtime_settings` row exists, serve only a content-free health response and a generic unavailable response elsewhere; private authentication and QR pairing remain disabled. [S35]

After creation, an authorized operator runs the provided **in-network admin CLI** with the exact HTTPS origin returned by Nebius and that deployment ID. The CLI writes the verified origin to PostgreSQL using restricted administrative credentials. It validates a single HTTPS origin without a path, query, credentials or wildcard. This is not a browser-accessible setup endpoint and must not accept the first request's Host header as registration.

The application reloads the settings and initializes or reinitializes Better Auth and the exact trusted-origin allowlist. Only then does it accept sign-in and pairing. Reject mismatched origins and untrusted forwarded headers. New deployments require their own explicit origin registration; retain a documented rollback procedure. `NEBIUS_DEPLOYMENT.md` must implement this sequence without printing secrets.

### Live delivery and ownership

The companion commits selected source events before enqueueing analysis. Database-backed commands coordinate pairing, selection, pause, resume, media retrieval and disconnect; the browser cannot invoke arbitrary Baileys methods. The AI worker claims bounded jobs, verifies workspace/generation/content revision, calls the configured model, then publishes validated graph changes atomically. Lost or delayed model access must not interrupt message receipt.

Use a dedicated session connection for the account ownership lock, plus a fencing token checked by writes and control operations. On lost database ownership, close the WhatsApp socket and stop side effects. A replacement process must acquire ownership before connecting. This protects restart and deployment overlap; it does not promise lossless recovery of WhatsApp events never delivered to ThreadMap.

Authenticated SSE delivers committed changes. Resume with a cursor or refetch after a gap; bounded polling is an acceptable fallback. QR delivery is owner-only, transient and uncached. Tunnels supports WebSocket upgrades; browser transport and outbound WhatsApp connectivity still require hosted integration tests. [S44]

### Minimum application API contracts

These are ThreadMap routes to implement, not existing Baileys or Nebius APIs. Every private route resolves the workspace from the authenticated user, verifies ownership, and returns safe errors.

| Route | Contract |
| --- | --- |
| POST /api/whatsapp/pair | Start an owner-authorized pairing attempt; return attempt ID, never persistent auth state. |
| GET /api/whatsapp/status | Connection state, last event, history coverage, processing backlog and relink requirement. |
| GET /api/whatsapp/chats | Minimal discovered chat metadata and current selection; no unselected content previews. |
| PUT /api/whatsapp/selections | Validate chat IDs, selection epochs and chosen history modes; acknowledge effective scope. |
| POST /api/whatsapp/pause, /resume | Apply the Section 8 lifecycle semantics and report effective state. |
| POST /api/whatsapp/disconnect | Execute the explicit disconnect/remove-session choice and stop receipt as specified. |
| POST /api/chats/{id}/history | Request permitted, bounded older-history retrieval; report partial/unavailable outcomes. |
| GET /api/events | Authorized SSE for private or isolated demo scope, with resume/refetch behavior. |
| GET /api/chats | Indexed chats with selection/paused state, distinct message counts, Missed counts and pending-analysis state. |
| GET /api/chats/{id}/map | Versioned graph using shared content filters plus separate max_topic_depth=integer/all, expanded/focused node IDs, and graph pagination. Return absolute depths, available_max_topic_depth, boundary/deeper indicators, server-derived matching_message_count/matching_missed_count, count_version, filter_fingerprint and shared sizing-configuration revision/bounds. Complete subtree counts remain independent of the returned graph page; enforce the visible-node budget without changing membership. |
| GET /api/chats/{id}/nodes/{nodeId}/content | Root/topic content at any depth, whether visible or hidden: paginated Messages or Files from own and all descendant memberships under the shared content filters, with canonical IDs, exact source associations, current revisions and full ancestor paths. Do not restrict membership by max_topic_depth or graph-page IDs. |
| PUT /api/chats/{id}/view-preferences | Save only the authenticated user's view preferences, including Show depth. Validate a nonnegative safe integer or all; a larger-than-current depth is valid and never creates topics. |
| GET /api/messages/{id} | Current exact source, provenance, revision and separately identified surrounding context. |
| POST /api/attachments/{id}/fetch | Authorized bounded on-demand retrieval; idempotent availability transition. |
| GET /api/attachments/{id}/content | Authorized stream or short-lived scoped access to a permitted available file. |
| POST /api/review/bulk | Frozen authorized message/revision pairs, target state and idempotency key. |
| PATCH /api/topics/{id} | Validated persistent rename or same-root subtree move/merge at any depth; reject cycles, cross-scope containment and stale graph-version edits. Preserve source/review IDs and return affected ancestry/merge mappings. |
| GET /api/search, /api/related | Shared filters and authorization; source evidence for both related endpoints. |
| POST /api/chats/{id}/rebuild | Explicit budget-checked taxonomy rebuild preserving overrides. |
| GET /api/jobs/{id}; POST /api/jobs/{id}/retry | Safe progress/results and permitted checkpointed retry. |
| DELETE /api/chats/{id} | Deselect, invalidate generation, remove content/derivatives and prevent replay resurrection. |
| GET /api/health/live, /api/health/ready | Content-free liveness and readiness; detailed diagnostics require authorization. |

Mutations require session validation, appropriate CSRF/origin protection, input limits, schema checks and idempotency where retryable. Demo guests cannot pair WhatsApp, inspect private accounts, or access private files. Their synthetic maps and review state are isolated without requiring a second Endpoint.

The node-content cursor is scoped to the authorized node, content-filter fingerprint and relevant graph/content version. It is independent of display depth and graph pagination. Default to 50 content rows per page (MAP_CONTENT_PAGE_SIZE); return continuation metadata and honest filtered totals. A graph/source change that invalidates a cursor returns a recoverable refetch response rather than mixing stale membership or leaking removed content. Bounds on response size, traversal work and rendering must return pagination/continuation or a visible retryable state, never silently drop deeper matches.

The map count badge, derived diameter and node-content total must refer to the same effective filter and aggregate snapshot. Apply a response atomically, discard superseded request generations/count versions, and refetch after invalidation instead of mixing old membership with a new badge. Represent unknown aggregates explicitly; an absent or errored count cannot be coerced to zero. Aggregate routes and caches must enforce the same user/workspace permissions as raw messages: a node's size/count must not disclose another workspace's messages.

### Operations and release behavior

One container with three processes is a deliberate prototype simplification. Give each child only its required environment variables, but document that they share one container trust boundary; this is not strong process isolation. Supervision must forward signals, stop intake, finish or safely abandon leases, and preserve durable checkpoints. Bounded child retries must not hide a permanently failing service behind a healthy response.

Nebius does not provide automatic Endpoint restarts through the Jobs restart-policy feature. Provide an external health alert and an operator restart/recreate runbook. Container supervision handles child failures only. A server restart can interrupt WhatsApp delivery; display reconnect/gap state and validate restart recovery instead of claiming uninterrupted availability. [S43]

Use a migration lock and one authorized migration runner. For a digest-pinned release, create the replacement Endpoint, bootstrap its observed origin, verify database/storage/readiness, then release the old connector lease before acquiring it on the new deployment. Publish the new URL and update test instructions. Keep rollback images and compatible schema migrations. Do not assume settings or the public URL can be updated in place. See `NEBIUS_DEPLOYMENT.md`. [S35]

Record actual hosting resource IDs, image digest, resource preset, cost estimate and recovery evidence. Running Endpoints incur Compute resource charges; database and storage have their own costs. **Serverless Jobs are P1** for finite backfill/evaluation work, with external checkpoints and idempotent result publication. They are not the persistent WhatsApp host or a per-message requirement. P0 must pass the genuine public Endpoint acceptance gate. [S41, S42]

## 11. Optional tools and the data they may receive

| Tool | Role | Version 1 decision |
| --- | --- | --- |
| Nebius Token Factory | Required Nemotron inference | Core dependency for live analysis. |
| LangSmith | Trace stages and compare evaluation runs | Optional integration; absent keys must not break the app. |
| Tavily | Enrich a deliberately selected public link | P1 feature flag; not required for organizing chats. |
| Toloka | Human evaluation of classification, summaries, and links | Optional offline evaluation on synthetic or consented examples. |
| Tendem by Toloka | Paid asynchronous human review | Defer from runtime; consider a separately budgeted evaluation task. |

LangSmith supports input/output hiding and custom masking. Default tracing off; when enabled for private chats, allow only opaque IDs, operation/model names, counts, durations, usage, and validation status. Also sanitize metadata, URLs, errors, and custom logs. Rich traces are suitable for the synthetic demo. [S14]

Tavily Extract can retrieve public URL content and returns success and failure results that must both be handled. Offer Enrich this public link; store its fetched content and retrieval date separately from chat evidence. No automatic transmission of transcripts or participant names to web search. Restrict initial enrichment to validated public HTTPS URLs; block local/private hosts, embedded credentials, and token-bearing private links. [S15]

The sponsor context appears to refer to **Tendem**, although the Builder Program FAQ uses “Tandem.” Nebius identifies Tendem as Toloka's human-expert workflow platform. Confirm the intended product before adding any integration; no unrelated Tandem application is assumed. [S16, S17]

## 12. Privacy and operating behavior

ThreadMap's linked-device session runs in the operator's Nebius deployment. The server receives WhatsApp data and stores the selected conversations; selected text is sent to Nebius Token Factory for analysis. Explain this cloud custody before pairing and identify the processing destinations. Do not describe ThreadMap as fully on-device or claim WhatsApp end-to-end encryption extends through its database, files or model processing. Chat selection is an application control, not a WhatsApp-enforced permission scope. [S25, S34]

Apply selection before durable content indexing, model calls, media retrieval, tracing and cloud event archives, using the precise discovery/history policy in Section 8. Display filters do not retroactively restrict the data already synchronized or analyzed. ThreadMap Read/Missed is independent from WhatsApp receipts. No application action sends chat messages, edits remote content or deliberately marks WhatsApp messages read.

Keep persistent Baileys credentials and Signal keys encrypted in PostgreSQL, with the separate encryption key injected from SecretStash. Keep provider, database, storage and authentication secrets server-side. Never expose them in public environment variables, browser bundles, repositories, QR logs, model traces, analytics or error responses. QR payloads are transient and visible only to the account owner. Sharing a public demo URL does not authorize access to an owner's linked account. [S40]

Render received text safely. Sandbox supported previews and never execute a received HTML, SVG or script file in the application origin. Chat content and fetched pages are untrusted data; classification models receive no messaging, shell, credential or unrestricted network tools. Logs contain allowlisted operational metadata; raw messages, participant identifiers and sensitive attachment URLs are excluded.

Public guests receive isolated synthetic workspaces and independent review states. They cannot pair WhatsApp or browse private data. Authenticated private operations verify workspace ownership on every source, graph, job and file path.

Deleting a chat first deselects it and invalidates its processing generation, then removes canonical content, unused files, reviews, claims, indices, caches and cross-chat evidence. In-flight jobs, old selections and replayed events cannot restore deleted data. Document actual backup and external-trace retention instead of promising immediate deletion from every system. Provide pause, disconnect/unlink and data-deletion controls with their specified effects.

Keep keyboard navigation, visible focus, textual status indicators and an equivalent outline/list path to source messages. Accessibility and privacy behavior must also work in the hosted demo.

## 13. Acceptance criteria

These are implementation completion gates, not results already achieved.

### Deterministic core gates

| ID | Required observable result |
| --- | --- |
| A01 | A clean checkout builds the application image, migrates a test database, starts equivalent development services, and loads an isolated synthetic demo. Cloud execution is separately required by A20. |
| A02 | Three fixture chats remain distinct and each shows exactly Knowledge, General Chat, Resources; pending analysis is not a fourth root. Empty roots retain minimum outlined size with 0 messages, distinct from unknown/loading counts. A Knowledge fixture supports at least six non-root topic levels, uneven shallow siblings, repeated titles under different parents, and a topic with both direct discussions and child topics. No hard-coded two/three-level cap exists. |
| A03 | Native-event fixtures cover incoming/outgoing text, Unicode/multiline bodies, group/direct chats, system records, attachments, history/live overlap, authoritative PN/LID aliases, out-of-order edits/revokes, and unsupported markers with expected canonical sources. |
| A04 | Published derived nodes/claims reference authorized, current eligible source revisions. Unknown IDs, stale deleted evidence, unsupported roots, orphan nodes, self-parenting, deep ancestor/descendant cycles and cross-chat/root containment are rejected/suppressed. Distinct same-title topics retain their own IDs and ancestry. |
| A05 | Map/outline navigation and any-root/topic content access open the expected exact source with sender, original time, chat/context, full topic path and available file. At Show depth 0 and 1, retrieve a six-level-deep source/file directly from an ancestor without expanding hidden levels. Mixed direct/descendant content, uneven shallow branches and unavailable/expired/unsupported file states work. |
| A06 | Replaying the same native events and restarting companion/worker adds no duplicates, preserves review/overrides, and does not repeat completed inference. Cache fills do not alter source identity. |
| A07 | A controlled 20-message fixture update adds exactly twenty human messages, initially Missed, preserving distinct identical-text native messages. Backfill merges once, new-only cutoff holds, and the history cap does not stop later live capture. |
| A08 | Two-second foreground source dwell marks only that selected revision Read. Parent content lists, summary/zoom/context, files, expansion and Show depth changes do not mass-mark messages or auto-select a source. Manual Missed persists until deliberate reopen. A content edit becomes Missed; receipt-only updates do not. |
| A09 | Multiple placements share one review state/count across all ancestor levels and do not inflate node size. Bulk updates affect exactly frozen matching subtree message/revision pairs, including hidden descendants and beyond the first content page; new arrivals and concurrent edits remain Missed. In All, a Read change leaves size unchanged when membership is unchanged; in Missed it updates the matching size while preserving the selected source. Changing display depth alone cannot change the set or logical size. |
| A10 | Date/topic/status/chat filters return the same expected recursively intersected IDs in graph/list/search/resources/counts and determine sizing from the matching count. For a fixed selected node, Show depth 0/1/2/6/All preserves canonical result IDs, file associations, total/missed counts, logical diameter and bulk candidate sets. A deep active topic filter persists when hidden. Stale filter/count responses cannot restore old sizes. Outside-filter context and full-topic summaries remain separate; original dates survive history/edit events. |
| A11 | Topic rename/same-root subtree move/merge at different depths, explicit message corrections, dismissed links and review states survive regeneration/service restarts. Ancestors/counts update; IDs and source URLs stay valid; unsafe move/merge cycles are rejected. Depth preferences persist per user/chat, URL overrides work, and another user's preference is isolated. Source changes invalidate stale generated prose without discarding unrelated corrections. |
| A12 | Valid cross-chat links expose evidence on both sides; unrelated candidates are rejected and dismissals persist. |
| A13 | Another user/demo cannot access the owner's chats, files, graph, aggregate counts/sizes, QR, connection commands, auth state, jobs, traces or search. Unselected bodies never enter durable sources/model requests/media jobs/logs; memory buffer TTL/size is enforced. Count caches and filter fingerprints cannot cross user/workspace boundaries. |
| A14 | Simulated 429/timeout/invalid JSON/reference/provider outage leaves sources accessible, analysis visibly pending, budgets bounded, and retries idempotent. A multi-part deep taxonomy persists its refinement frontier and resumes within the same logical budget ledger without flattening, resetting caps, or claiming unfinished work complete. Stale worker results cannot overwrite newer revisions. |
| A15 | Deletion unsubscribes before purge and prevents event/job resurrection. Revocation/expiry removes visible text, file access and derivative claims; stale replay remains tombstoned. Unsafe filenames/content and sensitive logs are handled safely. |
| A16 | Navigation, Show depth, expansion, ancestor-content pagination, filter/search/review, counting, resizing and layout cause zero model calls. Defaults, custom depth greater than available, All levels, boundary controls, keyboard/outline parity and hidden selected-node content work. At most 200 graph nodes render while every stored depth remains reachable through lazy loading/focus/pagination. Size-aware layout passes the checks below and live updates preserve focus, camera and open source. |
| A17 | Meaningful tests, lint, typecheck and production image build pass. No P0 workflow is a placeholder, fake integration, disabled control or browser-only store. |

**A16 node-sizing checks:** Use independent count-contract/generated performance fixtures for 0, 1, 10, 100, 1,000, 10,000 and 10,001 messages, keeping the canonical three-chat evaluation fixture at 300 messages. Verify equal-count logical geometry across roots/depths/chats, increasing computed sizes below the visual reference, bounded zero/maximum sizes, and exact labels above the cap. Test a parent whose children have overlapping message placements, hidden six-level descendants, supported file-only messages, multiple files per source, unknown/error counts and invalid configuration. Source-list totals, count badges and sizes must agree. Verify updates after valid live placement, replay, Read/Missed changes, edits, revoke/delete/expiry, and subtree moves; attachment cache fills do not change weight. Confirm depth/focus/paging invariance, stale-response rejection, readable labels, nonoverlapping settled node/label bounds at up to 200 visible nodes, keyboard access, reduced motion and preserved selection/camera/drawer when a filtered node shrinks or disappears.

### A18 — real Nemotron inference

Discover the configured Ultra, Nano and Super IDs and pass a small schema/capability check for each. Feed fresh synthetic normalized events through the real extraction/taxonomy pipeline on Token Factory and perform genuine Super cross-chat verification. With source evidence designed to support a useful nested subject, demonstrate an actual Ultra-generated path beyond two topic levels and validated source assignment; a manually seeded deep graph alone cannot satisfy that recursive-model check. Record nonsecret IDs, endpoint, prompt/schema versions, observed supported depth, durations, usage and failures. FixtureModelProvider cannot satisfy this gate.

### A19 — genuine WhatsApp linked-device workflow

Use owner-operated harmless test conversations, including a selected group and individual chat plus an unselected chat. Through the hosted owner's UI, actually pair by QR, receive incoming and phone-sent messages, and show them without manual refresh. Prove selection exclusion; retrieve/open at least one supported attachment; process fresh captured content through real Nemotron into a three-root map and exact source. Preserve IDs/review after companion restart and replay. Demonstrate transient reconnect versus relink, pause/resume and disconnect with honest remote-unlink status. Test a controlled edit/revocation without stale evidence resurfacing.

The owner/test participant sends test messages manually from WhatsApp. Neither ThreadMap nor the coding agent needs a message-sending feature. Instrumentation verifies no deliberate WhatsApp read/seen calls when reviewing in ThreadMap. Fixtures can cover rare failures, but a replay source cannot satisfy actual pairing/live evidence.

### A20 — actual Nebius Serverless Endpoint deployment

The versioned application image actually runs on a regular CPU Nebius Serverless Endpoint at its observed HTTPS URL. Verify login and isolated demo from another device/browser. Pair and receive selected incoming/outgoing messages with laptop development services stopped; close the browser, then reopen and confirm cloud capture continued. Execute real model processing from the hosted worker.

Stop/start the Endpoint in a controlled test and verify external PostgreSQL auth/source/recursive-graph/review/job/frontier records, saved depth preferences and cached Object Storage files persist. Restore the WhatsApp session without needless QR when the upstream session remains valid. A competing companion cannot take the same account lease. Verify private-route protection, trusted-origin bootstrap, redacted health, outbound service access, and an Endpoint failure-recovery runbook.

On the hosted map, verify that committed source/placement/filter/review changes update counts and node size together without model calls or camera resets. After restart, the same authorized memberships, reviews, filters and sizing configuration reconstruct the same count badges and logical diameters; browser memory or stored pixel sizes cannot substitute for this check.

Record actual Endpoint ID, region, resource preset, image digest, HTTPS URL, external database/storage checks, timestamps and results. Local Docker, an unexecuted manifest, a localhost tunnel, a stopped Endpoint, or Token Factory usage alone cannot satisfy A20. No uninterrupted-uptime guarantee is implied.

### Evaluation and performance report

Freeze synthetic fixtures with three chats totaling 300 human messages, at least twelve file references including unavailable media, fifteen URLs, two languages, interleaved topics, identical-text distinct native IDs, a twenty-message update, history replay, edits/revocations, and an embedded prompt-injection instruction treated as source data. Include a supported six-topic-level path such as Knowledge → Programming → Hackathons → Solutions → Authentication → Tokens → Refresh flow, with messages and a file at its deep endpoint; shallow sibling branches; Solutions/Tips under different parents; and a parent with both direct discussions and deeper children. This six-level case proves recursive behavior; it is neither a maximum depth nor a requirement to force every real chat into six levels.

Human-review release targets: at least 85% acceptable primary-root assignments on 60 balanced examples; at least 80% useful-link precision over ten or more displayed links; at least 90% fully supported bullets among 30 sampled claims; success on at least eight of ten predefined source/file-finding tasks. Include at least two finding tasks that retrieve deep messages/files while displaying only categories or first-level topics, plus one task that deliberately expands deeper. Report numerators, denominators, disagreements and failures; allow admissible label sets for overlapping content. An LLM judging itself is not independent human review.

Hard invariants remain valid authorized current evidence and zero observed cross-user access in the isolation suite. Structural evidence validity does not establish semantic faithfulness.

With 10,000 synthetic messages, deep and wide topic branches, and at most 200 visible graph nodes, target cached map/filter (including exact recursive counts) and ancestor-content first-page p95 below one second over 30 requests per operation in a declared cloud region/network. Measure size-aware layout/update latency separately and check a settled mix of minimum/maximum bodies and long labels for overlap. Record tested depth and branch width; the rendering limit is not a storage-depth cap. Target source-receipt-to-UI p95 below two seconds for 30 controlled events on a healthy connection, independently of AI. Measure model latency, capture-to-map latency, backlog, history-processing duration, and provider/infrastructure costs separately. Report missed targets and outages; these targets are not vendor guarantees.

Write reports/acceptance.md, reports/live-inference.json, reports/live-connection.json, reports/cloud-deployment.json, reports/evaluation.md, and reports/performance.md. Exclude QR, credentials, private message bodies, phone numbers and raw native account keys. Distinguish PASS, FAIL, BLOCKED_EXTERNAL, UNRUN and UNREVIEWED.

## 14. Completion conditions

### BUILD_READY

All P0 implementation/preparation portions of T01–T16 are complete; A01–A20 have genuine passing evidence; a clean checkout reproduces build/deployment; and the **actual cloud-hosted WhatsApp → source → Nemotron → mindmap workflow** works. Required reports exist, pending human judgments are UNREVIEWED, and performance misses are honestly stated. No secret or private source content is in the repository.

For T16, prepared submission materials are required at BUILD_READY; their actual publication and completed human quality review belong to SUBMISSION_READY. Actual Nebius Endpoint hosting is part of this implementation gate. A localhost-only app cannot meet BUILD_READY. If pairing, model access, cloud credentials, funds/quota, required networking or deployment permission is absent, finish independent work and report BLOCKED_EXTERNAL with the precise remaining A18/A19/A20 action. Do not substitute fixtures, another host or a deployment recipe for missing execution.

### SUBMISSION_READY

BUILD_READY plus owner/human review meeting Section 13 semantic targets, a working judge-accessible demo/test-build URL, public licensed repository with reproducible setup, English project description/testing instructions, actual technology feedback, and a public YouTube demonstration under three minutes. If a target is missed, fix it or obtain an explicit owner-approved spec change; do not silently weaken a gate. [S2]

Distinguish implementation from submission publication. Missing actual hosted deployment blocks BUILD_READY; an otherwise completed build can have public repository/video/Devpost publication pending. Do not claim Devpost submission until it happened. Use already authorized configured publication destinations; otherwise prepare assets and record the exact owner action.

The deadline is 30 October 2026 10:00 a.m. PDT = **31 October 2026 1:00 a.m. Singapore time**. Target submission on 30 October. Maintain judge access through 15 December 2026 noon Pacific = **16 December 2026 4:00 a.m. Singapore time**; include ongoing infrastructure cost in the deployment budget. [S1, S2]

### Final product scenario

A larger node makes a message-heavy branch easy to recognize, and its exact count agrees with the content opened from it. Changing Show depth leaves retained nodes' counts and logical sizes unchanged. Applying content filters changes sizes to the matching volumes; live updates keep labels, counts and layout coherent without losing the user's place.

A user opens ThreadMap at its Nebius HTTPS URL, links WhatsApp by QR and selects conversations. Incoming/outgoing messages appear automatically while the user's computer can be off. The user opens each three-root map, sees Knowledge subjects such as Programming, Music, Art and History where supported, and can continue through progressively narrower branches. They choose Show depth = 1 and open Programming to retrieve a message and file from a much deeper Hackathons → Solutions branch without expanding it. They can also increase depth and navigate that full path. Date + Topic + Missed produce the same matching content at every displayed depth; selecting one exact source updates only its revision's review state. The user follows a supported link to another chat. New messages stay Missed; replays do not duplicate records; observed edits/revocations update evidence. Hosted restart retains sources, recursive maps, depth preferences, review, media, refinement checkpoints and valid auth state. Analysis uses real Nemotron models through Token Factory.

## 15. Setup the owner supplies

No Node.js, Baileys or npm account/API key is needed. These are build/runtime dependencies inside the hosted image. End users need only a browser and their existing WhatsApp phone account for pairing. [S5, S23, S30, S32]

1. Join the Devpost event and select Best Apps and Agents.
2. Enable Nebius Token Factory access, enter its API key through a private secret channel, choose inference caps, and resolve exact Ultra/Nano/Super model IDs.
3. Enable **Nebius AI Cloud** tenant/project access, deployment IAM permission, usable infrastructure funds/credits, and CPU/disk/network/database quotas. The Token Factory inference key is not the Cloud deployment credential.
4. Choose a supported common region/network. Provision/configure Managed PostgreSQL, private Object Storage, SecretStash and a container registry. Supply only project-scoped access needed by the coding/deployment runtime.
5. Keep secrets in SecretStash; generate and retain app/session-encryption keys once. Provide project/subnet IDs, image destination and a concrete infrastructure spending limit through the coding environment.
6. Prepare harmless test WhatsApp conversations and be available to scan the QR and send controlled test messages. No chat exports are needed. Do not send WhatsApp passwords, QRs or saved sessions to an assistant.
7. Provide the code repository and publication destinations for the demo, public repository and video. The implementation prepares manifests/runbooks before asking for any still-needed external action.
8. Add LangSmith/Tavily only for optional roles; arrange Toloka/Tendem review as a separately budgeted task.

The official Resources page lists Token Factory benefits including code NEBIUS-DEVPOST-GLOBAL26 and the Builder Program. Confirm actual redemption and whether any grant covers infrastructure; do not assume Token Factory credits pay for Endpoint, database or Object Storage. [S4, S16, S41]

Infrastructure costs are separate from model-token budgets. Inspect current presets/prices and record estimated daily and judging-period costs before provisioning within the owner's configured budget. Serverless does not mean zero cost while a persistent Endpoint waits for messages. [S34, S41]

See NEBIUS_DEPLOYMENT.md for the hosted runbook. Services must be available to the backend and coding runtime; adding a ChatGPT connector does not configure application credentials. This package is a proposal and implementation contract, not an already deployed application.
