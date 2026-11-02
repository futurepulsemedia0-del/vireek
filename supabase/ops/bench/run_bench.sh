#!/usr/bin/env bash
# Hot-path SQL benchmark with per-script p95. Run on staging / a copy seeded with seed_scale.sql.
#   DATABASE_URL=... BENCH_UID=<uuid> [CLIENTS=8] [DURATION=30] [MAX_P95_MS=50] supabase/ops/bench/run_bench.sh
# Requires pgbench (postgresql-client). Output: bench-results/summary.tsv. Exit 1 if any p95 > MAX_P95_MS.
set -euo pipefail
: "${DATABASE_URL:?}" "${BENCH_UID:?}"
CLIENTS=${CLIENTS:-8}; DURATION=${DURATION:-30}; OUT=${OUT:-bench-results}
case "$BENCH_UID" in *[!0-9a-fA-F-]*) echo "BENCH_UID must be a uuid" >&2; exit 2;; esac
rm -rf "$OUT"; mkdir -p "$OUT"
printf 'script\ttps\tp50_ms\tp95_ms\tp99_ms\tn\n' > "$OUT/summary.tsv"
fail=0
for f in "$(dirname "$0")"/bench_*.sql; do
  n=$(basename "$f" .sql)
  pgbench "$DATABASE_URL" -n -f "$f" -D uid="'$BENCH_UID'" -c "$CLIENTS" -j 2 -T "$DURATION" -l --log-prefix="$OUT/$n.log" > "$OUT/$n.txt"
  tps=$(awk '/^tps/ {print $3; exit}' "$OUT/$n.txt")
  # pgbench log column 3 = transaction latency in microseconds
  cat "$OUT"/"$n".log.* | awk '{print $3}' | sort -n > "$OUT/$n.lat"
  total=$(wc -l < "$OUT/$n.lat")
  pct() { awk -v p="$1" -v t="$total" 'NR==int(t*p+0.999999){printf "%.2f", $1/1000; exit}' "$OUT/$n.lat"; }
  p95=$(pct 0.95)
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$n" "$tps" "$(pct 0.50)" "$p95" "$(pct 0.99)" "$total" >> "$OUT/summary.tsv"
  if [ -n "${MAX_P95_MS:-}" ] && awk -v a="$p95" -v b="$MAX_P95_MS" 'BEGIN{exit !(a>b)}'; then echo "FAIL $n p95 ${p95}ms > ${MAX_P95_MS}ms" >&2; fail=1; fi
done
column -t -s$'\t' "$OUT/summary.tsv"
exit $fail
