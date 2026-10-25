-- Value Scoreboard — demo data (DEV / STAGING ONLY — never run against production).
-- Seeds ~4 months of realistic measured + estimated events for the demo account
-- (a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11, created by 20260821101216_seed_demo_data.sql).
-- Safe to run repeatedly: dedupe makes every insert a no-op the second time.
--
-- To remove the demo rows later (the ledger is append-only, so triggers must be paused first):
--   alter table value_events disable trigger trg_value_events_append_only;
--   delete from value_events where evidence_ref like 'demo:%';
--   alter table value_events enable trigger trg_value_events_append_only;

do $$
declare
  v_user constant uuid := 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
  m integer;
  i integer;
  v_base timestamptz;
begin
  if not exists (select 1 from profiles where id = v_user) then
    raise notice 'Demo account not found - nothing seeded.';
    return;
  end if;

  insert into value_settings (user_id, avg_ticket_cents, close_rate_bp, minutes_per_handled_call)
  values (v_user, 42000, 2500, 3)
  on conflict (user_id) do nothing;

  for m in 0..3 loop
    v_base := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC' - make_interval(months => m);

    -- Measured: after-hours calls that became paid jobs (grows month over month).
    for i in 1..(4 + (3 - m) * 2) loop
      perform public.value_emit_event(v_user, 'after_hours_answering', 'recovered_revenue',
        (32000 + (i * 7919) % 41000)::bigint, 'cents', 'USD', 'measured',
        '[DEMO] After-hours call answered, job booked and paid.',
        'demo:job-' || m || '-' || i, v_base + make_interval(days => 1 + (i * 3) % 24, hours => 9),
        'demo:call-' || m || '-' || i);
    end loop;

    -- Measured: lost opportunities followed up and paid.
    for i in 1..(2 + (3 - m)) loop
      perform public.value_emit_event(v_user, 'revenue_recovery', 'recovered_revenue',
        (28000 + (i * 6203) % 52000)::bigint, 'cents', 'USD', 'measured',
        '[DEMO] Missed call followed up, then its job was paid.',
        'demo:recovery-' || m || '-' || i, v_base + make_interval(days => 2 + (i * 5) % 22, hours => 14), null);
    end loop;

    -- Estimated: booked after-hours calls not yet paid.
    for i in 1..3 loop
      perform public.value_emit_event(v_user, 'after_hours_answering', 'recovered_revenue',
        10500, 'cents', 'USD', 'estimated',
        '[DEMO] After-hours call booked. Estimated at average ticket x close rate (25.0%).',
        'demo:est-call-' || m || '-' || i, v_base + make_interval(days => 20 + i, hours => 18), null);
    end loop;

    -- Estimated: time saved on handled calls.
    for i in 1..(30 + (3 - m) * 10) loop
      perform public.value_emit_event(v_user, 'call_handling', 'saved_hours', 3, 'minutes', null, 'estimated',
        '[DEMO] Call handled by Vireek. Estimated at 3 staff minutes per call.',
        'demo:time-' || m || '-' || i, v_base + make_interval(days => (i % 27), hours => 8 + (i % 9)), null);
    end loop;
  end loop;
end $$;
