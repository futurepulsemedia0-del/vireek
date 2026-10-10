/*
  # Public events & webinars calendar (/events)

  Backs the public /events page: a calendar of real, scheduled sessions
  with free registration.

  ## Honesty rule (same standard as WebinarsPage.tsx)
  Nothing is seeded. A session only appears once a row is published with
  a real date, time and host. With no published rows the page renders its
  clean "no session on the calendar" state.

  ## Privacy / access model
  - public_events and public_event_registrations have RLS on and NO
    policies, and anon/authenticated have no table grants: neither is ever
    readable from the browser.
  - The page reads through list_public_events() (SECURITY DEFINER), which
    never returns join_url or any registrant data.
  - Registration goes through register_for_public_event(), callable only
    by the service role (the event-register edge function). It locks the
    event row, so capacity can never be oversold under concurrent signups.

  ## Publishing a session (run in the Supabase SQL editor)
    INSERT INTO public_events
      (slug, title, description, kind, starts_at, ends_at, timezone, format,
       host_name, join_url, capacity, published)
    VALUES
      ('live-demo-oct', 'Live Demo: Never Miss Another Emergency Call',
       'A 30-minute walkthrough followed by live Q&A.', 'demo',
       '2026-10-14 13:00:00-04', '2026-10-14 13:45:00-04', 'America/New_York',
       'online', 'Ali Moradi, Founder', 'https://your-zoom-or-meet-link', 100, true);

  ## After the session
    UPDATE public_events SET recording_url = 'https://...' WHERE slug = '...';

  ## Deploy order
    1. Run this migration.
    2. supabase functions deploy event-register --no-verify-jwt
    3. Ship the frontend.
*/

-- =============================================================
-- 1. Tables
-- =============================================================

CREATE TABLE IF NOT EXISTS public_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE
    CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 3 AND 80),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 140),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  kind text NOT NULL DEFAULT 'webinar'
    CHECK (kind IN ('webinar', 'demo', 'workshop', 'office_hours', 'conference')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  timezone text NOT NULL DEFAULT 'America/New_York',
  format text NOT NULL DEFAULT 'online' CHECK (format IN ('online', 'in_person', 'hybrid')),
  location_label text CHECK (location_label IS NULL OR char_length(location_label) <= 200),
  join_url text CHECK (join_url IS NULL OR join_url ~ '^https://'),
  host_name text CHECK (host_name IS NULL OR char_length(host_name) <= 120),
  capacity integer CHECK (capacity IS NULL OR capacity > 0),
  registration_open boolean NOT NULL DEFAULT true,
  published boolean NOT NULL DEFAULT false,
  recording_url text CHECK (recording_url IS NULL OR recording_url ~ '^https://'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT public_events_time_order CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_public_events_published_starts
  ON public_events(starts_at) WHERE published;

CREATE TABLE IF NOT EXISTS public_event_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public_events(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
  email text NOT NULL CHECK (email = lower(email) AND char_length(email) <= 254),
  marketing_opt_in boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, email)
);

CREATE INDEX IF NOT EXISTS idx_public_event_registrations_event_created
  ON public_event_registrations(event_id, created_at);

ALTER TABLE public_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_event_registrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public_events FROM anon, authenticated;
REVOKE ALL ON TABLE public_event_registrations FROM anon, authenticated;

-- Reject an invalid IANA timezone at write time (the page and emails format with it).
CREATE OR REPLACE FUNCTION public.public_events_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM now() AT TIME ZONE NEW.timezone;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_public_events_validate ON public_events;
CREATE TRIGGER trg_public_events_validate
  BEFORE INSERT OR UPDATE ON public_events
  FOR EACH ROW EXECUTE FUNCTION public.public_events_validate();

DROP TRIGGER IF EXISTS trigger_public_events_updated_at ON public_events;
CREATE TRIGGER trigger_public_events_updated_at
  BEFORE UPDATE ON public_events
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- =============================================================
-- 2. Public read (anon) — no join_url, no registrant data
-- =============================================================

CREATE OR REPLACE FUNCTION public.list_public_events()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH visible AS (
    SELECT e.*
    FROM public_events e
    WHERE e.published
      AND (
        e.ends_at >= now()
        OR e.id IN (
          SELECT p.id FROM public_events p
          WHERE p.published AND p.ends_at < now()
          ORDER BY p.ends_at DESC
          LIMIT 12
        )
      )
  ), counted AS (
    SELECT v.*,
           (SELECT count(*) FROM public_event_registrations r WHERE r.event_id = v.id) AS registered
    FROM visible v
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'slug', c.slug,
        'title', c.title,
        'description', c.description,
        'kind', c.kind,
        'starts_at', c.starts_at,
        'ends_at', c.ends_at,
        'timezone', c.timezone,
        'format', c.format,
        'location_label', c.location_label,
        'host_name', c.host_name,
        'recording_url', CASE WHEN c.ends_at < now() THEN c.recording_url END,
        'registration_status', CASE
          WHEN c.ends_at < now() THEN 'ended'
          WHEN NOT c.registration_open THEN 'closed'
          WHEN c.capacity IS NOT NULL AND c.registered >= c.capacity THEN 'full'
          ELSE 'open'
        END,
        'spots_left', CASE WHEN c.capacity IS NULL THEN NULL ELSE GREATEST(c.capacity - c.registered, 0) END
      )
      ORDER BY c.starts_at
    ),
    '[]'::jsonb
  )
  FROM counted c;
$$;

REVOKE ALL ON FUNCTION public.list_public_events() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_public_events() TO anon, authenticated;

-- =============================================================
-- 3. Registration (service role only) — atomic, capacity-safe
-- =============================================================

CREATE OR REPLACE FUNCTION public.register_for_public_event(
  p_slug text,
  p_name text,
  p_email text,
  p_marketing boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ev public_events%ROWTYPE;
  v_email text := lower(btrim(COALESCE(p_email, '')));
  v_name text := btrim(COALESCE(p_name, ''));
  v_existing uuid;
  v_count integer;
  v_recent integer;
  v_event jsonb;
BEGIN
  -- Row lock: concurrent signups for one event queue up here, so the
  -- capacity check below can never be raced past.
  SELECT * INTO ev
  FROM public_events
  WHERE slug = lower(btrim(COALESCE(p_slug, ''))) AND published
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF ev.ends_at < now() OR NOT ev.registration_open THEN
    RETURN jsonb_build_object('status', 'closed');
  END IF;

  v_event := jsonb_build_object(
    'slug', ev.slug,
    'title', ev.title,
    'description', ev.description,
    'starts_at', ev.starts_at,
    'ends_at', ev.ends_at,
    'timezone', ev.timezone,
    'format', ev.format,
    'location_label', ev.location_label,
    'join_url', ev.join_url,
    'host_name', ev.host_name
  );

  SELECT r.id INTO v_existing FROM public_event_registrations r WHERE r.event_id = ev.id AND r.email = v_email;
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'already_registered', 'event', v_event);
  END IF;

  SELECT count(*) INTO v_count FROM public_event_registrations WHERE event_id = ev.id;
  IF ev.capacity IS NOT NULL AND v_count >= ev.capacity THEN
    RETURN jsonb_build_object('status', 'full');
  END IF;

  -- Flood guard: a public form must not be able to fill an event with junk in minutes.
  SELECT count(*) INTO v_recent
  FROM public_event_registrations
  WHERE event_id = ev.id AND created_at > now() - interval '1 hour';
  IF v_recent >= 300 THEN
    RETURN jsonb_build_object('status', 'rate_limited');
  END IF;

  INSERT INTO public_event_registrations (event_id, name, email, marketing_opt_in)
  VALUES (ev.id, v_name, v_email, COALESCE(p_marketing, false));

  RETURN jsonb_build_object('status', 'registered', 'event', v_event);
END;
$$;

REVOKE ALL ON FUNCTION public.register_for_public_event(text, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_for_public_event(text, text, text, boolean) TO service_role;
