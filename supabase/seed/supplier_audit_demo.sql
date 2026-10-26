/*
  Supplier Entitlement Audit — DEMO DATA (run in the Supabase SQL editor, AFTER the migration).
  1) Change v_email below to YOUR login email.  2) Run.  3) Open /dashboard/supplier-audit and press "Run audit".

  Creates 2 demo distributors with 12 months of statements (last calendar year) and planted issues:
    Demo Distributor A : volume rebate (tiers) with a SHORT rebate payment, an unapplied credit memo, unclaimed co-op,
                         a repeated invoice line, two low-confidence lines (review queue), an approved warranty claim with no credit
    Demo Distributor B : price agreement with 3 months billed above the agreed price
  Safe to run twice (it skips if the demo vendors already exist). Cleanup statement is at the bottom.
*/
DO $$
DECLARE
  v_email text := 'CHANGE_ME@example.com';
  v_owner uuid;
  v_year int := extract(year FROM current_date)::int - 1;
  v_a uuid; v_b uuid; v_prog_a uuid;
  v_st uuid; m int; v_start date; v_end date; n int;
BEGIN
  SELECT p.id INTO v_owner FROM profiles p JOIN auth.users u ON u.id = p.id WHERE lower(u.email) = lower(v_email);
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'No account found for email %. Edit v_email at the top of this script.', v_email;
  END IF;
  IF EXISTS (SELECT 1 FROM vendors WHERE user_id = v_owner AND name = 'Demo Distributor A') THEN
    RAISE NOTICE 'Demo data already present — nothing to do.'; RETURN;
  END IF;

  INSERT INTO vendors (user_id, name, active) VALUES (v_owner, 'Demo Distributor A', true) RETURNING id INTO v_a;
  INSERT INTO vendors (user_id, name, active) VALUES (v_owner, 'Demo Distributor B', true) RETURNING id INTO v_b;

  -- Programs (rules are data) ---------------------------------------------------------------
  INSERT INTO supplier_programs (user_id, vendor_id, name, program_type, status, period_start, period_end, enrollment_status,
      claim_deadline, source_url, last_verified_at, rules)
  VALUES (v_owner, v_a, 'Demo annual volume rebate', 'volume_rebate', 'active', make_date(v_year, 1, 1), make_date(v_year, 12, 31), 'enrolled',
      current_date + 40, 'https://example.com/demo-volume-rebate', current_date - 60,
      '{"tier_mode":"retroactive_all","tiers":[{"threshold_cents":20000000,"rate_bps":150},{"threshold_cents":40000000,"rate_bps":250}]}'::jsonb)
  RETURNING id INTO v_prog_a;

  INSERT INTO supplier_programs (user_id, vendor_id, name, program_type, status, period_start, period_end, enrollment_status,
      claim_deadline, source_url, last_verified_at, required_documents, documents_on_file, rules)
  VALUES (v_owner, v_a, 'Demo co-op marketing fund', 'co_op', 'active', make_date(v_year, 1, 1), make_date(v_year, 12, 31), 'enrolled',
      current_date + 25, 'https://example.com/demo-co-op', current_date - 60, ARRAY['Proof of advertising'], '{}',
      '{"coop_accrual_bps":200,"coop_cap_cents":1000000}'::jsonb);

  INSERT INTO supplier_programs (user_id, vendor_id, name, program_type, status, period_start, period_end, enrollment_status,
      claim_deadline, source_url, last_verified_at, rules)
  VALUES (v_owner, v_b, 'Demo contractor pricing agreement', 'price_agreement', 'active', make_date(v_year, 1, 1), make_date(v_year, 12, 31), 'not_required',
      current_date + 60, 'https://example.com/demo-pricing', current_date - 30,
      '{"tolerance_bps":100,"tolerance_cents":0,"price_schedule":[{"sku":"COMP-100","unit_price_cents":12000},{"sku":"FILT-10","unit_price_cents":850}]}'::jsonb);

  -- 12 monthly statements per distributor ---------------------------------------------------
  FOR m IN 1..12 LOOP
    v_start := make_date(v_year, m, 1);
    v_end := (v_start + interval '1 month' - interval '1 day')::date;

    INSERT INTO supplier_statements (user_id, vendor_id, period_start, period_end, source_kind, source_file_name, parse_status, line_count)
    VALUES (v_owner, v_a, v_start, v_end, 'csv', 'demo-a-' || v_year || '-' || lpad(m::text, 2, '0') || '.csv', 'reviewed', 2)
    RETURNING id INTO v_st;
    INSERT INTO supplier_statement_lines (user_id, statement_id, line_no, invoice_no, invoice_date, sku, description, qty, unit_price_cents, extended_cents, confidence, review_status)
    VALUES
      (v_owner, v_st, 1, 'A-' || v_year || lpad(m::text, 2, '0') || '-1', v_start + 4, 'AC-200', 'Demo condensing unit', 10, 190000, 1900000, 0.98, 'auto_accepted'),
      (v_owner, v_st, 2, 'A-' || v_year || lpad(m::text, 2, '0') || '-2', v_start + 18, 'AC-200', 'Demo condensing unit', 10, 190000, 1900000, 0.98, 'auto_accepted');
    n := 2;
    IF m = 7 THEN -- planted duplicate: identical line repeated under the same invoice number
      INSERT INTO supplier_statement_lines (user_id, statement_id, line_no, invoice_no, invoice_date, sku, description, qty, unit_price_cents, extended_cents, confidence, review_status)
      VALUES (v_owner, v_st, 3, 'A-' || v_year || '07-1', v_start + 4, 'AC-200', 'Demo condensing unit', 10, 190000, 1900000, 0.98, 'auto_accepted');
      n := 3;
    END IF;
    IF m = 12 THEN -- planted low-confidence lines -> review queue (never counted until confirmed)
      INSERT INTO supplier_statement_lines (user_id, statement_id, line_no, invoice_no, invoice_date, sku, description, qty, unit_price_cents, extended_cents, confidence, review_status)
      VALUES (v_owner, v_st, 3, 'A-' || v_year || '12-3', v_start + 20, 'AC-200', 'Blurry scan', 4, NULL, 760000, 0.55, 'needs_review'),
             (v_owner, v_st, 4, 'A-' || v_year || '12-4', NULL, 'AC-300', 'Blurry scan', 2, NULL, NULL, 0.40, 'needs_review');
      n := 4;
      UPDATE supplier_statements SET parse_status = 'needs_review' WHERE id = v_st;
    END IF;
    UPDATE supplier_statements SET line_count = n WHERE id = v_st;

    INSERT INTO supplier_statements (user_id, vendor_id, period_start, period_end, source_kind, source_file_name, parse_status, line_count)
    VALUES (v_owner, v_b, v_start, v_end, 'csv', 'demo-b-' || v_year || '-' || lpad(m::text, 2, '0') || '.csv', 'reviewed', 2)
    RETURNING id INTO v_st;
    INSERT INTO supplier_statement_lines (user_id, statement_id, line_no, invoice_no, invoice_date, sku, description, qty, unit_price_cents, extended_cents, confidence, review_status)
    VALUES
      (v_owner, v_st, 1, 'B-' || v_year || lpad(m::text, 2, '0') || '-1', v_start + 6, 'COMP-100', 'Demo compressor', 20,
         CASE WHEN m BETWEEN 4 AND 6 THEN 12800 ELSE 12000 END, 20 * CASE WHEN m BETWEEN 4 AND 6 THEN 12800 ELSE 12000 END, 0.99, 'auto_accepted'),
      (v_owner, v_st, 2, 'B-' || v_year || lpad(m::text, 2, '0') || '-2', v_start + 12, 'FILT-10', 'Demo filter drier', 50, 850, 42500, 0.99, 'auto_accepted');
  END LOOP;

  -- Credit memos -------------------------------------------------------------------------------
  INSERT INTO supplier_credit_memos (user_id, vendor_id, memo_no, memo_date, amount_cents, applied_cents, reason, applied_status)
  VALUES (v_owner, v_a, 'CM-DEMO-1', current_date - 90, 185000, 0, 'price_adjustment', 'unapplied');
  INSERT INTO supplier_credit_memos (user_id, vendor_id, memo_no, memo_date, amount_cents, applied_cents, reason, applied_status, program_id)
  VALUES (v_owner, v_a, 'CM-DEMO-2', current_date - 20, 500000, 500000, 'rebate', 'applied', v_prog_a);

  -- Warranty claim approved, no credit after 70 days -----------------------------------------------
  INSERT INTO warranty_claims (user_id, customer_name, manufacturer, distributor, part_description, status, submitted_at, claimed_amount_cents, approved_amount_cents, claim_deadline)
  VALUES (v_owner, 'Demo Customer', 'Demo Manufacturer', 'Demo Distributor A', 'compressor', 'approved', now() - interval '70 days', 120000, 110000, current_date + 20);

  RAISE NOTICE 'Supplier audit demo data created for %. Open /dashboard/supplier-audit and press "Run audit".', v_email;
END $$;

/* CLEANUP (run manually when done; only works while the demo has no confirmed recoveries):
   DELETE FROM warranty_claims WHERE customer_name = 'Demo Customer';
   DELETE FROM vendors WHERE name IN ('Demo Distributor A', 'Demo Distributor B');   -- cascades programs, statements, lines, memos, findings
*/
