#!/usr/bin/env bash
# Webhook fan-out load + correctness test (DB side: claim/complete/outbox).
# Seeds ENDPOINTS x PER_ENDPOINT deliveries for a throw-away tenant, drains them with WORKERS parallel
# workers (the same claim_webhook_deliveries / complete_webhook_delivery RPCs the worker uses), then asserts:
#   - every delivery was delivered exactly once (attempts = 1, no duplicates, none lost)
#   - total claims == total rows (FOR UPDATE SKIP LOCKED gave disjoint batches)
# Run ONLY against a local/staging DB. It creates and finally deletes its own tenant.
#   DATABASE_URL=postgres://... ./scripts/load/webhook-fanout.sh   (defaults: 50 x 400, 8 workers)
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL (local or staging, never production)}"
ENDPOINTS="${ENDPOINTS:-50}"; PER_ENDPOINT="${PER_ENDPOINT:-400}"; WORKERS="${WORKERS:-8}"; BATCH="${BATCH:-25}"
TOTAL=$((ENDPOINTS * PER_ENDPOINT))
Q() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qAt "$@"; }
TENANT="$(Q -c "insert into profiles(id) values (gen_random_uuid()) returning id")"
cleanup() { Q -c "delete from webhook_outbox where user_id='$TENANT'; delete from webhook_endpoints where user_id='$TENANT'; delete from profiles where id='$TENANT'" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# The claim RPC is global (not per tenant): refuse to run if it could touch anyone else's queued deliveries.
foreign=$(Q -c "select count(*) from webhook_outbox where user_id <> '$TENANT' and status in ('pending','delivering')")
if [ "$foreign" -ne 0 ]; then echo "ABORT: $foreign queued deliveries of other tenants exist. Run on an empty local database." >&2; exit 2; fi

t0=$(date +%s.%N)
Q -c "
insert into webhook_endpoints(user_id,url,events)
  select '$TENANT','https://example.com/hook/'||g,'{lead.created}' from generate_series(1,$ENDPOINTS) g;
insert into webhook_outbox(user_id,endpoint_id,event_type,payload)
  select '$TENANT', e.id, 'lead.created', jsonb_build_object('n', g)
    from webhook_endpoints e cross join generate_series(1,$PER_ENDPOINT) g where e.user_id='$TENANT';" >/dev/null
t1=$(date +%s.%N)

worker() {
  Q -c "
  do \$\$
  declare r record; n int := 0; got int;
  begin
    loop
      got := 0;
      for r in select * from claim_webhook_deliveries($BATCH, 60) loop
        perform complete_webhook_delivery(r.id, 'delivered', 200, null, null, 8);
        got := got + 1; n := n + 1;
      end loop;
      exit when got = 0;
    end loop;
    raise notice 'claimed=%', n;
  end \$\$;" 2>&1 | { grep -E 'claimed=|ERROR|deadlock' || true; } | sed -e 's/.*claimed=//'
}
pids=(); outs=()
for i in $(seq 1 "$WORKERS"); do f=$(mktemp); outs+=("$f"); worker > "$f" & pids+=($!); done
for p in "${pids[@]}"; do wait "$p"; done
t2=$(date +%s.%N)

claimed=0; for f in "${outs[@]}"; do c=$(cat "$f"); claimed=$((claimed + ${c:-0})); rm -f "$f"; done
delivered=$(Q -c "select count(*) from webhook_outbox where user_id='$TENANT' and status='delivered' and attempts=1")
other=$(Q -c "select count(*) from webhook_outbox where user_id='$TENANT' and not (status='delivered' and attempts=1)")
printf 'rows=%s workers=%s seed=%.2fs drain=%.2fs throughput=%.0f deliveries/s\n' "$TOTAL" "$WORKERS" "$(echo "$t1-$t0"|bc)" "$(echo "$t2-$t1"|bc)" "$(echo "$TOTAL/($t2-$t1)"|bc -l)"
echo "claimed=$claimed delivered_once=$delivered anomalies=$other"
if [ "$claimed" -eq "$TOTAL" ] && [ "$delivered" -eq "$TOTAL" ] && [ "$other" -eq 0 ]; then echo "PASS: no loss, no duplicate claims"; else echo "FAIL" >&2; exit 1; fi
