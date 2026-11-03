# AI-056 / #108: contended `docker stop` of mgpl-preprod-app with a restore-tuning
# request in flight. Runs on the preprod host; expects B64 (the helper script,
# base64) prepended and $1 = profile count. From the repository root:
#
#   { echo "B64=$(base64 -w0 scripts/probes/ai056-preprod-contended-stop-helper.mjs)"; \
#     cat scripts/probes/ai056-preprod-contended-stop-driver.sh; } \
#     | ssh root@<preprod-tailscale-ip> 'bash -s -- 650'
#
# Stops the app, then restarts it once the helper has released its lock (about
# 45 s of downtime). Each run registers one ai056-probe-<ms>@example.invalid account.
#
# Target check, before anything else: `docker inspect mgpl-preprod-app` must show
# DOPPLER_CONFIG=preprod (injected by Doppler from the config that supplies its
# secrets), compose project mgpl-preprod, DB_PATH=/data/mgpl-preprod.db, /data mount
# source /opt/mgpl/data-preprod and networks exactly mgpl-preprod_default. A missing
# value fails. The helper then checks the target itself, without Docker access; the
# driver passes it no target values.
#
# Every docker call is bounded by `timeout`, and so is every wait. The driver never
# waits indefinitely on the helper: it kills it if it outlives its bound.
#
# Exit code, RESULT line and STATE line are computed together, once, in on_exit,
# which every path goes through. STATE reports only what it has confirmed and
# says unknown otherwise:
#   app_stopped  yes if this run issued docker stop
#   app_now      the app container's live status, or unknown
#   helper       never-started | gone (its container no longer runs) | running | unknown
#   account      yes (register returned 201) | no (the helper never attempted to
#                register and is gone, or never started) | unknown
#   lock         not-taken (helper never started) | not-held (helper gone: any lock
#                it held was released when it exited) | may-be-held (helper still
#                running) | unknown
# When the lock may be held, an ACTION line says how to release it.
#
# Exit codes:
#   0  pass. App stopped once, restarted, healthy; account yes; lock not-held.
#   1  failed after the stop began. The app WAS STOPPED and may be down: read
#      STATE app_now. Account and lock as STATE reports them.
#   3  target not preprod. Nothing: helper never started, app untouched.
#   4  precondition failed (bad N, no helper script, no timeout command, app not
#      healthy). Nothing: helper never started, app untouched.
#   5  the helper started but did not send its request. App not stopped. Account
#      and lock as STATE reports them.
set -u
N=${1:-}
APP=mgpl-preprod-app
IMG=mgpl-preprod-app:develop-b1c2395
HELPER=ai056-helper-$N
LOG=/dev/null        # the helper's log; created only when the helper starts
STAGE=precondition   # precondition -> target -> helper -> stopped -> done
FAILS=""
HP=""
HRC=none
HELPER_STARTED=no
STOP_ISSUED=no
fail() { FAILS="$FAILS $*"; }
bounded() { local s=$1; shift; timeout -k 5 "$s" "$@"; }

# running | gone | unknown, from the live container list (bounded)
helper_container() {
  local names
  names=$(bounded 10 docker ps --format '{{.Names}}' 2>/dev/null) || { echo unknown; return; }
  if printf '%s\n' "$names" | grep -qx "$HELPER"; then echo running; else echo gone; fi
}
# waits at most $1 s for the docker run client; kills it if it is still there
wait_client() {
  local i
  for i in $(seq 1 "$1"); do kill -0 "$HP" 2>/dev/null || break; sleep 1; done
  if kill -0 "$HP" 2>/dev/null; then kill "$HP" 2>/dev/null; wait "$HP" 2>/dev/null; HRC=client-killed
  else wait "$HP"; HRC=$?; fi
}
# stops a helper that is still running, bounded; the lock goes when it exits
stop_helper() {
  [ "$(helper_container)" = gone ] || bounded 15 docker kill "$HELPER" > /dev/null 2>&1
  wait_client 15
}

on_exit() {
  local st=$? code kind hc acct lock now
  trap - EXIT INT TERM HUP
  if [ -z "$FAILS" ] && [ "$STAGE" != done ]; then fail "driver-exited-early(status=$st,stage=$STAGE)"; fi
  if [ -z "$FAILS" ]; then code=0
  else case "$STAGE" in precondition) code=4 ;; target) code=3 ;; helper) code=5 ;; *) code=1 ;; esac
  fi
  if [ $HELPER_STARTED = no ]; then hc=never-started; acct=no; lock=not-taken
  else
    hc=$(helper_container)
    if grep -q "register status=201" "$LOG"; then acct=yes
    elif [ "$hc" = gone ] && ! grep -q REGISTER_ATTEMPT "$LOG"; then acct=no
    else acct=unknown; fi
    case "$hc" in gone) lock=not-held ;; running) lock=may-be-held ;; *) lock=unknown ;; esac
  fi
  now=$(bounded 10 docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' $APP 2>/dev/null) || now=unknown
  echo "STATE app_stopped=$STOP_ISSUED app_now=${now:-unknown} helper=$hc account=$acct lock=$lock"
  if [ "$lock" = may-be-held ] || [ "$lock" = unknown ]; then
    echo "ACTION the helper may still hold the write lock on preprod. Release it with: docker kill $HELPER"
  fi
  case $code in
    0) kind=pass ;;
    1) kind="fail (the app was stopped; check that it is running)" ;;
    *) kind=abort ;;
  esac
  echo "RESULT $kind code=$code stage=$STAGE${FAILS:+ failed:$FAILS}"
  exit $code
}
trap on_exit EXIT
trap 'fail interrupted; exit' INT TERM HUP

echo "===== AI-056 contended docker stop, profiles=$N ($(date -u +%FT%T.%NZ))"
case "$N" in '' | *[!0-9]* | 0) fail "profile-count-not-a-positive-integer($N)"; exit ;; esac
[ -n "${B64:-}" ] || { fail "helper-script-not-prepended"; exit; }
command -v timeout > /dev/null || { fail "timeout-command-missing"; exit; }

# --- target check (read-only): one bounded inspect, parsed here
STAGE=target
INSPECT=$(bounded 10 docker inspect -f '{{range .Config.Env}}ENV {{.}}{{println}}{{end}}LABEL {{index .Config.Labels "com.docker.compose.project"}}{{println}}MOUNT {{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}{{println}}NET {{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' $APP 2>/dev/null) || INSPECT=
line() { printf '%s\n' "$INSPECT" | sed -n "s/^$1//p"; }
check() { # name found required
  echo "TARGET $1: found '${2}', required '${3}'"
  [ "$2" = "$3" ] || fail "target-$1"
}
check DOPPLER_CONFIG "$(line 'ENV DOPPLER_CONFIG=')" preprod
check compose_project "$(line 'LABEL ')" mgpl-preprod
check DB_PATH "$(line 'ENV DB_PATH=')" /data/mgpl-preprod.db
check data_mount_source "$(line 'MOUNT ')" /opt/mgpl/data-preprod
check network "$(line 'NET ' | sed 's/ $//')" mgpl-preprod_default
[ -z "$FAILS" ] || exit

STAGE=precondition
bounded 10 docker inspect -f 'image={{.Image}} StopTimeout={{.Config.StopTimeout}} cfgfiles={{index .Config.Labels "com.docker.compose.project.config_files"}} state={{.State.Status}}/{{.State.Health.Status}}' $APP
[ "$(bounded 10 docker inspect -f '{{.State.Health.Status}}' $APP)" = healthy ] || { fail app-not-healthy; exit; }

# --- helper: the preprod mount and network; no target values, no Docker socket
STAGE=helper
LOG=/tmp/ai056-contended-$N.log
: > $LOG
SINCE=$(date -u +%FT%T.%NZ)
HELPER_STARTED=yes
echo "$B64" | base64 -d | bounded 180 docker run --rm -i --name "$HELPER" --network mgpl-preprod_default \
  -v /opt/mgpl/data-preprod:/data -e N=$N --entrypoint node $IMG --input-type=module - > $LOG 2>&1 &
HP=$!
for i in $(seq 1 300); do
  grep -q REQUEST_SENT $LOG && break
  kill -0 $HP 2>/dev/null || break
  sleep 0.1
done
if ! grep -q REQUEST_SENT $LOG; then
  stop_helper
  echo "--- helper log"; cat $LOG
  fail "helper-did-not-send-request(exit=$HRC)"
  exit
fi
sleep 1

STAGE=stopped
STOP_ISSUED=yes
S=$(date +%s%N); echo "$(date -u +%FT%T.%NZ) docker stop $APP"
bounded 60 docker stop $APP; RC=$?
E=$(date +%s%N)
echo "docker stop rc=$RC elapsed_ms=$(( (E - S) / 1000000 ))"
[ $RC = 0 ] || fail "docker-stop-rc=$RC"
bounded 10 docker inspect -f 'State.ExitCode={{.State.ExitCode}} OOMKilled={{.State.OOMKilled}} StartedAt={{.State.StartedAt}} FinishedAt={{.State.FinishedAt}}' $APP
XC=$(bounded 10 docker inspect -f '{{.State.ExitCode}}' $APP) || XC=unknown
case "$XC" in 0 | 143) ;; *) fail "container-exit=$XC" ;; esac
# The helper releases its lock 45 s after it starts; give it 90 s, then stop it.
wait_client 90
echo "helper exit=$HRC"
[ "$HRC" = 0 ] || fail "helper-exit=$HRC"
if [ "$(helper_container)" != gone ]; then fail helper-still-running; stop_helper; fi
echo "--- helper log"; cat $LOG
echo "--- app log since $SINCE"; bounded 20 docker logs --since "$SINCE" $APP 2>&1 | tail -40
echo "--- restart"
bounded 60 docker start $APP; SRC=$?
[ $SRC = 0 ] || fail "docker-start-rc=$SRC"
HEALTH=
for i in $(seq 1 90); do
  HEALTH=$(bounded 10 docker inspect -f '{{.State.Health.Status}}' $APP)
  [ "$HEALTH" = healthy ] && break
  sleep 1
done
[ "$HEALTH" = healthy ] || fail "not-healthy-after-90s($HEALTH)"
bounded 10 docker inspect -f 'state={{.State.Status}}/{{.State.Health.Status}} image={{.Image}} started={{.State.StartedAt}}' $APP
HZ=$(bounded 20 docker exec $APP wget -qO- http://127.0.0.1:4000/healthz); HZRC=$?
echo "$HZ"
[ $HZRC = 0 ] || fail "healthz-request-rc=$HZRC"
case "$HZ" in *'"database":"connected"'*) ;; *) fail healthz-database-not-connected ;; esac
STAGE=done
exit
