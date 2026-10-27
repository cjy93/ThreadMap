# Deploying ThreadMap on a Nebius Serverless Endpoint

Implements `docs/threadmap/NEBIUS_DEPLOYMENT.md`. **Not yet executed** against a real account (see `reports/cloud-deployment.json`). Every step that creates or changes cloud resources requires `CONFIRM=yes`; `validate` is read-only.

## 0. Owner prerequisites

1. Nebius AI Cloud project with billing, CPU Endpoint quota and an **infrastructure budget** (`INFRA_BUDGET_USD_PER_DAY`). Token Factory credits do not pay for Endpoint/DB/storage.
2. Nebius CLI installed and authenticated (`~/.nebius/config.yaml` holds the project ID) — https://docs.nebius.com/cli/install.
3. In one region and network:
   - **Managed PostgreSQL** cluster (`PG_CLUSTER_NAME`) with a migration user and, optionally, three runtime users (`TM_WEB_ROLE`, `TM_COMPANION_ROLE`, `TM_WORKER_ROLE`). Use the **private read-write endpoint**: `nebius msp postgresql v1alpha1 cluster get-by-name --name <cluster> --format jsonpath='{.status.connection_endpoints.private_read_write}'`. Download the CA from `https://storage.eu-north1.nebius.cloud/msp-certs/ca.pem`; connection URLs use port 5432. ThreadMap verifies the certificate and hostname itself (`DATABASE_CA_CERT`); do not use transaction pooling for the companion (session advisory lock).
   - **Private Object Storage bucket** (`S3_BUCKET`) and an access key pair for it. Endpoint: `https://storage.<region>.nebius.cloud`.
   - **Container Registry** (`NEBIUS_REGISTRY_PATH` = registry ID without `registry-`). `nebius registry configure-helper` configures Docker.
   - A **subnet** (`NEBIUS_CLOUD_SUBNET_ID`) with default internet egress (WhatsApp WSS + Token Factory HTTPS).
   - CPU **platform/preset** (`NEBIUS_ENDPOINT_PLATFORM`, `NEBIUS_ENDPOINT_PRESET`), e.g. `cpu-d3` / `4vcpu-16gb` as in the Nebius quickstart — confirm availability in your region.
4. Token Factory API key, then `npm run models:discover` to resolve exact `NEBIUS_MODEL_REASONING/FAST/BALANCED` and `NEBIUS_JSON_SCHEMA_ROLES`.

## 1. Plan and validate (read-only)

```bash
export NEBIUS_CLOUD_REGION=... NEBIUS_CLOUD_SUBNET_ID=... NEBIUS_ENDPOINT_PLATFORM=... NEBIUS_ENDPOINT_PRESET=... \
       NEBIUS_REGISTRY_PATH=... PG_CLUSTER_NAME=... S3_BUCKET=... INFRA_BUDGET_USD_PER_DAY=...
deploy/nebius/deploy.sh validate
```

## 2. Secrets (SecretStash, CLI id `mysterybox`)

Generate once with `npm run secrets:generate` and **retain** them (a new `WHATSAPP_AUTH_ENCRYPTION_KEY` makes saved sessions unreadable). Export the values below in your shell, then:

```bash
# runtime: DATABASE_URL COMPANION_DATABASE_URL WORKER_DATABASE_URL BETTER_AUTH_SECRET WHATSAPP_AUTH_ENCRYPTION_KEY
#          NEBIUS_API_KEY S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY DATABASE_CA_CERT
# admin:   MIGRATION_DATABASE_URL
CONFIRM=yes deploy/nebius/deploy.sh secrets
```

Each runtime variable is injected with `--env-secret KEY=threadmap-runtime`; the supervisor passes each secret only to the child that needs it (web: auth secret + web DB URL; companion: encryption key + companion DB URL; worker: Token Factory key + worker DB URL). This is accidental-exposure reduction, not process isolation.

## 3. Image (immutable digest)

```bash
deploy/nebius/deploy.sh image        # build, push, record cr.<region>.nebius.cloud/<registry>/threadmap@sha256:…
```

## 4. Database (in-network Serverless Jobs)

```bash
CONFIRM=yes TM_WEB_ROLE=... TM_COMPANION_ROLE=... TM_WORKER_ROLE=... deploy/nebius/deploy.sh migrate
nebius ai job list ; nebius ai job logs <job_ID> --follow
```

## 5. Endpoint (bootstrap mode)

```bash
CONFIRM=yes NEBIUS_MODEL_REASONING=... NEBIUS_MODEL_FAST=... NEBIUS_MODEL_BALANCED=... deploy/nebius/deploy.sh endpoint
nebius ai endpoint list                      # copy the ID
echo <endpoint_ID> > deploy/nebius/.state/endpoint_id
deploy/nebius/deploy.sh url                  # reads .status.public_endpoints (https) from `ai endpoint get --format json`
```

Created with `PUBLIC_ORIGIN_MODE=database_bootstrap`, a fresh `DEPLOYMENT_ID`, port 3000 only, the digest-pinned image, `--on-demand`, no `--auth token`. Until step 6 only health/status respond; sign-in and pairing return 503.

## 6. Trusted-origin bootstrap and owner

```bash
CONFIRM=yes deploy/nebius/deploy.sh bootstrap        # Job writes the observed https origin for this DEPLOYMENT_ID
CONFIRM=yes OWNER_EMAIL=you@example.com deploy/nebius/deploy.sh owner
deploy/nebius/deploy.sh verify                       # writes reports/cloud-deployment.json
```

The web process reloads `runtime_settings` every 15 s and then initializes Better Auth with exactly that origin.

## 7. Live acceptance (owner-operated)

1. From another device, open the URL, sign in, **Connect WhatsApp**, scan the QR in WhatsApp → Linked Devices.
2. Select a test group and an individual chat; leave a third chat unselected. Send harmless messages from the phone and receive some; they appear without refresh.
3. Close the browser and turn the laptop off; send more messages from the phone; reopen later from another device and confirm they were captured and analyzed.
4. `OWNER_EMAIL=... OWNER_PASSWORD=... CONFIRM=yes deploy/nebius/deploy.sh restart-test` — snapshots counts/sizes, stops and starts the Endpoint, waits for readiness and compares (`restart_reconstruction` in the report). The WhatsApp session must resume without a new QR.

## Operations, recovery and rollback

- **Health:** `GET /api/health/live` (process up) and `/api/health/ready` (database, origin, companion and worker heartbeats). Point an external uptime monitor at `/api/health/ready`; Nebius does not auto-restart Endpoints.
- **Child failure:** the supervisor restarts a child with exponential backoff; >8 restarts in 10 min exits the container so the failure is visible.
- **Endpoint failure:** inspect status/logs, fix the cause, `deploy/nebius/deploy.sh start` (same URL) or recreate (new URL ⇒ repeat bootstrap). Expired WhatsApp credentials need the owner to pair again; blind restarts do not fix them. While stopped, nothing is ingested; history recovery afterwards is best effort and the UI shows the gap.
- **Release:** build a new digest, create a replacement Endpoint, bootstrap its URL, verify readiness, then `stop` the old Endpoint (its companion releases the lease) before the new companion acquires it. Keep the old Endpoint stopped for rollback; never delete databases, auth rows or buckets during replacement.
- **Rollback:** stop the new Endpoint, start the previous one, confirm migration compatibility, re-run `verify`.
- **Cost:** a running Endpoint, PostgreSQL and storage all bill continuously; judging access is required until 16 Dec 2026 04:00 SGT.
