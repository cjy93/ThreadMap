# ThreadMap primary sources

Version 2.2 — 25 October 2026. External sources below were last checked on 24 October 2026. They establish external service capabilities and event requirements. The product behavior, architecture, numeric application limits, quality thresholds, and schedule in this package are proposed design decisions, not vendor guarantees or achieved measurements.

The v2.1 recursive Knowledge hierarchy and Show depth control come from the owner's requested product changes. Programming, Music, Art, and History are illustrative first-level subjects; deeper branches are content-supported and have no fixed business/UI depth cap. Display depth is independent of source-content filtering, and any ancestor can expose its matching descendant messages/files. These are implementation requirements, not claims that a vendor automatically supplies the feature or that the application has already been built. No external capability recheck or live test was required for this document-only change.

The v2.2 node-sizing requirement also comes from the owner: more messages in a node should make it visually larger. Distinct filtered subtree counts, the shared compressed area formula, 64–220 graph-pixel diameter bounds, the 10,000-message visual saturation reference, exact count badges, and layout/restart checks are proposed ThreadMap implementation choices. The visual reference does not limit capture or source counts, and node size is not an LLM judgment of importance. No external service capability or completed implementation test is implied by this document revision.

## Event

| ID | Primary source | Used for |
| --- | --- | --- |
| S1 | [Hackathon overview](https://nebiusglobalaihackathon.devpost.com/) | Track name and intent, published deadline, judging dimensions. |
| S2 | [Official rules](https://nebiusglobalaihackathon.devpost.com/rules) | Required submission artifacts, judge access, dates, public repository/license, video, and entry requirements. |
| S3 | [Official FAQ](https://nebiusglobalaihackathon.devpost.com/details/faqs) | A Token Factory NVIDIA-model runtime call permits other app components to be hosted elsewhere; account support route. |
| S4 | [Official resources](https://nebiusglobalaihackathon.devpost.com/resources) | Participant credit form, activation code, and Builder Program. |

Deadline conversion: 30 October 2026 10:00 PDT is 31 October 2026 01:00 Asia/Singapore. Judging ends 15 December 2026 12:00 Pacific, which is 16 December 2026 04:00 Asia/Singapore. The different offsets reflect Pacific daylight versus standard time.

## WhatsApp

| ID | Primary source | Used for |
| --- | --- | --- |
| S5 | [Baileys introduction](https://baileys.wiki/) | Node.js library using the WhatsApp Web protocol over a WebSocket; QR/pairing authentication; explicitly unofficial status. |
| S6 | [Meta: onboard WhatsApp Business app users](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users) | Business coexistence is a separate mode; existing group chats are not synchronized. |
| S7 | [WhatsApp Help Center: click to chat](https://faq.whatsapp.com/5913398998672934) | Documented chat-opening behavior; no basis for promising arbitrary historical-message navigation from a captured message ID. |
| S23 | [Baileys QR authentication](https://baileys.wiki/authentication/qr-code) | Render the current connection QR and scan it in the owner's WhatsApp Linked Devices flow. |
| S24 | [Baileys session management](https://baileys.wiki/authentication/session-management) | Persist both credentials and Signal keys; durable keys.set; development-only nature of the simple multi-file store; database-backed auth interface. |
| S25 | [Baileys events](https://baileys.wiki/concepts/events) | Typed message batches, connection changes, history, update, and deletion events; inspect the installed release's types. |
| S26 | [Baileys history synchronization](https://baileys.wiki/advanced/history-sync) | Asynchronous initial history delivery and requests for additional history; configuration does not establish observed archive completeness. |
| S27 | [Baileys media messages](https://baileys.wiki/messaging/media-messages) | Separate media retrieval and supported message/media representations. |
| S28 | [Baileys socket configuration](https://baileys.wiki/concepts/socket-config) | Connection configuration, persisted auth, getMessage callback, and markOnlineOnConnect behavior. |
| S29 | [Baileys JIDs](https://baileys.wiki/concepts/jids) | Group/person identifiers and PN/LID aliases; retain stable ThreadMap identities when learned mappings change. |
| S30 | [Baileys installation](https://baileys.wiki/installation) | Public package installation, Node.js requirements, and distinction between released and edge builds. |
| S31 | [Baileys releases](https://github.com/WhiskeySockets/Baileys/releases) | Verify a maintained release, migration notes, and fixes before pinning the implementation dependency. |
| S32 | [Node.js downloads](https://nodejs.org/en/download) | Install the runtime without a Node.js service account; choose a supported LTS runtime and record its tested version. App users access the hosted browser interface and need no local runtime installation. |
| S33 | [Baileys incoming-message processing source](https://github.com/WhiskeySockets/Baileys/blob/master/src/Utils/process-message.ts) | Implementation reference for received edit/revoke processing; event handling must match the pinned release rather than assume master is installed. |

S6 and S7 provide background boundaries; the Business Platform is not the prototype connector. Meta/WhatsApp full-page retrieval was limited for some pages; the relevant statements were also checked against current official-domain indexed excerpts.

Baileys documentation and its repository may describe different release generations. Resolve and pin a compatible maintained release, then verify its installed types, auth adapter, identifier mappings, and actual event payloads. The recommendation of Node 24 LTS is a proposed implementation baseline, not a claim that every dependency combination has been tested.

No WhatsApp account was paired and no live connector test was performed while writing this handoff. Account-specific linking, history, media availability, and reconnect behavior remain implementation tests. The proposal does not claim complete history recovery, guaranteed uninterrupted service, Meta approval, or a working native historical-message deep link. The no-account requirement for Baileys/Node.js refers to installing a library/runtime; the owner still needs a WhatsApp account and the separate Nebius service credentials.

## Nebius cloud deployment

| ID | Primary source | Used for |
| --- | --- | --- |
| S34 | [Serverless AI overview](https://docs.nebius.com/serverless/overview) | Containerized applications on Endpoints versus finite processing/evaluation Jobs; managed underlying compute. |
| S35 | [Managing Serverless Endpoints](https://docs.nebius.com/serverless/endpoints/manage) | Custom image, exposed port, regular CPU platform/preset, subnet, secret injection, registry access, managed HTTPS URL, and replacement procedure. |
| S36 | [Endpoint quickstart](https://docs.nebius.com/serverless/quickstart/endpoints) | Deploying an ordinary HTTP server; IAM, compute/allocation quota, authentication, and endpoint access prerequisites. |
| S37 | [Stopping and restarting endpoints](https://docs.nebius.com/serverless/maintenance/stop-start) | Stop/start replaces the VM and loses local disk; URL survives stop/start but changes when an endpoint is deleted/recreated. |
| S38 | [Managed PostgreSQL quickstart](https://docs.nebius.com/postgresql/quickstart) and [database connections](https://docs.nebius.com/postgresql/databases/connect) and [cluster pooling](https://docs.nebius.com/postgresql/clusters/manage) | External persistent database, private cluster endpoint, verified TLS, and session/transaction pooling. |
| S39 | [Object Storage overview](https://docs.nebius.com/object-storage/overview) | Persistent objects/buckets and region-specific endpoint naming for the private media store. |
| S40 | [SecretStash overview](https://docs.nebius.com/mysterybox/overview) | Persistent encrypted secret storage and environment-variable injection into Endpoints/Jobs. CLI/API service identifier remains mysterybox. |
| S41 | [Serverless pricing and quotas](https://docs.nebius.com/serverless/pricing-quotas) | Compute-based running costs and quotas; attached storage charges remain separate. Cloud spending is separate from the Token Factory inference ledger. |
| S42 | [Managing Serverless Jobs](https://docs.nebius.com/serverless/jobs/manage) | Optional finite or scheduled batch workloads; P1 backfill/evaluation rather than the persistent live socket. |
| S43 | [Automatic job restarts](https://docs.nebius.com/serverless/jobs/auto-restarts) | Jobs can configure bounded restart behavior; that automatic-restart feature is unavailable to Endpoints. |
| S44 | [Nebius Tunnels overview](https://docs.nebius.com/tunnels/overview) | HTTPS transport and WebSocket support; tunnels do not add application-level authorization. Not a reason to expose companion or database ports. |
| S45 | [VPC routing overview](https://docs.nebius.com/vpc/routing/overview) | Default internet egress and internal routing; a separate custom NAT gateway is not a blanket prerequisite for the proposed endpoint. |
| S46 | [VPC network isolation](https://docs.nebius.com/vpc/networking/isolation) | Private connectivity within one network and separation between networks. Application authorization and database-role isolation remain necessary. |

These pages establish a supported container/HTTP deployment surface; they do not establish that this particular Baileys image has already run successfully. No cloud resources were provisioned, no WhatsApp account was linked, and no deployment or laptop-off test was run while preparing the proposal. The image, HTTP stream behavior, cloud egress, database TLS, secret injection, permissions, and endpoint recovery must be verified in A20.

The three-process supervisor, trusted-origin database bootstrap, private storage boundaries, and regular CPU sizing are ThreadMap design decisions. The coding agent must validate them against the selected region's actual resources and record the resulting endpoint ID, HTTPS URL, image digest, and nonsecret test evidence in `reports/cloud-deployment.json`. Never infer that a public URL is trustworthy from an incoming request header, or that a cloud resource is free because inference credits exist.

## Models and inference

| ID | Primary source | Used for |
| --- | --- | --- |
| S8 | [Nebius Token Factory quickstart](https://docs.tokenfactory.nebius.com/quickstart) | Canonical base URL and compatible JavaScript/Python client usage. |
| S9 | [Nebius agent cost benchmark cookbook](https://dev.nebius.com/cookbook/agent-cost-benchmark) | Current Ultra model identifier example; measurement-based cost/latency approach. |
| S10 | [Nebius Nemotron page](https://nebius.com/services/token-factory/nemotron) | Listed Nano/Super/Ultra family and Super identifier example. |
| S11 | [Official Nebius Nano cookbook](https://github.com/nebius/token-factory-cookbook/blob/main/models/nemotron/nemotron3-nano-30b.md) | Nano identifier example. |
| S12 | [Nebius model discovery API](https://docs.tokenfactory.nebius.com/api-reference/models/list-models) | Resolve the exact currently available model IDs for the account. |
| S13 | [Nebius structured output documentation](https://docs.tokenfactory.nebius.com/ai-models-inference/json) | JSON response options and model-specific capability checking. |

Published IDs are setup candidates. No authenticated request was made for this proposal; live discovery, capability checks, prices, quotas, and successful inference remain implementation tasks. Use the canonical global quickstart URL instead of copying a regional URL from a model example.

## Optional tools

| ID | Primary source | Used for |
| --- | --- | --- |
| S14 | [LangSmith sensitive trace controls](https://docs.langchain.com/langsmith/mask-inputs-outputs) | Input/output hiding, masking, and conditional tracing. |
| S15 | [Tavily Extract API](https://docs.tavily.com/documentation/api-reference/endpoint/extract) | Optional public-page extraction and success/failure response handling. |
| S16 | [Nebius Builder Program](https://dev.nebius.com/builders) | Partner offers and eligibility; inconsistent Toloka/Tandem descriptions. |
| S17 | [Nebius Toloka partner page](https://nebius.com/partner-catalog/toloka) | Toloka evaluation role and Tendem human-expert platform identity. |

The Builder Program's benefits and FAQ differ on the Toloka/Tandem bundle. Actual redemption must be confirmed in the user's account. “Tandem” in the request is interpreted as the sponsor-related Tendem product, not as an instruction to integrate an unrelated similarly named service.

## Implementation references

| ID | Primary source | Used for |
| --- | --- | --- |
| S18 | [React Flow mindmap tutorial](https://reactflow.dev/learn/tutorials/mind-map-app-with-react-flow) | Mindmap implementation foundation. |
| S19 | [pg-boss official repository](https://github.com/timgit/pg-boss) | Durable PostgreSQL-backed Node job queue. |
| S20 | [Better Auth email/password](https://better-auth.com/docs/authentication/email-password) and [PostgreSQL integration](https://better-auth.com/docs/adapters/postgresql) | Proposed session authentication implementation. |
| S21 | [pgvector official repository](https://github.com/pgvector/pgvector) | Optional later vector retrieval in PostgreSQL. |
| S22 | [Claude Code goal documentation](https://code.claude.com/docs/en/goal) | Completion-condition workflow and unchanged permission mode. |

Consult current official documentation when installing dependencies, then lock and record the tested versions. A proposal's reference to a feature does not replace a compatibility test in the actual project.
