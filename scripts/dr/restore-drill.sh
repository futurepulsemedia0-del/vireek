#!/usr/bin/env bash
# scripts/dr/restore-drill.sh — helper for the restore drill (docs/runbooks/restore-drill-log.md).
# It NEVER restores anything; it only (a) writes timestamped marker rows to a STAGING db and (b) verifies them on the restored db.
#
#   STAGING_DB_URL=postgres://... PRODUCTION_DB_HOST=db.<prod-ref>.supabase.co scripts/dr/restore-drill.sh marker [count] [interval_s]
#   RESTORED_DB_URL=postgres://... scripts/dr/restore-drill.sh verify
#
# Safety: refuses to run if the URL contains PRODUCTION_DB_HOST. Uses table dr_drill_markers (created if missing, additive).
set -euo pipefail
cmd="${1:-}"; ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
guard() {
  local url="$1"
  [ -n "$url" ] || { echo "missing DB url" >&2; exit 2; }
  [ -n "${PRODUCTION_DB_HOST:-}" ] || { echo "set PRODUCTION_DB_HOST so the guard can refuse production" >&2; exit 2; }
  case "$url" in *"$PRODUCTION_DB_HOST"*) echo "REFUSING: URL matches PRODUCTION_DB_HOST" >&2; exit 3;; esac
}
case "$cmd" in
  marker)
    guard "${STAGING_DB_URL:-}"
    n="${2:-30}"; every="${3:-10}"
    psql "$STAGING_DB_URL" -v ON_ERROR_STOP=1 -c "create table if not exists public.dr_drill_markers (id bigserial primary key, written_at timestamptz not null default now(), note text); alter table public.dr_drill_markers enable row level security;" >/dev/null
    echo "START $(ts)"
    for i in $(seq 1 "$n"); do
      psql "$STAGING_DB_URL" -qAt -v ON_ERROR_STOP=1 -c "insert into public.dr_drill_markers(note) values ('drill #$i') returning id || ' ' || written_at;"
      sleep "$every"
    done
    echo "END $(ts)  -> pick a restore target time inside [START, END]; RPO = END of marker run minus newest surviving marker" ;;
  verify)
    guard "${RESTORED_DB_URL:-}"
    echo "VERIFY started $(ts)"
    psql "$RESTORED_DB_URL" -v ON_ERROR_STOP=1 -c "select count(*) as markers, min(written_at) as first, max(written_at) as newest from public.dr_drill_markers;" \
      -c "select (select count(*) from public.calls) as calls, (select count(*) from public.jobs) as jobs, (select count(*) from public.profiles) as profiles;" \
      -c "select now() as restored_db_clock;"
    echo "Compare 'newest' with your target time and the marker run window. Record in docs/runbooks/restore-drill-log.md" ;;
  *) echo "usage: marker|verify (see header)" >&2; exit 1;;
esac
