#!/usr/bin/env bash
# Concurrency test for claim_backfill_offer on a STUB schema (see 00_stub_schema.sql). Usage:
#   createdb cg && psql -v ON_ERROR_STOP=1 -f 00_stub_schema.sql cg && psql -v ON_ERROR_STOP=1 -f ../../migrations/20281101000000_capacity_guard.sql cg
#   psql -f 01_gap_and_offers_setup.sql cg && ./race.sh cg
# Expect: exactly 1 "claimed", 11 "already_filled". NOTE: book_capacity_slot is a stub here; re-run the race on a staging DB with the real function.
DB="${1:?db name}"; N=12; tmp=$(mktemp -d)
for g in $(seq 0 $((N-1))); do psql -q -t -A -d "$DB" -c "select 'R '||((public.claim_backfill_offer('t$g'))->>'status');" > "$tmp/o$g" 2>&1 & done; wait
cat "$tmp"/o* | sort | uniq -c
c=$(cat "$tmp"/o* | grep -c "R claimed"); [ "$c" = "1" ] && echo PASS || { echo "FAIL: $c claims"; exit 1; }
