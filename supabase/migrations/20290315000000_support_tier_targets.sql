/*
  # Support tier targets + tier-based overdue view (additive, idempotent)

  ## Why
  Plans map to a support tier (community / standard / priority / dedicated / enterprise).
  Staff need a place to set per-tier first-response / resolution targets and a view of tickets
  past their tier target. Targets are NULL until the owner sets them (TODO(owner)): with NULL
  nothing is tracked and no ticket appears as overdue.

  ## What this does NOT do
  - Does not touch support_conversations, its triggers, or the priority/severity clocks.
  - Does not publish anything to customers (internal only; TODO(counsel) before any public SLA).

  ## Security
  - support_tier_targets: RLS on, staff-only SELECT/UPDATE, no INSERT/DELETE, no anon access.
    Only the two minute columns are updatable (column grant); the tier key is immutable.
  - support_tier_overdue_tickets: runs with owner rights and filters on is_vireek_staff(auth.uid()),
    so non-staff get zero rows; anon has no grant.

  ## Clock start
  Uses support_conversations.created_at. If your live DB has internal_clock_started_at (severity
  migration), swap that column in the view: it is a single-line change marked below.

  ## Rollback
  DROP VIEW IF EXISTS public.support_tier_overdue_tickets;
  DROP FUNCTION IF EXISTS public.support_tier_for_plan(text);
  DROP TABLE IF EXISTS public.support_tier_targets;
*/

CREATE TABLE IF NOT EXISTS public.support_tier_targets (
  tier text PRIMARY KEY CHECK (tier IN ('community', 'standard', 'priority', 'dedicated', 'enterprise')),
  first_response_minutes integer CHECK (first_response_minutes IS NULL OR first_response_minutes BETWEEN 1 AND 100000),
  resolution_minutes integer CHECK (resolution_minutes IS NULL OR resolution_minutes BETWEEN 1 AND 100000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT support_tier_targets_order CHECK (
    first_response_minutes IS NULL OR resolution_minutes IS NULL OR first_response_minutes <= resolution_minutes
  )
);

INSERT INTO public.support_tier_targets (tier) VALUES
  ('community'), ('standard'), ('priority'), ('dedicated'), ('enterprise')
ON CONFLICT (tier) DO NOTHING;

ALTER TABLE public.support_tier_targets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.support_tier_targets FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.support_tier_targets TO authenticated;
GRANT UPDATE (first_response_minutes, resolution_minutes) ON public.support_tier_targets TO authenticated;

DROP POLICY IF EXISTS "staff_select_support_tier_targets" ON public.support_tier_targets;
CREATE POLICY "staff_select_support_tier_targets" ON public.support_tier_targets
  FOR SELECT TO authenticated
  USING (COALESCE(public.is_vireek_staff(auth.uid()), false));

DROP POLICY IF EXISTS "staff_update_support_tier_targets" ON public.support_tier_targets;
CREATE POLICY "staff_update_support_tier_targets" ON public.support_tier_targets
  FOR UPDATE TO authenticated
  USING (COALESCE(public.is_vireek_staff(auth.uid()), false))
  WITH CHECK (COALESCE(public.is_vireek_staff(auth.uid()), false));

CREATE OR REPLACE FUNCTION public.support_tier_targets_touch()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.tier := OLD.tier;
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_support_tier_targets_touch ON public.support_tier_targets;
CREATE TRIGGER trg_support_tier_targets_touch
  BEFORE UPDATE ON public.support_tier_targets
  FOR EACH ROW EXECUTE FUNCTION public.support_tier_targets_touch();

-- Mirror of resolveSupportTier() in src/lib/supportTiers.ts. Unknown / NULL => most restrictive.
CREATE OR REPLACE FUNCTION public.support_tier_for_plan(p_plan text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public AS $$
  SELECT CASE lower(btrim(COALESCE(p_plan, '')))
    WHEN 'starter' THEN 'standard'
    WHEN 'pro' THEN 'priority'
    WHEN 'professional' THEN 'priority'
    WHEN 'business' THEN 'dedicated'
    WHEN 'enterprise' THEN 'enterprise'
    ELSE 'community'
  END
$$;

-- Open tickets past their TIER target (staff only). Paused resolution clock while awaiting_customer.
CREATE OR REPLACE VIEW public.support_tier_overdue_tickets AS
WITH clocks AS (
  SELECT
    c.id,
    c.ticket_number,
    t.tier,
    CASE WHEN c.first_response_at IS NULL AND t.first_response_minutes IS NOT NULL
      THEN c.created_at /* swap to c.internal_clock_started_at if present */ + make_interval(mins => t.first_response_minutes)
    END AS first_due,
    CASE WHEN c.resolved_at IS NULL AND NOT c.awaiting_customer AND t.resolution_minutes IS NOT NULL
      THEN c.created_at /* swap to c.internal_clock_started_at if present */ + make_interval(mins => t.resolution_minutes)
    END AS resolution_due
  FROM public.support_conversations c
  LEFT JOIN public.profiles p ON p.id = c.account_owner_id
  JOIN public.support_tier_targets t ON t.tier = public.support_tier_for_plan(p.plan)
  WHERE c.kind = 'ticket'
    AND c.status <> 'closed'
    AND COALESCE(public.is_vireek_staff(auth.uid()), false)
)
SELECT id, ticket_number, tier, 'first_response'::text AS overdue_kind,
       floor(extract(epoch FROM (now() - first_due)))::bigint AS overdue_seconds
FROM clocks WHERE first_due < now()
UNION ALL
SELECT id, ticket_number, tier, 'resolution'::text,
       floor(extract(epoch FROM (now() - resolution_due)))::bigint
FROM clocks WHERE resolution_due < now();

REVOKE ALL ON public.support_tier_overdue_tickets FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.support_tier_overdue_tickets TO authenticated;
