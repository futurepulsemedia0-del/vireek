/*
  # Results Plan — DRAFT pricing terms (two hybrid candidates)

  Inserts two candidate terms rows for human review. NOTHING here approves, publishes or activates anything.

  ## Guarantees (every row written by this migration)
  - status = 'draft', is_public = false, approved_by = NULL, approved_at = NULL
  - rule_version = 'rp-rules-v1' (left UNPUBLISHED: results_plan_rule_versions.published_at stays NULL; this file does not touch it)
  - Never calls rp_staff_approve_terms() / rp_staff_publish_rules()
  - Idempotent: a row is skipped when ANY row with the same name already exists (any status), and a partial unique index
    on (name) WHERE status = 'draft' + ON CONFLICT DO NOTHING makes concurrent re-runs safe.

  ## Mapping note (hybrid)
  Constraint rp_terms_model_fee (migration 20280402000100) requires monthly_floor_cents = 0 for model 'hybrid'
  (the same rule exists in _shared/results-plan/pricing.ts: 'hybrid_has_floor'). The monthly platform fee of a hybrid plan
  therefore lives in base_fee_cents (this is also the column results-plan-enroll compares with the Stripe base price).

  ## Known approval blockers (intentionally NOT filled in: they are human decisions)
  - guarantee_minutes_cap is NULL -> rp_staff_approve_terms() raises GUARANTEE_CAPS_REQUIRED while guarantee_days > 0.
  - See docs/results-plan-approval-checklist.md.

  ## Requires
  20280402000000, 20280402000100, 20280402000200 (fair_use_minutes column, rule version 'rp-rules-v1').

  ## Rollback (only drafts, never touches approved/retired rows)
    DELETE FROM results_plan_pricing_terms
     WHERE name IN ('Draft - Hybrid 99', 'Draft - Hybrid 249')
       AND status = 'draft' AND approved_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM results_plan_accounts a WHERE a.terms_id = results_plan_pricing_terms.id);
    DROP INDEX IF EXISTS uq_rp_terms_draft_name;
*/

DO $$
BEGIN
  IF to_regclass('public.results_plan_pricing_terms') IS NULL THEN
    RAISE EXCEPTION 'results_plan_pricing_terms is missing: run 20280402000100_results_plan_billing_disputes.sql first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'results_plan_pricing_terms' AND column_name = 'fair_use_minutes') THEN
    RAISE EXCEPTION 'fair_use_minutes is missing: run 20280402000200_results_plan_hardening.sql first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM results_plan_rule_versions WHERE version = 'rp-rules-v1') THEN
    RAISE EXCEPTION 'rule version rp-rules-v1 is missing: run 20280402000000_results_plan_proof_ledger.sql first';
  END IF;
END $$;

-- Two DRAFT rows can never share a name (approved / retired history may reuse names).
CREATE UNIQUE INDEX IF NOT EXISTS uq_rp_terms_draft_name
  ON results_plan_pricing_terms (name) WHERE status = 'draft';

INSERT INTO results_plan_pricing_terms (
  name, status, model, currency,
  base_fee_cents, per_job_cents, monthly_floor_cents, monthly_cap_cents,
  guarantee_days, guarantee_cap_cents, trial_days, fair_use_minutes,
  rule_version, is_public, approved_by, approved_at
)
SELECT v.name, 'draft', 'hybrid', 'USD',
       v.base_fee_cents, v.per_job_cents, 0, v.monthly_cap_cents,
       30, v.guarantee_cap_cents, 14, v.fair_use_minutes,
       'rp-rules-v1', false, NULL::uuid, NULL::timestamptz
  FROM (VALUES
    ('Draft - Hybrid 99'::text,  9900::integer, 1500::integer, 24900::integer,  9900::integer,  300::integer),
    ('Draft - Hybrid 249'::text, 24900::integer, 1200::integer, 54900::integer, 24900::integer, 700::integer)
  ) AS v(name, base_fee_cents, per_job_cents, monthly_cap_cents, guarantee_cap_cents, fair_use_minutes)
 WHERE NOT EXISTS (SELECT 1 FROM results_plan_pricing_terms t WHERE t.name = v.name)
ON CONFLICT (name) WHERE status = 'draft' DO NOTHING;
