#!/usr/bin/env bash
# Runs supabase/tests/database/*.test.sql against a throw-away LOCAL Postgres (no Docker / Supabase CLI needed).
# This is a development aid, not a substitute for `supabase test db`: the Supabase platform is only approximated by
# 00_supabase_shim.sql, and migrations that fail to replay are skipped (they are listed at the end).
#
# Needs: PostgreSQL 16 server binaries + pgTAP installed, and a superuser reachable via $PGHOST/$PGUSER (default: socket, postgres).
# Usage:  supabase/tests/local/run.sh [test-file-glob]      e.g.  run.sh '*_rls.test.sql'
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"
export PGHOST="${PGHOST:-/var/run/postgresql}" PGUSER="${PGUSER:-postgres}"
DB="vireek_rls_$$"
psql -qAt -d postgres -c "create database $DB" >/dev/null || exit 2
trap 'psql -qAt -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
P=(psql -qAt -v ON_ERROR_STOP=1 -d "$DB")

"${P[@]}" -f "$HERE/00_supabase_shim.sql" >/dev/null 2>&1 || { echo "shim failed (roles/publication may already exist cluster-wide; drop them or use a fresh cluster)"; exit 2; }
failed=()
for f in $(ls "$ROOT/supabase/migrations" | grep -E '^[0-9]{14}_.*\.sql$' | sort); do
  file="$ROOT/supabase/migrations/$f"
  # KNOWN BROKEN: references jobs.customer_phone, which does not exist -> warranty_claims is never created on replay.
  [ "$f" = "20261121000000_warranty_claim_recovery_os.sql" ] && { sed 's/^  j\.customer_phone,$/  NULL::text AS customer_phone,/' "$file" > "$HERE/.patched.sql"; file="$HERE/.patched.sql"; }
  "${P[@]}" -1 -f "$file" >/dev/null 2>&1 || failed+=("$f")
done
rm -f "$HERE/.patched.sql"
"${P[@]}" -f "$HERE/10_local_fixups.sql" >/dev/null || exit 2
echo "# migrations that did not apply: ${#failed[@]}"

rc=0
for t in "$ROOT"/supabase/tests/database/${1:-*.test.sql}; do
  out=$("${P[@]}" -f "$t" 2>&1); echo "== $(basename "$t")"
  echo "$out" | grep -E '^(not ok|# Failed|# Looks like|ERROR|psql:)' && true
  n=$(echo "$out" | grep -c '^ok \|^not ok ')
  if echo "$out" | grep -q '^psql:.*ERROR'; then rc=1; echo "   ERROR: file did not run to completion ($n assertions ran)"
  elif echo "$out" | grep -q '^# Looks like you planned'; then rc=1; echo "   FAILED: plan mismatch"
  elif echo "$out" | grep '^not ok' | grep -qv '# TODO'; then rc=1; echo "   FAILED"
  else echo "   passed ($n assertions; failing TODO items are known gaps and do not fail the run)"; fi
done
exit $rc
