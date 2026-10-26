#!/usr/bin/env bash
# ThreadMap → Nebius Serverless Endpoint (regular CPU). Reproducible, step-wise.
#
# Uses only Nebius CLI commands documented at docs.nebius.com (endpoint create/
# get/list/stop/start/delete, ai job create/logs, mysterybox secret create,
# registry configure-helper, msp postgresql cluster get-by-name). Run
# `nebius <cmd> --help` against your installed CLI before applying; the CLI's
# help output is authoritative over this script.
#
# Nothing here creates chargeable resources unless CONFIRM=yes is set.
# Usage: deploy/nebius/deploy.sh <validate|secrets|image|migrate|endpoint|url|bootstrap|owner|verify|restart-test|stop|start>
set -euo pipefail

STATE_DIR=${STATE_DIR:-deploy/nebius/.state}   # gitignored; nonsecret IDs only
mkdir -p "$STATE_DIR"
NEBIUS=${NEBIUS_CLI:-nebius}

req() { for v in "$@"; do [[ -n "${!v:-}" ]] || { echo "missing required env: $v" >&2; exit 2; }; done; }
confirm() { [[ "${CONFIRM:-}" == "yes" ]] || { echo "refusing to create/modify cloud resources without CONFIRM=yes" >&2; exit 3; }; }
save() { echo "$2" > "$STATE_DIR/$1"; }
load() { cat "$STATE_DIR/$1" 2>/dev/null || true; }

# Runtime secret keys injected with --env-secret KEY=<secret>; each KEY must be a payload key.
SECRET_NAME=${SECRET_NAME:-threadmap-runtime}
SECRET_KEYS=(DATABASE_URL COMPANION_DATABASE_URL WORKER_DATABASE_URL BETTER_AUTH_SECRET WHATSAPP_AUTH_ENCRYPTION_KEY NEBIUS_API_KEY S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY DATABASE_CA_CERT)
ADMIN_SECRET_NAME=${ADMIN_SECRET_NAME:-threadmap-admin}   # MIGRATION_DATABASE_URL, OWNER_PASSWORD

cmd=${1:-validate}
case "$cmd" in
validate)
  # Read-only: checks inputs and prints the resource plan. Creates nothing.
  command -v "$NEBIUS" >/dev/null || { echo "BLOCKED_EXTERNAL: Nebius CLI not installed (https://docs.nebius.com/cli/install)"; exit 4; }
  [[ -f ~/.nebius/config.yaml ]] || { echo "BLOCKED_EXTERNAL: no Nebius CLI profile (~/.nebius/config.yaml)"; exit 4; }
  req NEBIUS_CLOUD_REGION NEBIUS_CLOUD_SUBNET_ID NEBIUS_ENDPOINT_PLATFORM NEBIUS_ENDPOINT_PRESET NEBIUS_REGISTRY_PATH PG_CLUSTER_NAME S3_BUCKET INFRA_BUDGET_USD_PER_DAY
  cat <<EOF
ThreadMap resource plan (nothing created yet)
  region            : $NEBIUS_CLOUD_REGION
  endpoint          : ${NEBIUS_ENDPOINT_NAME:-threadmap} — regular CPU, platform $NEBIUS_ENDPOINT_PLATFORM, preset $NEBIUS_ENDPOINT_PRESET, port 3000 only
  subnet            : $NEBIUS_CLOUD_SUBNET_ID (same network as Managed PostgreSQL private RW endpoint)
  image             : cr.$NEBIUS_CLOUD_REGION.nebius.cloud/$NEBIUS_REGISTRY_PATH/threadmap@sha256:<digest after push>
  postgres          : $PG_CLUSTER_NAME (existing; private RW endpoint, sslmode verify-full, CA from msp-certs)
  object storage    : https://storage.$NEBIUS_CLOUD_REGION.nebius.cloud bucket $S3_BUCKET (private)
  secrets           : SecretStash '$SECRET_NAME' (${SECRET_KEYS[*]}) and '$ADMIN_SECRET_NAME'
  admin path        : one-off Serverless Jobs in the same subnet (migrate, bootstrap-origin, create-owner)
  budget (owner)    : \$$INFRA_BUDGET_USD_PER_DAY/day infrastructure; LLM caps are separate and do not bound cloud charges
EOF
  "$NEBIUS" msp postgresql v1alpha1 cluster get-by-name --name "$PG_CLUSTER_NAME" --format jsonpath='{.status.connection_endpoints.private_read_write}' >/dev/null \
    && echo "  ✓ postgres cluster visible" || echo "  ✗ postgres cluster not visible to this profile"
  "$NEBIUS" ai endpoint list >/dev/null && echo "  ✓ serverless endpoints API reachable" || echo "  ✗ cannot list endpoints"
  ;;

secrets)
  confirm
  req "${SECRET_KEYS[@]}"
  payload=$(node -e 'const ks=process.argv.slice(1);console.log(JSON.stringify(ks.map(k=>({key:k,string_value:process.env[k]}))))' "${SECRET_KEYS[@]}")
  "$NEBIUS" mysterybox secret create --name "$SECRET_NAME" --description "ThreadMap runtime secrets" --secret-version-payload "$payload"
  req MIGRATION_DATABASE_URL OWNER_PASSWORD
  apayload=$(node -e 'console.log(JSON.stringify(["MIGRATION_DATABASE_URL","OWNER_PASSWORD","DATABASE_CA_CERT"].map(k=>({key:k,string_value:process.env[k]}))))')
  "$NEBIUS" mysterybox secret create --name "$ADMIN_SECRET_NAME" --description "ThreadMap admin (migrations/bootstrap)" --secret-version-payload "$apayload"
  ;;

image)
  req NEBIUS_CLOUD_REGION NEBIUS_REGISTRY_PATH
  version=${IMAGE_VERSION:-$(git rev-parse --short=12 HEAD)}
  ref="cr.$NEBIUS_CLOUD_REGION.nebius.cloud/$NEBIUS_REGISTRY_PATH/threadmap:$version"
  "$NEBIUS" registry configure-helper
  docker build -t "$ref" .
  docker push "$ref"
  digest_ref=$(docker inspect --format '{{index .RepoDigests 0}}' "$ref")
  save image "$digest_ref"
  echo "immutable image: $digest_ref"
  ;;

migrate|bootstrap|owner)
  confirm
  req NEBIUS_CLOUD_SUBNET_ID NEBIUS_ENDPOINT_PLATFORM NEBIUS_ENDPOINT_PRESET
  image=$(load image); [[ -n "$image" ]] || { echo "run 'image' first" >&2; exit 2; }
  common=(--image "$image" --subnet-id "$NEBIUS_CLOUD_SUBNET_ID" --platform "$NEBIUS_ENDPOINT_PLATFORM" --preset "$NEBIUS_ENDPOINT_PRESET"
          --env APP_MODE=hosted --env-secret "DATABASE_CA_CERT=$ADMIN_SECRET_NAME" --env-secret "MIGRATION_DATABASE_URL=$ADMIN_SECRET_NAME")
  case "$cmd" in
    migrate)
      "$NEBIUS" ai job create --name "threadmap-migrate-$(date +%s)" "${common[@]}" \
        --env "TM_WEB_ROLE=${TM_WEB_ROLE:-}" --env "TM_COMPANION_ROLE=${TM_COMPANION_ROLE:-}" --env "TM_WORKER_ROLE=${TM_WORKER_ROLE:-}"         --container-command "sh" --args "-c 'DATABASE_URL=\$MIGRATION_DATABASE_URL node dist/cli/migrate.js && DATABASE_URL=\$MIGRATION_DATABASE_URL node dist/cli/apply-grants.js'" ;;
    bootstrap)
      url=$(load url); did=$(load deployment_id); [[ -n "$url" && -n "$did" ]] || { echo "run 'endpoint' and 'url' first" >&2; exit 2; }
      "$NEBIUS" ai job create --name "threadmap-bootstrap-$(date +%s)" "${common[@]}" --env "IMAGE_DIGEST=${image##*@}" \
        --container-command "sh" --args "-c 'DATABASE_URL=\$MIGRATION_DATABASE_URL node dist/cli/bootstrap-origin.js $did $url'" ;;
    owner)
      req OWNER_EMAIL
      "$NEBIUS" ai job create --name "threadmap-owner-$(date +%s)" "${common[@]}" --env "OWNER_EMAIL=$OWNER_EMAIL" --env-secret "OWNER_PASSWORD=$ADMIN_SECRET_NAME" \
        --container-command "sh" --args "-c 'DATABASE_URL=\$MIGRATION_DATABASE_URL node dist/cli/create-owner.js'" ;;
  esac
  echo "follow with: $NEBIUS ai job list  then  $NEBIUS ai job logs <job_ID> --follow"
  ;;

endpoint)
  confirm
  req NEBIUS_CLOUD_REGION NEBIUS_CLOUD_SUBNET_ID NEBIUS_ENDPOINT_PLATFORM NEBIUS_ENDPOINT_PRESET S3_BUCKET NEBIUS_MODEL_REASONING NEBIUS_MODEL_FAST NEBIUS_MODEL_BALANCED
  image=$(load image); [[ -n "$image" ]] || { echo "run 'image' first" >&2; exit 2; }
  did=$(load deployment_id); [[ -n "$did" ]] || { did="tm-$(openssl rand -hex 4)"; save deployment_id "$did"; }
  envs=(--env NODE_ENV=production --env APP_MODE=hosted --env PORT=3000 --env PUBLIC_ORIGIN_MODE=database_bootstrap --env "DEPLOYMENT_ID=$did"
        --env STORAGE_DRIVER=s3 --env "S3_ENDPOINT=https://storage.$NEBIUS_CLOUD_REGION.nebius.cloud" --env "S3_REGION=$NEBIUS_CLOUD_REGION" --env "S3_BUCKET=$S3_BUCKET"
        --env SOURCE_PROVIDER=baileys --env LLM_PROVIDER=nebius --env "NEBIUS_MODEL_REASONING=$NEBIUS_MODEL_REASONING" --env "NEBIUS_MODEL_FAST=$NEBIUS_MODEL_FAST"
        --env "NEBIUS_MODEL_BALANCED=$NEBIUS_MODEL_BALANCED" --env "NEBIUS_JSON_SCHEMA_ROLES=${NEBIUS_JSON_SCHEMA_ROLES:-}"
        --env ALLOW_PUBLIC_SIGNUP=false --env PUBLIC_DEMO_ENABLED=true --env PUBLIC_DEMO_PAIRING_ENABLED=false --env WHATSAPP_PAIRING_ENABLED=true
        --env MAP_DEFAULT_TOPIC_DEPTH=2 --env MAP_MAX_VISIBLE_NODES=200 --env MAP_CONTENT_PAGE_SIZE=50
        --env MAP_NODE_MIN_DIAMETER_PX=64 --env MAP_NODE_MAX_DIAMETER_PX=220 --env MAP_NODE_SIZE_REFERENCE_COUNT=10000
        --env "LLM_MAX_USD_PER_JOB=${LLM_MAX_USD_PER_JOB:-1.00}" --env "LLM_MAX_USD_PER_DAY=${LLM_MAX_USD_PER_DAY:-5.00}" --env "LLM_MAX_CALLS_PER_JOB=${LLM_MAX_CALLS_PER_JOB:-100}")
  for k in "${SECRET_KEYS[@]}"; do envs+=(--env-secret "$k=$SECRET_NAME"); done
  # No --auth token: the browser authenticates with ThreadMap sessions; a shared
  # Endpoint bearer token must never be placed in frontend code.
  "$NEBIUS" ai endpoint create --name "${NEBIUS_ENDPOINT_NAME:-threadmap}" --image "$image" --container-port 3000 \
    --container-command "node" --args "dist/supervisor.js" \
    --subnet-id "$NEBIUS_CLOUD_SUBNET_ID" --platform "$NEBIUS_ENDPOINT_PLATFORM" --preset "$NEBIUS_ENDPOINT_PRESET" --on-demand \
    ${NEBIUS_ENDPOINT_DISK_SIZE:+--disk-size "$NEBIUS_ENDPOINT_DISK_SIZE"} "${envs[@]}"
  echo "Now record the endpoint ID from '$NEBIUS ai endpoint list' with: echo <id> > $STATE_DIR/endpoint_id"
  ;;

url)
  id=${NEBIUS_ENDPOINT_ID:-$(load endpoint_id)}; [[ -n "$id" ]] || { echo "set NEBIUS_ENDPOINT_ID or $STATE_DIR/endpoint_id" >&2; exit 2; }
  url=$("$NEBIUS" ai endpoint get "$id" --format json | jq -r '.status.public_endpoints[] | select(startswith("https://"))' | head -1)
  [[ "$url" == https://* ]] || { echo "endpoint has no https URL yet" >&2; exit 5; }
  url=${url%/}; save url "$url"; save endpoint_id "$id"; echo "$url"
  ;;

verify)
  url=$(load url); [[ -n "$url" ]] || { echo "run 'url' first" >&2; exit 2; }
  node scripts/cloud-verify.mjs "$url" "$(load endpoint_id)" "$(load image)" "${NEBIUS_CLOUD_REGION:-}" "${NEBIUS_ENDPOINT_PRESET:-}"
  ;;

stop)  confirm; "$NEBIUS" ai endpoint stop --id "$(load endpoint_id)" ;;
start) confirm; "$NEBIUS" ai endpoint start --id "$(load endpoint_id)" ;;

restart-test)
  confirm
  id=$(load endpoint_id); url=$(load url)
  node scripts/cloud-verify.mjs "$url" "$id" "$(load image)" "${NEBIUS_CLOUD_REGION:-}" "${NEBIUS_ENDPOINT_PRESET:-}" --phase before-restart
  "$NEBIUS" ai endpoint stop --id "$id"
  "$NEBIUS" ai endpoint start --id "$id"
  for i in $(seq 1 60); do curl -fsS "$url/api/health/ready" >/dev/null 2>&1 && break; sleep 10; done
  node scripts/cloud-verify.mjs "$url" "$id" "$(load image)" "${NEBIUS_CLOUD_REGION:-}" "${NEBIUS_ENDPOINT_PRESET:-}" --phase after-restart
  ;;
*) echo "unknown command $cmd" >&2; exit 2 ;;
esac
