#!/usr/bin/env bash
# Kills the mirror relay for real, between the transaction that claims a role
# and the ledger page that reports it, and counts what the consumer ended up
# with.
#
# Nothing here mocks a failure. Every "crash" is process.kill(process.pid,
# 'SIGKILL') inside the process under test, so no catch block runs, no finally
# runs and stdout is not flushed. What survives is only what Postgres committed.
#
# Runs against a throwaway database, migrated from scratch, seeded with rows
# this script invents. It never touches the pipeline's real database: -db is
# passed explicitly on every invocation and src/outbox-cli.ts does not import
# config.ts, so no environment variable can redirect it at the real one.
set -uo pipefail

DB="${C13_DB:?set C13_DB to the throwaway job-discovery database}"
SINK_DB="${C13_SINK_DB:?set C13_SINK_DB to the throwaway consumer database}"
PORT="${C13_PORT:-9412}"
SINK_URL="http://127.0.0.1:${PORT}"
PGC="${C13_PGCONTAINER:-c13-pg-jd}"
PGU="${C13_PGUSER:-jd}"
PGDB="${C13_PGDB:-jd_c13}"
CLI="npx tsx src/outbox-cli.ts"

pass=0; fail=0; sink_pid=""

q()  { docker exec "$PGC" psql -qtAX -U "$PGU" -d "$PGDB"       -c "$1"; }
qs() { docker exec "$PGC" psql -qtAX -U "$PGU" -d ledger_sink   -c "$1"; }

start_sink() {
  stop_sink
  $CLI sink -db "$SINK_DB" -port "$PORT" -dedupe "$1" >/tmp/c13-jd-sink.log 2>&1 &
  sink_pid=$!
  for _ in $(seq 1 100); do
    [ "$(curl -sS -o /dev/null -w '%{http_code}' "${SINK_URL}/v1/pages/probe" 2>/dev/null)" = "404" ] && return
    perl -e 'select undef,undef,undef,0.1'
  done
  echo "sink did not come up"; cat /tmp/c13-jd-sink.log; exit 1
}
stop_sink() { [ -n "$sink_pid" ] && kill "$sink_pid" 2>/dev/null; wait "$sink_pid" 2>/dev/null; sink_pid=""; }
trap stop_sink EXIT

reset() {
  q "TRUNCATE outbox; DELETE FROM job_sources; DELETE FROM jobs;" >/dev/null
  qs "TRUNCATE ledger_pages, inbox CASCADE" >/dev/null
}

run_and_report() {
  local label="$1"; shift
  "$@" >/tmp/c13-jd-cmd.log 2>&1
  local rc=$?
  printf '    %-30s exit=%s%s\n' "$label" "$rc" "$( [ $rc -eq 137 ] && echo '  (SIGKILL: 128+9)' )"
  sed 's/^/      | /' /tmp/c13-jd-cmd.log
  return $rc
}

check() {
  if [ "$2" = "$3" ]; then printf '    PASS  %s: %s\n' "$1" "$3"; pass=$((pass+1));
  else printf '    FAIL  %s: expected %s, got %s\n' "$1" "$2" "$3"; fail=$((fail+1)); fi
}

pages()      { qs "SELECT count(*) FROM ledger_pages"; }
pages_for()  { qs "SELECT count(*) FROM ledger_pages WHERE job_id='$1'"; }
jobid()      { q  "SELECT id FROM jobs ORDER BY first_seen_at LIMIT 1"; }
obstate()    { q  "SELECT state FROM outbox WHERE idempotency_key='mirror:$1'"; }
obres()      { q  "SELECT coalesce(resolution,'-') FROM outbox WHERE idempotency_key='mirror:$1'"; }
pageid()     { q  "SELECT coalesce(notion_page_id,'NULL') FROM jobs WHERE id='$1'"; }
deliveries() { qs "SELECT coalesce(max(deliveries)::text,'0') FROM inbox WHERE idempotency_key='mirror:$1'"; }

banner() { echo; echo "=================================================================="; echo "$1"; echo "=================================================================="; }

start_sink true

# ---------------------------------------------------------------- CONTROL 1 --
# The mirror as it was. createLedgerPage files the page, recordNotionPage stores
# its id, in that order, on two systems. Kill the process between them and the
# page exists with nothing here pointing at it; notion_page_id is still NULL, so
# the next run files a second page for the same role. This is not an argument
# about the old code, it is the old code running.
banner "CONTROL 1  the mirror as it was: SIGKILL between the page and its id"
reset
run_and_report "seed 1 fixture role" $CLI seed -db "$DB" -n 1
JOB="$(jobid)"
run_and_report "dual-write -crash=after_send" $CLI dual-write -db "$DB" -sink "$SINK_URL" -crash after_send
check "page filed downstream"        1 "$(pages_for "$JOB")"
check "notion_page_id recorded here" NULL "$(pageid "$JOB")"
echo "    the next run sees notion_page_id IS NULL and files the role again:"
run_and_report "dual-write (next run)" $CLI dual-write -db "$DB" -sink "$SINK_URL"
check "pages for one role"           2 "$(pages_for "$JOB")"
echo "    -> a duplicate row in the ledger. This is the bug, reproduced."

# ------------------------------------------------------------------ TEST 1 ---
banner "TEST 1  outbox: SIGKILL right after the claiming transaction commits"
reset
run_and_report "seed 1 fixture role" $CLI seed -db "$DB" -n 1
JOB="$(jobid)"
run_and_report "claim -crash=after_commit" $CLI claim -db "$DB" -crash after_commit
check "role claimed"       1 "$(q "SELECT count(*) FROM jobs WHERE mirror_requested_at IS NOT NULL")"
check "message queued"     1 "$(q "SELECT count(*) FROM outbox WHERE idempotency_key='mirror:$JOB'")"
check "outbox state" PENDING "$(obstate "$JOB")"
check "pages filed"        0 "$(pages_for "$JOB")"
run_and_report "relay (restart)" $CLI relay -db "$DB" -sink "$SINK_URL"
check "outbox state" DELIVERED "$(obstate "$JOB")"
check "pages filed"          1 "$(pages_for "$JOB")"
check "page id recorded here" "$(qs "SELECT page_id FROM ledger_pages WHERE job_id='$JOB'")" "$(pageid "$JOB")"

# ------------------------------------------------------------------ TEST 2 ---
banner "TEST 2  SIGKILL after the attempt is recorded, before the request is sent"
reset
run_and_report "seed 1 fixture role" $CLI seed -db "$DB" -n 1
JOB="$(jobid)"
run_and_report "claim" $CLI claim -db "$DB"
run_and_report "relay -crash=before_send" $CLI relay -db "$DB" -sink "$SINK_URL" -lease 1 -crash before_send
check "outbox state" INFLIGHT "$(obstate "$JOB")"
check "attempts recorded"   1 "$(q "SELECT attempts FROM outbox WHERE idempotency_key='mirror:$JOB'")"
check "pages filed"         0 "$(pages_for "$JOB")"
echo "    the row says attempt 1 began and nothing else. That is all that is true."
run_and_report "reconcile" $CLI reconcile -db "$DB" -sink "$SINK_URL"
check "state after reconcile" PENDING "$(obstate "$JOB")"
check "resolution" absent_at_consumer_after_crash "$(obres "$JOB")"
run_and_report "relay (redeliver)" $CLI relay -db "$DB" -sink "$SINK_URL"
check "outbox state" DELIVERED "$(obstate "$JOB")"
check "pages filed"          1 "$(pages_for "$JOB")"

# ------------------------------------------------------------------ TEST 3 ---
banner "TEST 3  SIGKILL after the consumer filed the page, before we recorded it"
reset
run_and_report "seed 1 fixture role" $CLI seed -db "$DB" -n 1
JOB="$(jobid)"
run_and_report "claim" $CLI claim -db "$DB"
run_and_report "relay -crash=after_send" $CLI relay -db "$DB" -sink "$SINK_URL" -lease 1 -crash after_send
check "outbox state" INFLIGHT "$(obstate "$JOB")"
check "page already filed"  1 "$(pages_for "$JOB")"
check "page id here"     NULL "$(pageid "$JOB")"
echo "    the producer's row is the same shape as TEST 2's, and the truth is the opposite."
run_and_report "reconcile" $CLI reconcile -db "$DB" -sink "$SINK_URL"
check "outbox state" DELIVERED "$(obstate "$JOB")"
check "resolution" confirmed_by_consumer_after_crash "$(obres "$JOB")"
check "pages (still one)"    1 "$(pages_for "$JOB")"
check "page id recovered from the consumer" "$(qs "SELECT page_id FROM ledger_pages WHERE job_id='$JOB'")" "$(pageid "$JOB")"

# ------------------------------------------------------------------ TEST 4 ---
banner "TEST 4  replay: force the delivered rows back to PENDING and rerun"
reset
run_and_report "seed 3 fixture roles" $CLI seed -db "$DB" -n 3
run_and_report "claim" $CLI claim -db "$DB"
run_and_report "relay" $CLI relay -db "$DB" -sink "$SINK_URL"
JOB="$(jobid)"
before="$(pages)"
check "pages after first delivery" 3 "$before"
for i in 1 2 3; do
  q "UPDATE outbox SET state='PENDING', next_attempt_at=now(), receipt=NULL, delivered_at=NULL WHERE state='DELIVERED'" >/dev/null
  run_and_report "relay replay $i" $CLI relay -db "$DB" -sink "$SINK_URL"
done
check "pages unchanged by 3 replays" "$before" "$(pages)"
check "deliveries counted at the consumer (at-least-once is real)" 4 "$(deliveries "$JOB")"

# ---------------------------------------------------------------- CONTROL 2 --
banner "CONTROL 2  inbox off: the same replay duplicates every page"
start_sink false
before="$(pages)"
q "UPDATE outbox SET state='PENDING', next_attempt_at=now(), receipt=NULL, delivered_at=NULL WHERE state='DELIVERED'" >/dev/null
run_and_report "relay (dedupe=off)" $CLI relay -db "$DB" -sink "$SINK_URL"
check "pages doubled" "$((before * 2))" "$(pages)"
echo "    -> the inbox, not the relay and not the schema, is what makes the page land once."
start_sink true

# ---------------------------------------------------------------- CONTROL 3 --
banner "CONTROL 3  a downstream that cannot be asked: the row stays UNKNOWN"
reset
run_and_report "seed 1 fixture role" $CLI seed -db "$DB" -n 1
JOB="$(jobid)"
run_and_report "claim" $CLI claim -db "$DB"
run_and_report "relay -crash=before_send" $CLI relay -db "$DB" -sink "$SINK_URL" -lease 1 -crash before_send
run_and_report "reconcile -no-lookup" $CLI reconcile -db "$DB" -sink "$SINK_URL" -no-lookup
check "state stays UNKNOWN" UNKNOWN "$(obstate "$JOB")"
check "pages still zero"          0 "$(pages_for "$JOB")"
echo "    last_error: $(q "SELECT last_error FROM outbox WHERE idempotency_key='mirror:$JOB'")"
echo "    -> nothing was guessed in either direction. This is what Notion itself looks like."

# ---------------------------------------------------------------- CONTROL 4 --
banner "CONTROL 4  the two ways of guessing, and what each one costs"
echo "  (a) assume delivered: mark the UNKNOWN row DELIVERED without asking"
q "UPDATE outbox SET state='DELIVERED', receipt='assumed', resolution='ASSUMED_DELIVERED' WHERE idempotency_key='mirror:$JOB'" >/dev/null
check "outbox says delivered" DELIVERED "$(obstate "$JOB")"
check "pages the ledger actually holds" 0 "$(pages_for "$JOB")"
echo "      -> a role recorded as mirrored that was never written. Silent loss."
echo "  (b) assume not delivered, with the inbox off: redeliver TEST 3's message"
reset; start_sink false
run_and_report "seed 1 fixture role" $CLI seed -db "$DB" -n 1
JOB="$(jobid)"
run_and_report "claim" $CLI claim -db "$DB"
run_and_report "relay -crash=after_send" $CLI relay -db "$DB" -sink "$SINK_URL" -lease 1 -crash after_send
q "UPDATE outbox SET state='PENDING', next_attempt_at=now() WHERE idempotency_key='mirror:$JOB'" >/dev/null
run_and_report "relay (assumed not delivered)" $CLI relay -db "$DB" -sink "$SINK_URL"
check "pages after guessing wrong" 2 "$(pages_for "$JOB")"
echo "      -> the same role filed twice, which is CONTROL 1's bug reached a different way."
start_sink true

banner "RESULT  pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
