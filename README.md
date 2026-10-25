# ThreadMap implementation handoff

Version 2.1 — 25 October 2026 — cloud-hosted linked-device prototype with recursive topics and depth selection.

Prepared for the Nebius x NVIDIA Global AI Hackathon, Best Apps and Agents Track. This revision replaces the earlier export-based and local-first implementation baselines. P0 requires a live Baileys connection and an actual Nebius Serverless Endpoint deployment. Manual transcript exports and uploads are outside P0.

This package is a specification for Claude Code to implement. It does not contain a completed application or claim that any implementation tests have passed.

## Read these files in order

1. `THREADMAP_BUILD_SPEC.md` — product proposal, fixed behavior, architecture, data contracts, and acceptance gates.
2. `NEBIUS_DEPLOYMENT.md` — required cloud topology, deployment procedure, persistent storage, trusted origin, and recovery checks.
3. `IMPLEMENTATION_TASKS.md` — T01–T16 tasks, deliverables, day-by-day plan, and submission preparation.
4. `CLAUDE_GOAL.md` — ready-to-paste implementation goal and explicit completion condition.
5. `env.example` — proposed runtime/deployment configuration; it contains no credentials.
6. `SOURCES.md` — dated primary sources and the specific external facts used in the proposal.

Copy this directory into a new or existing ThreadMap repository as `docs/threadmap/`. The Markdown files are intended to be repository documentation. In Claude Code, read the files and use the goal in `CLAUDE_GOAL.md`.

## Frozen decisions

- Build a responsive ThreadMap web app with a separate, long-running Node.js companion using Baileys to pair through WhatsApp Linked Devices.
- Deploy a custom container image on a regular CPU Nebius Serverless Endpoint. Supervise three separate Node processes inside it: Next.js web server on port 3000, Baileys companion, and pg-boss AI worker. Only the web port is exposed. No GPU model weights are hosted in this container; it calls Nemotron through Token Factory.
- Keep canonical data, review state, queue state, and encrypted WhatsApp auth in external Nebius Managed PostgreSQL through a private TLS connection. Put files in private Nebius Object Storage and encryption/API keys in SecretStash. Endpoint disk is temporary.
- Allow one linked WhatsApp account per private workspace. Select which conversations ThreadMap retains and analyzes. This selection is an application filter, not a WhatsApp permission boundary.
- Receive new incoming and outgoing messages automatically. Offer bounded available-history synchronization and report observed coverage without promising the entire archive.
- Give every chat exactly three top-level categories: Knowledge, General Chat, and Resources.
- Let Nemotron propose a recursive, content-supported topic hierarchy and inferred discussions, with citations to canonical source messages. Knowledge's suggested first-level subtopics are Programming, Music, Art, and History; deeper branches can continue through Hackathons or School work, then Solutions or Tips, and further supported levels.
- Use the same recursive hierarchy engine beneath all three roots. There is no hard-coded two-level topic limit; each branch stops when further subdivision would not help explain its source content.
- Provide a **Show depth** display control and direct access to a category or topic's matching messages and files, including all deeper descendants. Users do not have to expand to the deepest level to read the content.
- Open exact captured messages and available files inside ThreadMap. Fetch media on demand; show explicit unavailable/pending states.
- Persist per-user message review state; derive discussion/topic/chat Read and Missed states from it.
- Include useful links between selected chats, with evidence on both sides.
- Use Nemotron 3 Ultra for taxonomy reasoning, Nano for routine extraction, and Super for escalation through Nebius Token Factory.
- Keep ThreadMap review status separate from WhatsApp read receipts; provide no message-sending controls.
- Provide `/demo` through isolated synthetic guest workspaces; demo accounts cannot pair WhatsApp or access the owner's data. A separate demo endpoint is optional. Replayed demonstrations must be labeled as such.
- Keep optional services out of the critical path.

Closing the browser or turning off the user's laptop does not stop the cloud companion. A cloud outage, stopped endpoint, or broken WhatsApp session can still interrupt synchronization; report gaps and connection state honestly. Nebius endpoints do not inherit the automatic restart feature documented for Serverless Jobs, so include child-process supervision, monitoring, and an endpoint recovery runbook. This design does not promise uninterrupted 24/7 service. [S34–S37, S43]

Serverless Jobs are optional P1 work for finite backfill or evaluation. They are not a per-message launch mechanism or the home of the persistent WhatsApp connection. The required P0 deployment is the Endpoint. [S34, S42]

Baileys is an unofficial library, not a Meta-approved consumer API. Treat the connector as experimental and disclose its compatibility/account risk. The application still receives and stores selected chat data; “no export” means no manual transcript download/upload. Selected analysis content is sent to Nebius. [S5, S23–S28]

## Recursive topics and depth selection

Version 2.1 replaces the earlier maximum of two topic levels below each root. Keep exactly three permanent roots, but allow a finite hierarchy of any content-supported depth below them. These examples are suggestions for Nemotron, not compulsory empty folders or a fixed sequence every branch must follow:

| Depth | Example beneath Knowledge |
| --- | --- |
| 0 | Knowledge — the category root. |
| 1 | Programming, Music, Art, History. |
| 2 | Programming → Hackathons; Programming → School work. |
| 3 | Hackathons → Solutions; School work → Tips. |
| 4 and deeper | Solutions → Authentication → Tokens → Refresh flow, when the messages support those distinctions. |

A topic can contain both more specific child topics and discussions of its own. Short branches remain short. Exact source messages and available files remain reachable at every depth, including directly from the category root. Stable topic IDs and parent relationships define the tree; reanalysis must preserve user corrections and canonical message/review identities.

**Show depth** controls how much of that tree is displayed: category roots only (`0`), `1`, `2`, `3`, a custom nonnegative safe integer, or **All levels**. Default to 2 on first use; a value above the current tree height shows all currently available levels without creating topics. Depth is always measured from the category root, even when focusing a branch. Remember the user's choice for each chat; an explicit depth in the URL overrides the saved choice. All levels is explored progressively, with lazy loading, pagination, and at most 200 visible graph nodes; the visible-node budget must not flatten or truncate the stored hierarchy.

Clicking any category or topic opens a paginated content view containing its own matching source messages and files plus those of every descendant topic. A node at the chosen depth boundary shows that deeper topics exist and offers **Show next level**, but reading its content does not require that action. Show each source's actual topic path so a shallow view still explains where it belongs.

Depth changes visibility only. Date, topic, chat, and Read/Missed filters continue to select the same canonical messages; counts and bulk-review membership must not change when only depth changes. Preserve a selected deep topic's filter chip even when its node is hidden. Opening a parent, changing depth, or expanding a branch does not mark its messages Read; only the existing explicit or revision-aware source-view review actions do so. Navigation and depth changes make zero inference calls.

Claude Code must demonstrate this behavior with at least six topic levels below Knowledge, shallower sibling branches, and the same matching source set at depths `0`, `1`, `2`, `6`, and All levels. A deeply nested message and its available file must be reachable from the root or first topic level without expanding the intervening topics. The detailed data, model, UI, and acceptance contracts are in the build specification and implementation tasks.

## Accounts and installations

| Item | What the owner needs |
| --- | --- |
| Node.js | No account or API key. The cloud image includes the runtime; app users do not install Node.js. The coding environment targets Node 24 LTS and records its tested version. |
| Baileys | No account or API key. The coding agent installs and pins the library inside the application image after its connection smoke test. |
| npm/package manager | Installing the public dependency does not require a package-publishing account. |
| WhatsApp | An existing account on the owner's phone. Scan the app's fresh QR under WhatsApp → Linked Devices. No WhatsApp password is collected. |
| Nebius Token Factory | Account/project, server-side API key, model access, and a chosen spending cap. |
| Nebius AI Cloud | A project with billing, suitable region/quota, IAM permissions, network/subnet, and container-registry push/pull access. Cloud CLI or service-account credentials are separate from the Token Factory key. |
| Cloud data and secrets | Managed PostgreSQL, a private Object Storage bucket, SecretStash entries, and least-privilege credentials configured by the deployment workflow. |
| Git repository and hackathon accounts | Needed for code handoff and eventual public submission; these are independent of pairing. |
| Optional services | LangSmith, Tavily, and Toloka/Tendem can wait for their separately scoped tasks. |

No Meta developer account, Business Platform token, or business-number onboarding is needed for this chosen connector. Node.js and Baileys setup references are S30–S32. Never paste the Nebius key, pairing QR, or saved WhatsApp session into an assistant conversation or commit them to a repository.

`env.example` describes the hosted configuration the coding agent must implement, with `LLM_PROVIDER=nebius` and `SOURCE_PROVIDER=baileys`. Fixture modes remain available for development and isolated demo data, but cannot satisfy the live gates. The implementation must generate secrets privately and retain them in SecretStash, use an encrypted persistent Baileys auth store, and document deployment. This handoff is not itself runnable application code.

Set an infrastructure budget before creating paid cloud resources, separately from the inference limits. Endpoint compute, database, storage, and other cloud charges are not bounded by the application's LLM budget, and promotional Token Factory credits do not establish cloud-hosting credit. [S41]

## Public URL and durable deployment

The actual endpoint HTTPS URL is assigned during deployment. The deployment CLI must read that URL from the authenticated cloud response and store its exact origin in the database's `runtime_settings`. Authentication and QR pairing stay disabled until this trusted origin is available. Do not derive trusted origins from arbitrary incoming Host headers or expose a public setup endpoint.

Endpoint configuration changes require the replacement procedure documented in `NEBIUS_DEPLOYMENT.md`. An endpoint stop/restart preserves its URL but discards its local disk; deleting and recreating an endpoint changes its URL. Persistent data and the WhatsApp encryption key must survive both operations outside the container. The deployment procedure must update the trusted origin for a replacement and test sign-in, QR access, source files, and reconnects. [S35, S37]

## Completion has two gates

**BUILD_READY:** All P0 tasks and A01–A20 pass with evidence. This includes A18 actual Nemotron inference; A19 genuine QR pairing/live WhatsApp messages and a usable source-to-map path; and A20 an actual Nebius HTTPS deployment that continues receiving messages while the user's laptop is off and preserves data/session state through endpoint restart. Record A20 evidence in `reports/cloud-deployment.json`. A local build, planned deployment, fixture source, or replay alone cannot satisfy these gates.

**SUBMISSION_READY:** BUILD_READY plus human-reviewed results meeting the specified targets, a working judge-accessible deployment, a public licensed repository, and actually published required submission assets, including the public YouTube video. An offline fixture provider cannot satisfy either final gate. Missing external access is reported after independent work is complete; a publication-only blocker does not invalidate an already achieved BUILD_READY status.

The official submission deadline is 30 October 2026 at 10:00 a.m. PDT, or **31 October 2026 at 1:00 a.m. Singapore time**. Aim to finish and submit on 30 October Singapore time. See the official links in `SOURCES.md` for current requirements.
