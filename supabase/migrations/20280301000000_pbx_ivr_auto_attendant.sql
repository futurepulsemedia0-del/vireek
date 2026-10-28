/*
  # Phone menu (IVR / auto-attendant)

  Adds: pbx_ivr_menus, pbx_ivr_options, and two tracking columns on pbx_calls.
  Lets a phone line (or ring group / queue "no answer", or another menu) point at a menu:
    {"type":"ivr","id":"<menu uuid>"}

  ## Design notes
  - RLS = same as the other PBX config tables: account members read, pbx_can_manage() writes.
  - pbx_valid_destination() is replaced (same signature) to also accept type "ivr".
    Existing rows stay valid (the new list is a superset).
  - Runtime tables stay service-role-write only; the two new pbx_calls columns are written by pbx-voice.
  - Business-hours routing: the line's schedule already picks open_destination / closed_destination.
    Point open_destination at a menu; each option may also carry closed_destination for after hours.
  - Fallback: no input / invalid input after max_retries goes to timeout_destination / invalid_destination
    (default voicemail). A missing, disabled or empty menu also falls back to voicemail at runtime.
*/

-- 1. Destinations may point at a menu ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pbx_valid_destination(d jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT d IS NULL OR (
    jsonb_typeof(d) = 'object'
    AND d ->> 'type' IN ('extension', 'ring_group', 'queue', 'voicemail', 'ai', 'external', 'hangup', 'ivr')
    AND (d ->> 'type' NOT IN ('extension', 'ring_group', 'queue') OR (d ->> 'id') ~* '^[0-9a-f-]{36}$')
    AND (d ->> 'type' <> 'external' OR (d ->> 'number') ~ '^\+[1-9][0-9]{7,14}$')
    AND (d ->> 'type' <> 'ivr' OR COALESCE((d ->> 'id') ~* '^[0-9a-f-]{36}$', false))
  );
$$;

-- 2. Menus ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pbx_ivr_menus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  greeting_text text NOT NULL DEFAULT 'Thank you for calling.' CHECK (char_length(btrim(greeting_text)) BETWEEN 1 AND 1000),
  greeting_audio_url text CHECK (greeting_audio_url IS NULL OR greeting_audio_url ~* '^https://'),
  read_options boolean NOT NULL DEFAULT true,          -- speak "Press 1 for ..." after the greeting
  voice text CHECK (voice IS NULL OR voice ~ '^[A-Za-z0-9._-]{1,64}$'),
  language text NOT NULL DEFAULT 'en-US' CHECK (language ~ '^[a-z]{2,3}-[A-Z]{2}$'),
  timeout_seconds integer NOT NULL DEFAULT 6 CHECK (timeout_seconds BETWEEN 3 AND 20),
  max_retries integer NOT NULL DEFAULT 2 CHECK (max_retries BETWEEN 0 AND 5),
  invalid_message text CHECK (invalid_message IS NULL OR char_length(invalid_message) <= 300),
  timeout_message text CHECK (timeout_message IS NULL OR char_length(timeout_message) <= 300),
  timeout_destination jsonb NOT NULL DEFAULT '{"type":"voicemail"}'::jsonb
    CHECK (public.pbx_valid_destination(timeout_destination)),
  invalid_destination jsonb NOT NULL DEFAULT '{"type":"voicemail"}'::jsonb
    CHECK (public.pbx_valid_destination(invalid_destination)),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_owner_id)
);
CREATE INDEX IF NOT EXISTS idx_pbx_ivr_menus_owner ON pbx_ivr_menus (account_owner_id);

CREATE TABLE IF NOT EXISTS pbx_ivr_options (
  menu_id uuid NOT NULL,
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  digit text NOT NULL CHECK (digit ~ '^[0-9*]$'),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 60),   -- spoken: "Press 1 for <label>"
  destination jsonb NOT NULL CHECK (public.pbx_valid_destination(destination)),
  closed_destination jsonb CHECK (closed_destination IS NULL OR public.pbx_valid_destination(closed_destination)),
  position integer NOT NULL DEFAULT 0,
  PRIMARY KEY (menu_id, digit),
  FOREIGN KEY (menu_id, account_owner_id) REFERENCES pbx_ivr_menus (id, account_owner_id) ON DELETE CASCADE
);

DROP TRIGGER IF EXISTS trg_pbx_ivr_menus_touch ON pbx_ivr_menus;
CREATE TRIGGER trg_pbx_ivr_menus_touch BEFORE UPDATE ON pbx_ivr_menus
  FOR EACH ROW EXECUTE FUNCTION public.pbx_touch_updated_at();

-- 3. Call tracking (written by pbx-voice with the service role) ---------------------------
ALTER TABLE pbx_calls ADD COLUMN IF NOT EXISTS ivr_menu_id uuid REFERENCES pbx_ivr_menus(id) ON DELETE SET NULL;  -- set while the caller is inside a menu
ALTER TABLE pbx_calls ADD COLUMN IF NOT EXISTS ivr_path text NOT NULL DEFAULT '';                                  -- keys pressed, e.g. 1>3
CREATE INDEX IF NOT EXISTS idx_pbx_calls_in_ivr ON pbx_calls (started_at) WHERE ivr_menu_id IS NOT NULL;

-- 4. RLS: members read, managers write -----------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pbx_ivr_menus', 'pbx_ivr_options'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (account_owner_id = public.get_account_owner_id())', t || '_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_write', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO authenticated USING (account_owner_id = public.get_account_owner_id() AND public.pbx_can_manage()) WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.pbx_can_manage())', t || '_write', t);
    EXECUTE format('REVOKE ALL ON %I FROM anon', t);
  END LOOP;
END $$;
