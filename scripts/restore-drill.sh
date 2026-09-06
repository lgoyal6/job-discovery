#!/usr/bin/env bash
#
# Back this database up, restore it somewhere else, and find out whether what
# came back is still the pipeline's database.
#
# OPERATIONS.md has a restore playbook - stop n8n, restore PostgreSQL, confirm
# migrations - and no evidence that anyone has ever run it. This is that
# playbook with the evidence attached: a real pg_dump, a real pg_restore, a
# real WAL replay to a stated instant, and afterwards the checks that would
# notice if the restore were quietly wrong.
#
# Two restores, because their recoverable data windows differ:
#
#   logical  pg_dump -Fc, pg_restore into an empty database in a second
#            container. Recovers to the instant the dump began, so the window
#            is the dump interval.
#   pitr     pg_basebackup plus archived WAL replayed into a third container up
#            to a stated instant. Window is archive_timeout.
#
# NOTHING HERE TOUCHES A REAL DATABASE. Both databases are containers this
# script creates seconds before it uses them, seeded from scratch by
# scripts/restore-drill-seed.ts with invented companies and invented Notion
# page ids. DATABASE_URL is set here rather than read from the environment,
# and the run refuses to start if the caller's DATABASE_URL happens to name
# either port.
#
#   ./scripts/restore-drill.sh
set -uo pipefail
cd "$(dirname "$0")/.."

JOBS=${JOBS:-4000}
ARCHIVE_TIMEOUT=${ARCHIVE_TIMEOUT:-10}
SRC_PORT=55621
TGT_PORT=55622
PITR_PORT=55623
IMAGE=postgres:16
OUT=${OUT:-.agent-work/c14}
PGUSER_=job_pipeline
PGDB=job_discovery
PGPASS=drill-only

mkdir -p "$OUT"
say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
load() { uptime | sed 's/.*load averages*: *//'; }
# psql prints a command tag for every statement, so a transcript that contains
# statements carries BEGIN, ALTER TABLE and ROLLBACK that a plain fingerprint
# does not. Every fingerprint key is lower case and every one of those tags is
# upper case, so comparing only the lower-case lines compares the fingerprints
# and nothing else.
keys() { grep -E '^[a-z]' "$1" | sort; }

SRC_URL="postgresql://${PGUSER_}:${PGPASS}@127.0.0.1:${SRC_PORT}/${PGDB}"
TGT_URL="postgresql://${PGUSER_}:${PGPASS}@127.0.0.1:${TGT_PORT}/${PGDB}"
PITR_URL="postgresql://${PGUSER_}:${PGPASS}@127.0.0.1:${PITR_PORT}/${PGDB}"

# Isolation, checked before anything is created. Comparing digests rather than
# strings so a configured URL never has to be printed anywhere.
CONFIGURED_SHA=$(printf '%s' "${DATABASE_URL:-unset}" | shasum -a 256 | cut -c1-16)
for url in "$SRC_URL" "$TGT_URL" "$PITR_URL"; do
  mine=$(printf '%s' "$url" | shasum -a 256 | cut -c1-16)
  [ "$mine" = "$CONFIGURED_SHA" ] && { echo "refusing to run: a drill url equals the configured DATABASE_URL"; exit 1; }
done
echo "configured DATABASE_URL sha256[0:16] = ${CONFIGURED_SHA}; the three drill urls all differ from it"

export EMAIL_TO=${EMAIL_TO:-drill@example.invalid}
export NOTION_DATABASE_ID=${NOTION_DATABASE_ID:-00000000000000000000000000000000}
export NOTION_DATA_SOURCE_ID=${NOTION_DATA_SOURCE_ID:-00000000-0000-0000-0000-000000000000}

teardown() {
  [ "${KEEP:-0}" = 1 ] && { echo "left running: jd-c14-src jd-c14-tgt jd-c14-pitr"; return; }
  docker rm -f jd-c14-src jd-c14-tgt jd-c14-pitr >/dev/null 2>&1
  docker volume rm -f jd-c14-archive jd-c14-base >/dev/null 2>&1
}
trap teardown EXIT INT TERM

wait_ready() {
  for _ in $(seq 1 90); do
    docker exec "$1" psql -U "$PGUSER_" -d "$PGDB" -tAc 'select 1' >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "$1 never came up"; return 1
}

# ---------------------------------------------------------------- source ----
say "source: postgres with WAL archiving on, archive_timeout=${ARCHIVE_TIMEOUT}s"
docker rm -f jd-c14-src jd-c14-tgt jd-c14-pitr >/dev/null 2>&1
docker volume rm -f jd-c14-archive jd-c14-base >/dev/null 2>&1
docker volume create jd-c14-archive >/dev/null
docker volume create jd-c14-base >/dev/null
docker run -d --name jd-c14-src \
  -e POSTGRES_DB=$PGDB -e POSTGRES_USER=$PGUSER_ -e POSTGRES_PASSWORD=$PGPASS \
  -v jd-c14-archive:/archive -v jd-c14-base:/base \
  -p 127.0.0.1:${SRC_PORT}:5432 "$IMAGE" \
  -c wal_level=replica -c archive_mode=on -c archive_timeout="${ARCHIVE_TIMEOUT}" \
  -c "archive_command=test ! -f /archive/%f && cp %p /archive/%f" >/dev/null
wait_ready jd-c14-src || exit 1
docker exec -u root jd-c14-src chown postgres:postgres /archive /base

say "seed A: ${JOBS} invented postings through the pipeline's own writers"
DATABASE_URL="$SRC_URL" npx tsx scripts/restore-drill-seed.ts "$JOBS" || exit 1

say "base backup, taken here so the WAL after it is what PITR has to replay"
docker exec jd-c14-src bash -c "rm -rf /base/pristine && pg_basebackup -U $PGUSER_ -D /base/pristine -X stream -c fast" || exit 1

say "seed B: a second batch of postings, after the base backup"
DATABASE_URL="$SRC_URL" npx tsx scripts/restore-drill-seed.ts $((JOBS + JOBS / 4)) >/dev/null || exit 1
# The whole state PITR will have to reproduce, captured before the instant
# that names it. Nothing writes in between. A jobs count would not do: these
# postings dedupe onto a fixed set of roles, so a second seed adds job_sources
# rows without adding jobs, and the count does not move even though the
# database does.
docker exec -i jd-c14-src psql -U $PGUSER_ -d $PGDB < scripts/restore-fingerprint.sql \
  | sort > "$OUT/at-target-fingerprint.txt"
RECOVERY_TARGET=$(docker exec jd-c14-src psql -U $PGUSER_ -d $PGDB -tAc 'select now()')
JOBS_AT_TARGET=$(docker exec jd-c14-src psql -U $PGUSER_ -d $PGDB -tAc 'select count(*) from jobs')
echo "recovery target $RECOVERY_TARGET, ${JOBS_AT_TARGET} jobs at that instant"

say "seed C: a third batch, after the recovery target. PITR must not return it."
docker exec jd-c14-src psql -U $PGUSER_ -d $PGDB -tAc 'select pg_sleep(2)' >/dev/null
DATABASE_URL="$SRC_URL" npx tsx scripts/restore-drill-seed.ts $((JOBS + JOBS / 2)) >/dev/null || exit 1

docker exec -i jd-c14-src psql -U $PGUSER_ -d $PGDB < scripts/restore-invariants.sql > "$OUT/src-invariants.txt"
docker exec -i jd-c14-src psql -U $PGUSER_ -d $PGDB < scripts/restore-fingerprint.sql | sort > "$OUT/src-fingerprint.txt"
DATABASE_URL="$SRC_URL" npx tsx scripts/restore-verify.ts > "$OUT/src-verify.txt"

# ------------------------------------------------------- logical restore ----
say "logical: pg_dump -Fc"
echo "load before: $(load)"
DUMP_START=$(date +%s.%N)
docker exec jd-c14-src pg_dump -U $PGUSER_ -d $PGDB -Fc -f /base/jd.dump || exit 1
DUMP_END=$(date +%s.%N)
echo "load after:  $(load)"
DUMP_BYTES=$(docker exec jd-c14-src stat -c %s /base/jd.dump)

say "logical: restore into a second container that has never seen this data"
docker run -d --name jd-c14-tgt \
  -e POSTGRES_DB=$PGDB -e POSTGRES_USER=$PGUSER_ -e POSTGRES_PASSWORD=$PGPASS \
  -v jd-c14-base:/base -p 127.0.0.1:${TGT_PORT}:5432 "$IMAGE" >/dev/null
wait_ready jd-c14-tgt || exit 1
# Isolation, asserted rather than assumed.
[ "$SRC_URL" != "$TGT_URL" ] || { echo "target url equals source url"; exit 1; }
EMPTY=$(docker exec jd-c14-tgt psql -U $PGUSER_ -d $PGDB -tAc \
  "select count(*) from information_schema.tables where table_schema='public'")
[ "$EMPTY" = 0 ] || { echo "target was not empty: $EMPTY tables"; exit 1; }
echo "target public schema had $EMPTY tables before the restore"

echo "load before: $(load)"
RESTORE_START=$(date +%s.%N)
docker exec jd-c14-tgt pg_restore -U $PGUSER_ -d $PGDB --exit-on-error /base/jd.dump || exit 1
RESTORE_END=$(date +%s.%N)
echo "load after:  $(load)"

docker exec -i jd-c14-tgt psql -U $PGUSER_ -d $PGDB < scripts/restore-invariants.sql > "$OUT/tgt-invariants.txt"
docker exec -i jd-c14-tgt psql -U $PGUSER_ -d $PGDB < scripts/restore-fingerprint.sql | sort > "$OUT/tgt-fingerprint.txt"
DATABASE_URL="$TGT_URL" npx tsx scripts/restore-verify.ts > "$OUT/tgt-verify.txt"

# A sentinel written to the source after the restore. If it reaches the target,
# the two urls were one database and every number above is self-comparison.
docker exec jd-c14-src psql -U $PGUSER_ -d $PGDB -c \
  "INSERT INTO company_aliases(alias_normalized,canonical_company) VALUES('c14 isolation sentinel','Sentinel')" >/dev/null
SENTINEL=$(docker exec jd-c14-tgt psql -U $PGUSER_ -d $PGDB -tAc \
  "select count(*) from company_aliases where alias_normalized='c14 isolation sentinel'")
echo "sentinel written to source, visible in target: $SENTINEL (must be 0)"
[ "$SENTINEL" = 0 ] || exit 1

# ---------------------------------------------------------- PITR restore ----
say "pitr: replay the archive into a third container, stopping at the target"
docker exec jd-c14-src psql -U $PGUSER_ -d $PGDB -tAc 'select pg_switch_wal()' >/dev/null
docker exec jd-c14-src psql -U $PGUSER_ -d $PGDB -c 'checkpoint' >/dev/null
# Wait for the archiver to catch up rather than guessing at it: a PITR started
# before the segment holding the recovery target is archived stops short of the
# target and reports success, which is the worst way for this to be wrong.
for _ in $(seq 1 30); do
  PENDING=$(docker exec jd-c14-src psql -U $PGUSER_ -d $PGDB -tAc \
    "select count(*) from pg_stat_archiver where last_failed_wal is not null and (last_archived_wal is null or last_failed_wal > last_archived_wal)")
  [ "$PENDING" = 0 ] && break
  sleep 1
done
docker exec jd-c14-src psql -U $PGUSER_ -d $PGDB -c \
  'select archived_count, last_archived_wal, last_archived_time, failed_count from pg_stat_archiver'
docker exec jd-c14-src bash -c 'rm -rf /base/pgdata && cp -a /base/pristine /base/pgdata && touch /base/pgdata/recovery.signal && rm -f /base/pgdata/postmaster.pid'

echo "load before: $(load)"
PITR_START=$(date +%s.%N)
docker run -d --name jd-c14-pitr -e PGDATA=/base/pgdata \
  -e POSTGRES_DB=$PGDB -e POSTGRES_USER=$PGUSER_ -e POSTGRES_PASSWORD=$PGPASS \
  -v jd-c14-archive:/archive -v jd-c14-base:/base \
  -p 127.0.0.1:${PITR_PORT}:5432 "$IMAGE" \
  -c "restore_command=cp /archive/%f %p" \
  -c "recovery_target_time=$RECOVERY_TARGET" \
  -c recovery_target_action=promote >/dev/null
wait_ready jd-c14-pitr || { docker logs jd-c14-pitr | tail -30; exit 1; }
PITR_END=$(date +%s.%N)
echo "load after:  $(load)"

PITR_JOBS=$(docker exec jd-c14-pitr psql -U $PGUSER_ -d $PGDB -tAc 'select count(*) from jobs')
docker exec -i jd-c14-pitr psql -U $PGUSER_ -d $PGDB < scripts/restore-invariants.sql > "$OUT/pitr-invariants.txt"
docker exec -i jd-c14-pitr psql -U $PGUSER_ -d $PGDB < scripts/restore-fingerprint.sql | sort > "$OUT/pitr-fingerprint.txt"
DATABASE_URL="$PITR_URL" npx tsx scripts/restore-verify.ts > "$OUT/pitr-verify.txt"
docker logs jd-c14-pitr 2>&1 | grep -iE 'recovery|consistent|promot|redo' | tail -20 > "$OUT/pitr-recovery.log"

# What a crash would cost, sampled rather than quoted. The archive can reach no
# further than its last archived segment, so the recoverable data window at any
# instant is now() minus last_archived_time. Sampled under a write workload,
# because that is when the number matters and when archive_timeout is doing
# something.
say "recoverable data window: sampling for ${WINDOW_SAMPLE_SECS:-60}s under writes"
docker exec jd-c14-src psql -U $PGUSER_ -d $PGDB -c \
  "create table if not exists c14_window_probe(id bigserial primary key, at timestamptz default now())" >/dev/null
WINDOW=0
for _ in $(seq 1 $(( ${WINDOW_SAMPLE_SECS:-60} / 2 ))); do
  docker exec jd-c14-src psql -U $PGUSER_ -d $PGDB -tAc "insert into c14_window_probe default values" >/dev/null
  sample=$(docker exec jd-c14-src psql -U $PGUSER_ -d $PGDB -tAc \
    "select round(extract(epoch from now() - last_archived_time)::numeric, 1) from pg_stat_archiver")
  WINDOW=$(python3 -c "print(max($WINDOW, ${sample:-0}))")
  sleep 2
done
docker exec jd-c14-src psql -U $PGUSER_ -d $PGDB -c "drop table c14_window_probe" >/dev/null

say "results"
python3 - "$DUMP_START" "$DUMP_END" "$RESTORE_START" "$RESTORE_END" "$PITR_START" "$PITR_END" <<'PY'
import sys
d0, d1, r0, r1, p0, p1 = (float(x) for x in sys.argv[1:7])
print(f"dump            {d1-d0:8.2f} s")
print(f"logical restore {r1-r0:8.2f} s")
print(f"pitr recovery   {p1-p0:8.2f} s")
PY
echo "dump size ${DUMP_BYTES} bytes"
echo "jobs: source $(docker exec jd-c14-src psql -U $PGUSER_ -d $PGDB -tAc 'select count(*) from jobs'), target $(docker exec jd-c14-tgt psql -U $PGUSER_ -d $PGDB -tAc 'select count(*) from jobs'), pitr ${PITR_JOBS} (at the recovery instant the source had ${JOBS_AT_TARGET})"
echo "recoverable data window: worst observed ${WINDOW} s behind the last archived WAL segment over ${WINDOW_SAMPLE_SECS:-60}s of writes (archive_timeout=${ARCHIVE_TIMEOUT}s)"

say "fingerprint diff, source against logical restore"
diff "$OUT/src-fingerprint.txt" "$OUT/tgt-fingerprint.txt" && echo "identical"
say "invariant diff, source against logical restore"
diff "$OUT/src-invariants.txt" "$OUT/tgt-invariants.txt" && echo "identical"
say "recomputed columns on the restored copy"
cat "$OUT/tgt-verify.txt"
say "invariants on the point-in-time copy"
cat "$OUT/pitr-invariants.txt"

say "point-in-time copy against the source as it stood at the recovery target"
diff <(keys "$OUT/at-target-fingerprint.txt") <(keys "$OUT/pitr-fingerprint.txt") \
  && echo "identical: the replay stopped where it was told"
say "and it is NOT the source as it stands now (seed C must be absent)"
diff <(keys "$OUT/src-fingerprint.txt") <(keys "$OUT/pitr-fingerprint.txt") >/dev/null \
  && echo "IDENTICAL -- the replay did not stop at the target" \
  || echo "differs, as it must: the third seed is not in the recovered copy"

# ------------------------------------------------------ negative controls ----
# Every check above passed. A check that cannot fail is not a check, so each
# one is now broken on purpose against the restored copy and has to say so.
#
# The SQL controls run inside a transaction that is rolled back, in one psql
# session, so the tamper and the check see each other and nothing survives.
# The two recompute controls cannot: restore-verify.ts opens its own
# connection, so those tamper for real, run, undo, and then show the
# fingerprint back where it was.
say "negative controls: break the restored copy on purpose"
NCDIR="$OUT/nc"; mkdir -p "$NCDIR"
T() { docker exec -i jd-c14-tgt psql -U $PGUSER_ -d $PGDB "$@"; }

control() {  # name, out-file, tamper-sql, check-sql-file
  local name=$1 file=$2 tamper=$3 checks=$4
  { echo "BEGIN;"; echo "$tamper"; cat "$checks"; echo "ROLLBACK;"; } > "$NCDIR/$file.sql"
  T < "$NCDIR/$file.sql" > "$NCDIR/$file" 2>&1
  echo "--- $name"
  grep -q '^ERROR:' "$NCDIR/$file" && {
    echo "  THE CONTROL ITSELF ERRORED, so it proves nothing:"
    grep '^ERROR:' "$NCDIR/$file" | sed 's/^/    /'
  }
}

# NC1. A job deleted out from under a digest that already named it. The FKs
# cascade job_sources and job_enrichment away; email_batches.job_ids is a
# uuid[] with no FK behind it, so it keeps pointing at nothing. Nothing in the
# schema notices, which is why the check exists.
control "nc1 a job a sent digest still names" nc1-invariants.txt \
  "DELETE FROM jobs WHERE id = (SELECT unnest(job_ids) FROM email_batches WHERE status='SENT' LIMIT 1);" \
  scripts/restore-invariants.sql
grep -E '\| FAIL' "$NCDIR/nc1-invariants.txt" || echo "  NO FAIL -- the control did not control anything"

# NC2. Send state erased on a job a confirmed digest names. This is the shape
# of the bug that mailed 125 roles a second time.
control "nc2 send state erased" nc2-invariants.txt \
  "UPDATE jobs SET sent_at = NULL WHERE id = (SELECT unnest(job_ids) FROM email_batches WHERE status='SENT' LIMIT 1);" \
  scripts/restore-invariants.sql
grep -E '\| FAIL' "$NCDIR/nc2-invariants.txt" || echo "  NO FAIL -- the control did not control anything"

# NC3. A CHECK constraint the restore did not recreate. No row changes, so
# only the schema lines of the fingerprint can see it.
control "nc3 a dropped CHECK constraint" nc3-fingerprint.txt \
  "ALTER TABLE jobs DROP CONSTRAINT jobs_status_check;" \
  scripts/restore-fingerprint.sql
keys "$NCDIR/nc3-fingerprint.txt" > "$NCDIR/nc3-sorted.txt"
diff <(keys "$OUT/tgt-fingerprint.txt") "$NCDIR/nc3-sorted.txt" > "$NCDIR/nc3-diff.txt" \
  && echo "  NO DIFF -- the control did not control anything" \
  || { echo "  fingerprint noticed:"; sed 's/^/    /' "$NCDIR/nc3-diff.txt"; }

# NC4. A timestamp re-defaulted to now(), which is what a restore that
# recreated rows rather than restoring them leaves behind. Counts and digests
# do not move; only the instants do.
control "nc4 a re-defaulted timestamp" nc4-fingerprint.txt \
  "UPDATE jobs SET first_seen_at = now() WHERE id = (SELECT id FROM jobs ORDER BY canonical_key LIMIT 1);" \
  scripts/restore-fingerprint.sql
keys "$NCDIR/nc4-fingerprint.txt" > "$NCDIR/nc4-sorted.txt"
diff <(keys "$OUT/tgt-fingerprint.txt") "$NCDIR/nc4-sorted.txt" > "$NCDIR/nc4-diff.txt" \
  && echo "  NO DIFF -- the control did not control anything" \
  || { echo "  fingerprint noticed:"; sed 's/^/    /' "$NCDIR/nc4-diff.txt"; }

# NC5. The referential checks, shown not to be vacuous. Disabling the FK
# triggers and emptying jobs leaves the orphans a data-only restore into a
# schema without foreign keys would leave.
control "nc5 orphans the foreign keys would have refused" nc5-invariants.txt \
  "SET session_replication_role = replica; DELETE FROM jobs;" \
  scripts/restore-invariants.sql
grep -E '\| FAIL' "$NCDIR/nc5-invariants.txt" || echo "  NO FAIL -- the control did not control anything"

# NC6 and NC7 recompute rather than query, so they cannot ride a rollback:
# restore-verify.ts connects for itself. They tamper, run, and undo.
say "nc6 a title edited without its normalized column"
NC_ID=$(T -tAc "SELECT id FROM jobs ORDER BY canonical_key LIMIT 1")
NC_TITLE=$(T -tAc "SELECT title FROM jobs WHERE id='$NC_ID'")
T -c "UPDATE jobs SET title = title || ' (Fall)' WHERE id='$NC_ID'" >/dev/null
DATABASE_URL="$TGT_URL" npx tsx scripts/restore-verify.ts > "$NCDIR/nc6-verify.txt" 2>&1
grep -E '^FAIL' "$NCDIR/nc6-verify.txt" || echo "  NO FAIL -- the control did not control anything"
T -c "UPDATE jobs SET title = \$\$$NC_TITLE\$\$ WHERE id='$NC_ID'" >/dev/null

# NC7. A material fingerprint that no longer follows from its own row. This is
# the column that decides whether a role counts as changed, and a changed role
# used to have its send state cleared. A row count cannot see this at all.
say "nc7 a material fingerprint that no longer follows from its row"
NC_FP=$(T -tAc "SELECT material_fingerprint FROM jobs WHERE id='$NC_ID'")
T -c "UPDATE jobs SET material_fingerprint = md5('tampered') WHERE id='$NC_ID'" >/dev/null
DATABASE_URL="$TGT_URL" npx tsx scripts/restore-verify.ts > "$NCDIR/nc7-verify.txt" 2>&1
grep -E '^FAIL' "$NCDIR/nc7-verify.txt" || echo "  NO FAIL -- the control did not control anything"
T -c "UPDATE jobs SET material_fingerprint = '$NC_FP' WHERE id='$NC_ID'" >/dev/null

# The restored copy is back where it was: the SQL controls rolled back and the
# two recompute controls were undone.
T < scripts/restore-fingerprint.sql | sort > "$NCDIR/after-controls.txt"
say "the restored copy after the controls"
diff <(keys "$OUT/tgt-fingerprint.txt") <(keys "$NCDIR/after-controls.txt") \
  && echo "unchanged: the controls left nothing behind"
