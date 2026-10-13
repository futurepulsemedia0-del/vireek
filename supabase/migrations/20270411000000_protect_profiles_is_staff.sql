/*
  # Protect profiles.is_staff from client-side changes

  Why: the "update_own_profile" policy lets a signed-in user UPDATE their own
  profiles row without column restrictions, so a tenant could run
    supabase.from('profiles').update({ is_staff: true }).eq('id', myId)
  and pass is_vireek_staff() / StaffRoute. Every staff-only RLS policy and
  /staff page depends on that flag, so it must not be client-writable.

  Rule: when the request comes from an end user (auth.uid() is set — i.e.
  through PostgREST with a user JWT) is_staff can neither be set on INSERT
  nor changed on UPDATE. The service role, the SQL editor and migrations have
  auth.uid() = NULL and keep working, e.g.:
    update profiles set is_staff = true where email = 'you@vireek.com';
*/

CREATE OR REPLACE FUNCTION public.protect_profile_staff_flag()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF TG_OP = 'INSERT' THEN
      NEW.is_staff := false;
    ELSIF NEW.is_staff IS DISTINCT FROM OLD.is_staff THEN
      RAISE EXCEPTION 'is_staff cannot be changed from the client' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_profile_staff_flag ON profiles;
CREATE TRIGGER trg_protect_profile_staff_flag
  BEFORE INSERT OR UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_profile_staff_flag();
