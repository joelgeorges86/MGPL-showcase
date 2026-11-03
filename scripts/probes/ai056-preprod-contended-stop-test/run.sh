#!/usr/bin/env bash
# Tests for the AI-056 preprod contended-stop probe. No Docker, no network, no
# preprod: the driver runs against stub `docker`, `timeout` and `sleep` (bin/), and
# the helper runs under node with its observations stubbed (helper-cases.mjs).
#
#   bash scripts/probes/ai056-preprod-contended-stop-test/run.sh
#
# Every assertion is tagged:
#   B  behaviour: the defect itself. Exit code; which side-effecting docker calls
#      were made (run, kill, stop, start); finishing within the case bound (no
#      hang); no Docker socket handed to the helper; RESULT saying pass exactly
#      when the exit code is 0; STATE making no false claim (checked with patterns
#      that also match older wordings, so an old claim of "released" is caught).
#   F  format: the current output contract. RESULT's code= token, the exact failed
#      list, and STATE's key=value tokens.
# A case fails if any assertion fails; the tags show whether it failed for a defect
# or only for a changed format. Exits nonzero if any case fails.
set -u
D=$(cd "$(dirname "$0")" && pwd)
DRIVER=${DRIVER:-"$D/../ai056-preprod-contended-stop-driver.sh"}
REAL_SLEEP=$(command -v sleep); export REAL_SLEEP
REAL_TIMEOUT=$(command -v timeout); export REAL_TIMEOUT
chmod +x "$D/bin/"* 2>/dev/null
export PATH="$D/bin:$PATH"
WORK=$(mktemp -d)
FAILED=0 PASSED=0 FAILED_B=0

preprod() {
  export F_DC=preprod F_PROJ=mgpl-preprod F_DB=/data/mgpl-preprod.db F_SRC=/opt/mgpl/data-preprod F_NET=mgpl-preprod_default
  export F_HEALTH=healthy F_XC=0 F_HELPER=send F_HRC=0 F_STOPRC=0 F_STARTRC=0 F_HZRC=0
  export F_HZ='{"status":"healthy","database":"connected"}'
  unset F_INSPECT_FAILS F_INSPECT_GARBAGE F_INSPECT_HANG F_UNHEALTHY_AFTER_START F_KILL_FAILS F_STOP_HANG F_CONTAINER_OUTLIVES_CLIENT
}

# case_ NAME CODE CALLS MUST_CLAIM MUST_NOT_CLAIM FAILED [N] [B64]
#   CALLS           side-effecting docker verbs in order, e.g. "run stop start", or "-"
#   MUST_CLAIM      F: regex the STATE line must match (current tokens)
#   MUST_NOT_CLAIM  B: regex the STATE line must not match (false claims), or ""
#   FAILED          F: the RESULT line's failed: list exactly (anchored regex), "" for none
case_() {
  local name=$1 want=$2 calls=$3 must=$4 mustnot=$5 wantfailed=$6 n=${7-65} b64=${8-eA==}
  export CALLS="$WORK/$name.calls"; : > "$CALLS"; rm -f "$CALLS".*
  local out rc got state result gotfailed b="" f=""
  out=$({ echo "B64=$b64"; cat "$DRIVER"; } | "$REAL_TIMEOUT" -k 5 120 bash -s -- "$n" 2>&1); rc=$?
  got=$(grep -o -E '^(run|kill|stop|start)' "$CALLS" | tr '\n' ' ' | sed 's/ $//'); got=${got:--}
  state=$(echo "$out" | grep '^STATE' | tail -1)
  result=$(echo "$out" | grep '^RESULT' | tail -1)
  if [ "$rc" = 124 ] || [ "$rc" = 137 ]; then b="$b hung(case bound 120 s)"; fi
  [ "$rc" = "$want" ] || b="$b exit=$rc(want $want)"
  [ "$got" = "$calls" ] || b="$b calls='$got'(want '$calls')"
  grep -q -E '^run .*docker\.sock' "$CALLS" && b="$b helper-given-docker-socket"
  if [ "$rc" = 0 ]; then echo "$result" | grep -q '^RESULT pass' || b="$b exit-0-but-RESULT-not-pass"
  else echo "$result" | grep -q '^RESULT pass' && b="$b RESULT-pass-but-exit-$rc"; fi
  if [ -n "$mustnot" ] && echo "$state" | grep -q -i -E "$mustnot"; then b="$b false-STATE-claim(/$mustnot/)"; fi
  [ "$(echo "$result" | sed -n 's/.* code=\([0-9]*\).*/\1/p')" = "$rc" ] || f="$f RESULT-code-token"
  gotfailed=$(echo "$result" | sed -n 's/.* failed: *//p')
  echo "$gotfailed" | grep -q -x -E "$wantfailed" || f="$f failed='$gotfailed'(want /$wantfailed/)"
  echo "$state" | grep -q -E "$must" || f="$f STATE-tokens(want /$must/)"
  if [ -z "$b$f" ]; then PASSED=$((PASSED + 1)); printf 'PASS  %-44s exit=%s calls=%s\n' "$name" "$rc" "$got"
  else
    FAILED=$((FAILED + 1)); [ -n "$b" ] && FAILED_B=$((FAILED_B + 1))
    printf 'FAIL  %-44s%s%s\n' "$name" "${b:+ B:$b}" "${f:+ F:$f}"
    [ -n "${VERBOSE:-}" ] && echo "$out" | sed 's/^/      | /'
  fi
}

UNTOUCHED='app_stopped=no .*helper=never-started account=no lock=not-taken'
# Claims that are false whenever the helper's container may still be running.
CLAIMS_RELEASE='released|not-held|not.taken'
# Claims that no account exists, in the current and the older wording.
CLAIMS_NO_ACCOUNT='account=no|account created: no'
ALL5='target-DOPPLER_CONFIG target-compose_project target-DB_PATH target-data_mount_source target-network'

echo "== driver"
preprod;                                   case_ pass                                0 "run stop start" 'app_stopped=yes app_now=running/healthy helper=gone account=yes lock=not-held' 'may-be-held|unknown' ""
preprod; export F_XC=143;                  case_ container-exit-143-passes           0 "run stop start" 'helper=gone account=yes lock=not-held' "" ""
# target not preprod: exit 3, nothing touched
preprod; export F_DC=prd F_PROJ=mgpl F_DB=/app/data/mpgl_app.db F_SRC=/opt/mgpl/data F_NET=mgpl_default
                                           case_ target-production-like              3 - "$UNTOUCHED" "" "$ALL5"
preprod; export F_DC=test F_PROJ=mgpl-test F_DB=/data/mgpl-test.db F_SRC=/opt/mgpl/data-test F_NET=mgpl-test_default
                                           case_ target-test-env                     3 - "$UNTOUCHED" "" "$ALL5"
preprod; export F_INSPECT_FAILS=1;         case_ target-inspect-fails-entirely       3 - 'app_stopped=no app_now=unknown helper=never-started account=no lock=not-taken' "" "$ALL5"
preprod; export F_INSPECT_GARBAGE=1;       case_ target-inspect-malformed-output     3 - "$UNTOUCHED" "" "$ALL5"
preprod; export F_INSPECT_HANG=1;          case_ target-inspect-hangs                3 - 'app_stopped=no app_now=unknown helper=never-started' "" "$ALL5"
preprod; unset F_DC;                       case_ target-doppler-config-absent        3 - "$UNTOUCHED" "" "target-DOPPLER_CONFIG"
preprod; export F_DC=;                     case_ target-doppler-config-empty         3 - "$UNTOUCHED" "" "target-DOPPLER_CONFIG"
preprod; export F_PROJ='<no value>';       case_ target-project-no-value             3 - "$UNTOUCHED" "" "target-compose_project"
preprod; export F_DC='<no value>' F_DB='<no value>' F_SRC='<no value>' F_NET='<no value>'
                                           case_ target-four-no-value                3 - "$UNTOUCHED" "" "target-DOPPLER_CONFIG target-DB_PATH target-data_mount_source target-network"
preprod; export F_DC=preprod-2;            case_ target-near-doppler-preprod-2       3 - "$UNTOUCHED" "" "target-DOPPLER_CONFIG"
preprod; export F_DC=Preprod;              case_ target-near-doppler-case            3 - "$UNTOUCHED" "" "target-DOPPLER_CONFIG"
preprod; export F_PROJ=mgpl-preprod-2;     case_ target-near-project                 3 - "$UNTOUCHED" "" "target-compose_project"
preprod; export F_DB=/data/mgpl-preprod.db.bak; case_ target-near-db-path            3 - "$UNTOUCHED" "" "target-DB_PATH"
preprod; export F_SRC=/opt/mgpl/data-preprod2;  case_ target-near-mount-source       3 - "$UNTOUCHED" "" "target-data_mount_source"
preprod; export F_NET=mgpl-preprod_default2;    case_ target-near-network            3 - "$UNTOUCHED" "" "target-network"
preprod; export F_NET="mgpl-preprod_default other"; case_ target-extra-network      3 - "$UNTOUCHED" "" "target-network"
# preconditions: exit 4, nothing touched
preprod;                                   case_ precondition-bad-n                  4 - "$UNTOUCHED" "" 'profile-count-not-a-positive-integer\(abc\)' abc
preprod;                                   case_ precondition-no-helper-script       4 - "$UNTOUCHED" "" "helper-script-not-prepended" 65 ""
preprod; export F_HEALTH=unhealthy;        case_ precondition-app-unhealthy          4 - "$UNTOUCHED" "" "app-not-healthy"
# helper started, did not send: exit 5, app never stopped. For a hung helper the exit
# detail depends on which bound fires first (the kill, or the docker run bound), so
# it is not pinned.
preprod; export F_HELPER=refuse;           case_ helper-refuses                      5 "run" 'app_stopped=no .*helper=gone account=no lock=not-held' "" 'helper-did-not-send-request\(exit=2\)'
preprod; export F_HELPER=hang-before-register; case_ helper-hangs-before-register    5 "run kill" 'app_stopped=no .*helper=gone account=no lock=not-held' "" 'helper-did-not-send-request\(exit=[^)]*\)'
preprod; export F_HELPER=attempt-then-hang;    case_ helper-hangs-after-register-attempt 5 "run kill" 'helper=gone account=unknown lock=not-held' "$CLAIMS_NO_ACCOUNT" 'helper-did-not-send-request\(exit=[^)]*\)'
preprod; export F_HELPER=locked-then-hang F_KILL_FAILS=1
                                           case_ helper-holds-lock-and-kill-fails    5 "run kill" 'app_stopped=no .*helper=running account=yes lock=may-be-held' "$CLAIMS_RELEASE" 'helper-did-not-send-request\(exit=[^)]*\)'
# after the stop: exit 1
preprod; export F_STOPRC=1;                case_ after-stop-rc-nonzero               1 "run stop start" 'app_stopped=yes .*lock=not-held' "" "docker-stop-rc=1"
preprod; export F_STOP_HANG=1;             case_ after-stop-hangs                    1 "run stop start" 'app_stopped=yes .*lock=not-held' "" "docker-stop-rc=124"
preprod; export F_XC=137;                  case_ after-container-exit-137            1 "run stop start" 'app_stopped=yes' "" "container-exit=137"
preprod; export F_HRC=5;                   case_ after-helper-exit-5                 1 "run stop start" 'app_stopped=yes' "" "helper-exit=5"
preprod; export F_CONTAINER_OUTLIVES_CLIENT=1 F_KILL_FAILS=1
                                           case_ after-helper-container-outlives-client 1 "run stop kill start" 'app_stopped=yes .*helper=running account=yes lock=may-be-held' "$CLAIMS_RELEASE" "helper-still-running"
preprod; export F_STARTRC=1;               case_ after-start-fails                   1 "run stop start" 'app_stopped=yes' "" "docker-start-rc=1"
preprod; export F_UNHEALTHY_AFTER_START=1; case_ after-unhealthy-after-restart       1 "run stop start" 'app_stopped=yes app_now=running/unhealthy' "" 'not-healthy-after-90s\(unhealthy\)'
preprod; export F_HZRC=1;                  case_ after-healthz-request-fails         1 "run stop start" 'app_stopped=yes' "" "healthz-request-rc=1 healthz-database-not-connected"
preprod; export F_HZ='{"status":"unhealthy","database":"disconnected"}'
                                           case_ after-healthz-db-disconnected       1 "run stop start" 'app_stopped=yes' "" "healthz-database-not-connected"
preprod; export F_STOPRC=1 F_HRC=6;        case_ after-two-failures                  1 "run stop start" 'app_stopped=yes' "" "docker-stop-rc=1 helper-exit=6"
echo "driver cases passed: $PASSED; failed: $FAILED (for a defect, B: $FAILED_B)"
DRIVER_FAILED=$FAILED

echo "== helper"
node "$D/helper-cases.mjs"; HELPER_RC=$?

rm -rf "$WORK" 2>/dev/null
[ "$DRIVER_FAILED" = 0 ] && [ "$HELPER_RC" = 0 ]
