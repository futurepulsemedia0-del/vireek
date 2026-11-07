/*
  # Dispatch near-tie randomization — settings + audit log

  Additive only. Default OFF: no row = disabled. Nothing here changes existing tables.
  - dispatch_randomization_settings: one row per business (account owner). Kill switch = enabled=false
    (read on EVERY auto-assign run, so it takes effect immediately).
  - dispatch_randomization_audit: append-only history of every settings change (who / when / before / after).
  Decision-level logging reuses dispatch_decisions.explanation (jsonb) key "randomization" — no schema change.

  Depends on: public.get_account_owner_id(), public.time_off_can_manage() (20270502000000), profiles.
  Rollback: DROP TRIGGER trg_dispatch_rz_audit ON dispatch_randomization_settings;
            DROP TABLE dispatch_randomization_audit, dispatch_randomization_settings;
  PRECONDITION (business): enable only after docs/dispatch-randomization/gate-report.md says PASS.
*/

CREATE TABLE IF NOT EXISTS dispatch_randomization_settings (
  user_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  epsilon numeric(4,1) NOT NULL DEFAULT 0.5 CHECK (epsilon >= 0 AND epsilon <= 10),
  top_k smallint NOT NULL DEFAULT 2 CHECK (top_k BETWEEN 2 AND 5),
  max_eta_delta_minutes smallint NOT NULL DEFAULT 10 CHECK (max_eta_delta_minutes BETWEEN 0 AND 120),
  excluded_service_types text[] NOT NULL DEFAULT '{}',
  salt text NOT NULL DEFAULT gen_random_uuid()::text,
  updated_by uuid DEFAULT auth.uid(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dispatch_randomization_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('insert', 'update')),
  actor uuid DEFAULT auth.uid(),
  before jsonb,
  after jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dispatch_rz_audit_user ON dispatch_randomization_audit (user_id, created_at DESC);

ALTER TABLE dispatch_randomization_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch_randomization_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dispatch_rz_settings_select ON dispatch_randomization_settings;
CREATE POLICY dispatch_rz_settings_select ON dispatch_randomization_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS dispatch_rz_settings_insert ON dispatch_randomization_settings;
CREATE POLICY dispatch_rz_settings_insert ON dispatch_randomization_settings
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id() AND public.time_off_can_manage());
DROP POLICY IF EXISTS dispatch_rz_settings_update ON dispatch_randomization_settings;
CREATE POLICY dispatch_rz_settings_update ON dispatch_randomization_settings
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.time_off_can_manage())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.time_off_can_manage());
-- No DELETE policy: switch off with enabled=false so the history stays complete.

DROP POLICY IF EXISTS dispatch_rz_audit_select ON dispatch_randomization_audit;
CREATE POLICY dispatch_rz_audit_select ON dispatch_randomization_audit
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- No INSERT/UPDATE/DELETE policy: rows are written only by the SECURITY DEFINER trigger below.

-- The salt is a server-side secret of the draw: it must not change from the client, and updated_at must be honest.
CREATE OR REPLACE FUNCTION public.dispatch_rz_before_write()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN NEW.salt := OLD.salt; NEW.user_id := OLD.user_id; END IF;
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.dispatch_rz_audit_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO dispatch_randomization_audit (user_id, action, actor, before, after)
  VALUES (NEW.user_id, lower(TG_OP), auth.uid(),
          CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) - 'salt' ELSE NULL END,
          to_jsonb(NEW) - 'salt');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_dispatch_rz_before ON dispatch_randomization_settings;
CREATE TRIGGER trg_dispatch_rz_before BEFORE INSERT OR UPDATE ON dispatch_randomization_settings
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_rz_before_write();
DROP TRIGGER IF EXISTS trg_dispatch_rz_audit ON dispatch_randomization_settings;
CREATE TRIGGER trg_dispatch_rz_audit AFTER INSERT OR UPDATE ON dispatch_randomization_settings
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_rz_audit_write();
