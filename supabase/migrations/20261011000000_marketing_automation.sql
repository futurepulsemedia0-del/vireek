/*
  # Marketing Automation (item 18)

  Adds: segments, drip/lifecycle/reactivation/referral campaigns + steps +
  enrollments + sends, lead scoring, attribution touches, referral codes/
  conversions, and an event queue so campaigns can react to `leads`/`jobs`
  changes without any edge function or app code having to know about
  marketing — two triggers on existing tables push events into the queue.

  ## Design notes
  - RLS follows this project's standard: `public.get_account_owner_id()`,
    same as every other tenant table (see cash_flow_settings, leads, jobs).
  - Nothing existing is altered except two new trigger-only functions on
    `leads` and `jobs`, and one new nullable column on `customers`
    (`referred_by_code`). No existing column, policy, or row is touched.
  - Sending (email/Resend, SMS/Twilio) happens in edge functions, not SQL —
    this migration only stores what/when to send and what happened.
  - Verify column names below (`jobs.job_status`, `jobs.invoice_status`,
    `jobs.customer_id`, `leads.stage`) still match your live schema before
    running — they're taken from your original migrations but you said
    you've since changed a lot by hand.
*/

-- =============================================================
-- SEGMENTS
-- =============================================================

CREATE TABLE IF NOT EXISTS marketing_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  name text NOT NULL,
  description text,
  -- entity: 'customer' | 'lead'. Optional keys: lifecycle_stage[], stage[],
  -- tags[], source[], min_score, max_score, inactive_days.
  filter jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_dynamic boolean NOT NULL DEFAULT true,
  member_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE marketing_segments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_marketing_segments" ON marketing_segments
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
CREATE POLICY "insert_own_marketing_segments" ON marketing_segments
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
CREATE POLICY "update_own_marketing_segments" ON marketing_segments
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
CREATE POLICY "delete_own_marketing_segments" ON marketing_segments
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS marketing_segment_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_id uuid NOT NULL REFERENCES marketing_segments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT auth.uid(),
  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES leads(id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  CHECK (customer_id IS NOT NULL OR lead_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_segment_members_unique_customer
  ON marketing_segment_members(segment_id, customer_id) WHERE customer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_segment_members_unique_lead
  ON marketing_segment_members(segment_id, lead_id) WHERE lead_id IS NOT NULL;

ALTER TABLE marketing_segment_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_segment_members" ON marketing_segment_members
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- CAMPAIGNS, STEPS, ENROLLMENTS, SENDS
-- =============================================================

CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  name text NOT NULL,
  campaign_type text NOT NULL DEFAULT 'drip'
    CHECK (campaign_type IN ('drip', 'lifecycle', 'reactivation', 'referral')),
  segment_id uuid REFERENCES marketing_segments(id) ON DELETE SET NULL,
  trigger_type text NOT NULL DEFAULT 'segment_entry'
    CHECK (trigger_type IN ('segment_entry', 'event', 'manual')),
  -- used only when trigger_type = 'event': 'lead_created' | 'job_completed' | 'job_paid'
  trigger_event text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused')),
  goal_event text, -- e.g. 'job_paid' — used to mark enrollments 'converted'
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE marketing_campaigns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_marketing_campaigns" ON marketing_campaigns
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
CREATE POLICY "insert_own_marketing_campaigns" ON marketing_campaigns
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
CREATE POLICY "update_own_marketing_campaigns" ON marketing_campaigns
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
CREATE POLICY "delete_own_marketing_campaigns" ON marketing_campaigns
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS marketing_campaign_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT auth.uid(),
  step_order integer NOT NULL,
  delay_hours integer NOT NULL DEFAULT 0,
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  subject text, -- email only
  body text NOT NULL, -- supports {{name}}, {{company_name}} placeholders
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, step_order)
);

ALTER TABLE marketing_campaign_steps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_campaign_steps" ON marketing_campaign_steps
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
CREATE POLICY "insert_own_campaign_steps" ON marketing_campaign_steps
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
CREATE POLICY "update_own_campaign_steps" ON marketing_campaign_steps
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
CREATE POLICY "delete_own_campaign_steps" ON marketing_campaign_steps
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS marketing_campaign_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT auth.uid(),
  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES leads(id) ON DELETE CASCADE,
  contact_email text,
  contact_phone text,
  current_step integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'stopped', 'converted')),
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  next_send_at timestamptz,
  converted_at timestamptz,
  CHECK (customer_id IS NOT NULL OR lead_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_enrollments_due
  ON marketing_campaign_enrollments(status, next_send_at) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollments_unique_customer
  ON marketing_campaign_enrollments(campaign_id, customer_id) WHERE customer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollments_unique_lead
  ON marketing_campaign_enrollments(campaign_id, lead_id) WHERE lead_id IS NOT NULL;

ALTER TABLE marketing_campaign_enrollments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_enrollments" ON marketing_campaign_enrollments
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
CREATE POLICY "update_own_enrollments" ON marketing_campaign_enrollments
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS marketing_campaign_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id uuid NOT NULL REFERENCES marketing_campaign_enrollments(id) ON DELETE CASCADE,
  step_id uuid NOT NULL REFERENCES marketing_campaign_steps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  status text NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  provider_ref text,
  error text,
  sent_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_campaign_sends_enrollment ON marketing_campaign_sends(enrollment_id);

ALTER TABLE marketing_campaign_sends ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_campaign_sends" ON marketing_campaign_sends
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- LEAD SCORING
-- =============================================================

CREATE TABLE IF NOT EXISTS lead_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES leads(id) ON DELETE CASCADE,
  score integer NOT NULL DEFAULT 0,
  grade text NOT NULL DEFAULT 'cold' CHECK (grade IN ('cold', 'warm', 'hot')),
  factors jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (customer_id IS NOT NULL OR lead_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_scores_unique_customer
  ON lead_scores(customer_id) WHERE customer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_scores_unique_lead
  ON lead_scores(lead_id) WHERE lead_id IS NOT NULL;

ALTER TABLE lead_scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_lead_scores" ON lead_scores
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- ATTRIBUTION
-- =============================================================

CREATE TABLE IF NOT EXISTS marketing_attribution_touches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  anonymous_id text NOT NULL,
  source text,
  medium text,
  campaign text,
  utm_content text,
  utm_term text,
  referrer text,
  landing_page text,
  is_first_touch boolean NOT NULL DEFAULT false,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attribution_user ON marketing_attribution_touches(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_attribution_anon ON marketing_attribution_touches(anonymous_id);

ALTER TABLE marketing_attribution_touches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_attribution" ON marketing_attribution_touches
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- REFERRALS
-- =============================================================

CREATE TABLE IF NOT EXISTS referral_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE,
  reward_type text NOT NULL DEFAULT 'credit' CHECK (reward_type IN ('credit', 'discount', 'cash')),
  reward_value numeric(10,2) NOT NULL DEFAULT 0,
  clicks integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE referral_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_referral_codes" ON referral_codes
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
CREATE POLICY "insert_own_referral_codes" ON referral_codes
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
CREATE POLICY "update_own_referral_codes" ON referral_codes
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS referral_conversions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_code_id uuid NOT NULL REFERENCES referral_codes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  referred_customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  referred_lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'converted', 'rewarded')),
  converted_at timestamptz,
  rewarded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_conversions_unique_customer
  ON referral_conversions(referral_code_id, referred_customer_id) WHERE referred_customer_id IS NOT NULL;

ALTER TABLE referral_conversions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_referral_conversions" ON referral_conversions
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
CREATE POLICY "update_own_referral_conversions" ON referral_conversions
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

-- customers.referred_by_code: set by your signup/booking flow when a lead
-- arrives via a referral link (?ref=CODE). Nullable, purely additive.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS referred_by_code text;

-- =============================================================
-- EVENT QUEUE (drives trigger_type = 'event' campaigns)
-- =============================================================

CREATE TABLE IF NOT EXISTS marketing_event_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  event_type text NOT NULL, -- 'lead_created' | 'job_completed' | 'job_paid'
  customer_id uuid,
  lead_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  processed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_queue_unprocessed
  ON marketing_event_queue(processed, created_at) WHERE processed = false;

ALTER TABLE marketing_event_queue ENABLE ROW LEVEL SECURITY;
-- Service-role only (engine-tick reads/writes this with the service key);
-- no authenticated policy is added on purpose — nothing in the dashboard
-- needs to query it directly.

-- Push a 'lead_created' event whenever a new lead lands.
CREATE OR REPLACE FUNCTION public.marketing_handle_lead_created()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO marketing_event_queue (user_id, event_type, lead_id, payload)
  VALUES (NEW.user_id, 'lead_created', NEW.id, jsonb_build_object('email', NEW.email, 'phone', NEW.phone));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_marketing_lead_created ON leads;
CREATE TRIGGER trg_marketing_lead_created
  AFTER INSERT ON leads
  FOR EACH ROW EXECUTE FUNCTION public.marketing_handle_lead_created();

-- Push 'job_completed' / 'job_paid' events, and auto-convert a referral
-- the moment a referred customer's job is marked paid.
CREATE OR REPLACE FUNCTION public.marketing_handle_job_status_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_referred_code text;
  v_referral_code_id uuid;
BEGIN
  IF NEW.job_status = 'completed' AND (OLD.job_status IS DISTINCT FROM 'completed') THEN
    INSERT INTO marketing_event_queue (user_id, event_type, customer_id, lead_id, payload)
    VALUES (NEW.user_id, 'job_completed', NEW.customer_id, NEW.lead_id, jsonb_build_object('job_id', NEW.id));
  END IF;

  IF NEW.invoice_status = 'paid' AND (OLD.invoice_status IS DISTINCT FROM 'paid') THEN
    INSERT INTO marketing_event_queue (user_id, event_type, customer_id, lead_id, payload)
    VALUES (NEW.user_id, 'job_paid', NEW.customer_id, NEW.lead_id, jsonb_build_object('job_id', NEW.id, 'amount', NEW.invoice_amount));

    IF NEW.customer_id IS NOT NULL THEN
      SELECT referred_by_code INTO v_referred_code FROM customers WHERE id = NEW.customer_id;
      IF v_referred_code IS NOT NULL THEN
        SELECT id INTO v_referral_code_id FROM referral_codes
          WHERE code = v_referred_code AND user_id = NEW.user_id;
        IF v_referral_code_id IS NOT NULL THEN
          INSERT INTO referral_conversions (referral_code_id, user_id, referred_customer_id, status, converted_at)
          VALUES (v_referral_code_id, NEW.user_id, NEW.customer_id, 'converted', now())
          ON CONFLICT (referral_code_id, referred_customer_id)
          DO UPDATE SET status = 'converted', converted_at = now()
          WHERE referral_conversions.status = 'pending';
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_marketing_job_status_change ON jobs;
CREATE TRIGGER trg_marketing_job_status_change
  AFTER UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.marketing_handle_job_status_change();
