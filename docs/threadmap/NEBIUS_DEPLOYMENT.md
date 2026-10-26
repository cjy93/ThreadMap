# ThreadMap cloud deployment runbook

Version 2.2 — 25 October 2026 — implementation instructions, not an executed deployment.

## 1. Deployment decision

P0 runs on a **regular CPU Nebius Serverless Endpoint**. One custom container image supervises three separate Node.js processes: the Next.js web server, the Baileys companion, and the pg-boss analysis worker. Nemotron 3 Ultra, Nano, and Super remain hosted behind the **Nebius Token Factory API**. The application does not need a GPU to call that API.

Nebius documents Endpoints for serving applications, a managed HTTPS URL, CPU configurations, and a lifetime that continues until stopped. Container disk contents disappear on stop or deletion. These properties support this design but do not guarantee uninterrupted service. [S34–S37]

All durable state lives outside the container: Nebius Managed PostgreSQL stores source messages, recursive graph versions and memberships, review state, per-user/chat depth preferences, refinement checkpoints, queues, configuration, and encrypted WhatsApp authentication; private Object Storage stores cached files. SecretStash supplies secrets. [S38–S40]

Users open a hosted URL and scan a QR with their existing WhatsApp app. They need **no Node.js installation, Node.js account, Baileys account, or laptop-resident companion**. Closing the browser or shutting down the laptop does not stop the cloud runtime. Local Compose is for development and cannot satisfy the cloud completion gate.

## 2. Owner prerequisites

Before creating chargeable resources, obtain the owner's chosen infrastructure budget, target project, region, and authorized deployment identity. Prepare a resource plan and validation/dry-run output before applying it. Never assume Token Factory promotional credits pay for AI Cloud compute, PostgreSQL, storage, or networking.

The owner supplies:

- Nebius AI Cloud project access and an eligible balance, with quotas for the selected CPU Endpoint and supporting services.
- Token Factory API access, selected model roles, and an inference spending limit.
- A container registry and permissions to publish/read the application image.
- WhatsApp pairing access and harmless test conversations.
- An authorized administrative connection method for deployment/bootstrap work.

Resolve available CPU platform/preset and region from the current account. Record estimates and actual observed charges separately; continuous Endpoint operation incurs running-resource charges. [S41] This runbook authorizes no purchase or deployment by itself.

## 3. Provision durable services and network access

Create Managed PostgreSQL and a private Object Storage bucket in the chosen supported region. Use the PostgreSQL **private read-write endpoint**, validate its TLS certificate and hostname, and install the documented CA. Do not disable verification. [S38]

Configure session pooling or a direct session-preserving database connection for the companion's advisory lock and any session-dependent queue/listener behavior. Do not silently substitute transaction pooling. Validate lock ownership and connection loss behavior against the deployed database. Use a separate migration identity; runtime roles receive only required database privileges.

Run schema migrations under a migration lock before activating the new application. Store files through the Object Storage API, with private objects and authorized application access. SQLite, container-local PostgreSQL, and session files on the container disk are not acceptable sole stores.

The v2.1 application schema supports recursively parented topics and all-depth ancestor-content queries. If an earlier shallow implementation exists, migrate it without changing canonical source/review IDs or discarding topic overrides. Persist Show depth preferences and unfinished taxonomy frontiers in PostgreSQL; container/browser memory is not their authoritative store. Configure MAP_DEFAULT_TOPIC_DEPTH=2, MAP_MAX_VISIBLE_NODES=200, and MAP_CONTENT_PAGE_SIZE=50 as view defaults, never as a taxonomy depth cap.

For v2.2, derive distinct matching node-message counts from the authorized durable source/membership/review state, and derive visual size from those counts. A browser count or persisted pixel diameter is not authoritative. Deploy the same shared sizing configuration for the web/API: MAP_NODE_MIN_DIAMETER_PX=64, MAP_NODE_MAX_DIAMETER_PX=220, and MAP_NODE_SIZE_REFERENCE_COUNT=10000. Validate the configuration and record its revision with release evidence. These are presentation bounds, not retention or processing limits. Recompute identical counts/sizes after restart when memberships, filters, reviews, and configuration are unchanged; cache invalidation must include their relevant versions.

Validate outbound DNS, HTTPS, and WhatsApp WebSocket connectivity from the actual Endpoint. Validate private SQL and storage access independently. A managed inbound HTTPS URL does not prove outbound connectivity. Configure supported egress routing where required; do not invent a managed NAT feature or expose the database publicly as a shortcut. [S44–S46]

## 4. Secrets and WhatsApp custody

Use SecretStash for the database credential, Token Factory key, application authentication secret, storage credentials, and a stable WhatsApp-auth encryption key. Current tooling retains the `mysterybox` identifier although the product is named SecretStash. [S40]

Encrypt Baileys credentials and Signal-key updates before durable database storage. Preserve the encryption key through restarts and deployments; generating a new one at every boot makes saved sessions unreadable. Restrict decryption to the companion's application path. Persist key updates correctly and test restoration.

Supply each child process an environment allowlist. This reduces accidental exposure but **does not make processes in one container security-isolated**. Treat the entire image and container as trusted. Never expose secrets, QR payloads, private message bodies, or serialized Baileys events in browser bundles, logs, diagnostics, or acceptance reports.

Cloud pairing places the linked-device credentials under the application's custody. The authenticated pairing screen explains this and the selected-chat processing destination. The companion remains an unofficial integration; cloud hosting does not change that status.

## 5. Build and create the Endpoint

Build a tested image, publish a versioned release, and record its immutable `image@sha256:…` digest. Include a parent supervisor that starts web, companion, and worker, forwards termination signals, reaps children, and applies bounded child restart backoff. The worker consumes durable PostgreSQL jobs; it is never a request-owned background promise.

Expose only the web application's required HTTP port. Keep companion commands internal through PostgreSQL. The browser authenticates with ThreadMap sessions; do not place a shared Nebius Endpoint bearer token in frontend code. If infrastructure bearer protection is added, a server-side proxy must hold that token. Every private application route still checks authorization.

Use the current Nebius CLI/API documentation and inspect installed command help when generating manifests and deployment scripts. Do not invent flags, resource identifiers, or availability. Keep the confirmed resource plan, image digest, and secret references reproducible; never commit secret values. [S35, S36]

## 6. Bootstrap the real public origin

The managed HTTPS URL is known only after Endpoint creation, while Endpoint configuration changes may require recreation. Avoid an endless recreate-to-change-`APP_URL` cycle. [S35]

Implement this sequence:

1. Create the Endpoint with `PUBLIC_ORIGIN_MODE=database_bootstrap` and a deployment ID. Initially expose health/status only; disable sign-in, pairing, and functional activation.
2. An authorized deployment CLI retrieves the actual HTTPS URL from that Endpoint's control-plane metadata and verifies the expected project and resource identity.
3. Through a supported authenticated administrative execution/SSH path, run the bootstrap command inside the private network. It writes the validated origin into `runtime_settings`, scoped to that deployment ID. The deployment laptop must not be assumed to reach private PostgreSQL directly.
4. The application periodically reloads this setting, initializes Better Auth with that exact trusted origin, and becomes ready. Log only a nonsecret configuration status.
5. Test sign-in, cookies, redirects, CSRF/origin checks, pairing access, and streaming updates at the real URL.

There is no anonymous setup endpoint and no trust in arbitrary `Host` or forwarded-host headers. An optional `APP_URL` override is allowed only for an already known, verified HTTPS origin. An existing custom domain is optional and must be verified before use.

## 7. Continuous operation and recovery

Acquire a database-backed account lease before opening the WhatsApp session. A second companion must fail to acquire it. On lease loss, close the socket and stop account mutations. Persist source events before inference; preserve idempotency across replay, reconnect, and worker retries.

Use readiness and heartbeat checks for web, companion, worker, and database. Show connection coverage separately from analysis backlog. Bounded child restarts handle recoverable process failures. Do not claim that Nebius automatically restarts a failed Endpoint; document operator alerts and the actual restart procedure. [S37, S43]

For an Endpoint failure, inspect nonsecret status/logs, correct the cause, start or recreate the resource through the supported control plane, and verify lease acquisition and session recovery. Expired WhatsApp credentials require owner pairing; repeated blind restarts do not repair them. A stopped Endpoint does not ingest messages, and later history recovery is not guaranteed complete.

## 8. Releases, migrations, and rollback

Endpoint settings are not generally editable in place. For a digest-pinned release, create a replacement with the new configuration and bootstrap its new URL. [S35]

Keep migrations compatible with the retained rollback release where practical. Stop the old companion and release its lease before activating the new one. Verify that only one account session owner is active throughout cutover. Preserve the previous Endpoint's identity and image for rollback, but keep it stopped rather than leaving duplicate paid runtimes active.

If rollback is needed, stop the new companion, restore the supported prior deployment, confirm database compatibility, and repeat connection/source checks. Record the current user-facing URL. Do not delete durable databases, auth rows, or buckets as part of routine application replacement.

## 9. Public demonstration and optional Jobs

P0 may serve `/demo` from the same application to control cost. Guests receive isolated synthetic workspaces and review state. Pairing, private accounts' messages, files, jobs, and session metadata remain inaccessible. A separate demo Endpoint is optional, not a completion requirement.

Serverless **Jobs are P1**, for bounded backfill analysis, taxonomy rebuilds, or evaluation. They are not the WhatsApp connection owner or a job-per-message mechanism. If added, persist external job IDs, checkpoints, idempotency keys, budgets, and results; reconcile uncertain submissions before retrying. Jobs terminate and discard container storage. [S42, S43]

## 10. Evidence and completion

Write `reports/cloud-deployment.json` with nonsecret Endpoint ID, region, image digest, actual HTTPS URL, deployment timestamp, relevant configuration versions, and observed results. Include cloud tests showing:

- A separate device can use the hosted application.
- Genuine selected-chat events and real Nemotron processing work with the development laptop runtime stopped.
- Browser closure does not stop ingestion.
- Endpoint restart restores persisted sources, recursive graph/memberships, depth preferences, review state, refinement frontier/queue, cached files, and a still-valid WhatsApp session.
- The hosted map/outline can show a shallow depth while opening a deep descendant's exact message/file from an ancestor; depth changes preserve matching counts and use no model calls.
- The hosted mindmap sizes nodes from complete distinct filtered memberships, including hidden descendants. Filter changes and committed live additions/reviews/removals refresh the exact badge and bounded size without model calls, overlap, or camera reset. Restart reconstructs the same sizes for unchanged state; graph pagination and Show depth do not rescale them.
- Duplicate companion ownership is rejected; public guests cannot access private data.
- SQL, storage, egress, source arrival, and analysis progress are separately verified.

These are **A20** evidence requirements. A18 separately proves real inference, and A19 proves real WhatsApp linking/events. `BUILD_READY` requires all **A01–A20**; local success, a dry run, or an unexecuted deployment recipe cannot pass the cloud gate. Missing credentials, quota, budget, pairing, or reachable resources produce `BLOCKED_EXTERNAL` after independent work is complete. Mark every unrun check accurately. No deployment or test in this document has already passed.
