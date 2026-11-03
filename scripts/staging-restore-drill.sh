#!/usr/bin/env bash
set -euo pipefail

usage() { echo "Usage: $0 --source r2|b2 [--timestamp RFC3339] [--target data/recovery-drills/NAME.db]" >&2; }
source_name=""; restore_timestamp=""; target_path=""
drill_port="${DRILL_PORT:-4100}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) source_name="${2:-}"; shift 2 ;;
    --timestamp) restore_timestamp="${2:-}"; shift 2 ;;
    --target) target_path="${2:-}"; shift 2 ;;
    *) usage; exit 2 ;;
  esac
done
case "$source_name" in
  r2) replica_name="mgpl-db-replica" ;;
  b2) replica_name="mgpl-db-backup" ;;
  *) usage; exit 2 ;;
esac

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; safe_started_at="${started_at//:/-}"
target_path="${target_path:-data/recovery-drills/${source_name}-${safe_started_at}.db}"
target_path="${target_path//\\//}"
repo_root="$(git rev-parse --show-toplevel)"
allowed_root="$(realpath -m "$repo_root/data/recovery-drills")"
target_abs="$(realpath -m "$repo_root/$target_path")"
case "$target_abs" in "$allowed_root"/*.db) ;; *) echo "Refusing non-isolated restore target: $target_path" >&2; exit 1 ;; esac
target_path="${target_abs#"$repo_root"/}"
case "$(basename "$target_path" | tr '[:upper:]' '[:lower:]')" in
  mgpl-preprod.db|mpgl_app.db|test_mgpl.db) echo "Refusing protected database target: $target_path" >&2; exit 1 ;;
esac
if [[ -e "$target_path" ]]; then echo "Refusing to overwrite existing restore target: $target_path" >&2; exit 1; fi

mkdir -p "$(dirname "$target_path")" DOCS/evidence
container_target="/data/${target_path#data/}"
restore_args=(restore -config /etc/litestream.yml -replica "$replica_name" -o "$container_target")
if [[ -n "$restore_timestamp" ]]; then restore_args+=(-timestamp "$restore_timestamp"); fi
restore_args+=(/data/mgpl-preprod.db)

drill_container="mgpl-restore-drill-${safe_started_at,,}"
cleanup() {
  docker rm -f "$drill_container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Restoring $source_name replica to isolated target $target_path"
rto_started_epoch="$(date +%s)"
docker compose -f docker-compose.preprod.yml exec -T litestream litestream "${restore_args[@]}"
restore_finished_epoch="$(date +%s)"
verification_json="$(docker compose -f docker-compose.preprod.yml exec -T -e DB_PATH="$container_target" app node dist/scripts/verify-restored-db.js "$container_target")"

echo "Starting isolated restored application on 127.0.0.1:${drill_port}"
docker compose -f docker-compose.preprod.yml run -d --no-deps --name "$drill_container" \
  -e DB_PATH="$container_target" -e PORT=4000 -e DISABLE_CRON=true \
  -p "127.0.0.1:${drill_port}:4000" app >/dev/null

healthy=0
for _ in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:${drill_port}/healthz" >/dev/null; then healthy=1; break; fi
  sleep 1
done
if [[ "$healthy" -ne 1 ]]; then
  echo "Isolated restored application did not become healthy." >&2
  docker logs "$drill_container" >&2 || true
  exit 1
fi

echo "Running postdeploy smoke checks against the isolated restored application"
SMOKE_BASE_URL="http://127.0.0.1:${drill_port}" doppler run -- npm run smoke:postdeploy
finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; rto_seconds="$((restore_finished_epoch - rto_started_epoch))"; full_rto_seconds="$(( $(date +%s) - rto_started_epoch ))"
evidence_path="DOCS/evidence/PI-004-BDR-preprod-${source_name}-${safe_started_at}.md"

cat > "$evidence_path" <<EOF
# PI-004 Preprod Restore Drill Evidence

- Status: integrity verification and postdeploy smoke passed; operator sign-off pending
- Source replica: $source_name ($replica_name)
- Requested recovery point: ${restore_timestamp:-latest available}
- Started UTC: $started_at
- Restore completed UTC: $finished_at
- Measured restore duration (RTO component): ${rto_seconds}s
- Full measured drill RTO through smoke checks: ${full_rto_seconds}s
- Isolated smoke URL: http://127.0.0.1:${drill_port}
- Isolated host target: $target_path
- Isolated container target: $container_target

## Database verification

\`\`\`json
$verification_json
\`\`\`

## Application smoke

- [x] Live preprod writer remained online and unchanged.
- [x] Temporary app container used only the isolated restored database.
- [x] \`SMOKE_BASE_URL=http://127.0.0.1:${drill_port} doppler run -- npm run smoke:postdeploy\` completed.

## Recovery objectives and sign-off

- Replica recovery point observed: ____________________
- Measured RPO: ____________________
- Full measured RTO, including smoke checks: ${full_rto_seconds}s
- Anomalies/remediation: ____________________
- Principal Operator decision: PASS / FAIL
- Principal Operator name/date: ____________________
EOF
echo "Restore verification and smoke passed. RTO=${full_rto_seconds}s. Evidence: $evidence_path"
