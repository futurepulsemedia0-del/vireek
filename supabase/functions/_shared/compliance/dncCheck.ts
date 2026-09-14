// supabase/functions/_shared/compliance/dncCheck.ts
//
// Do-Not-Call suppression check, run before every outbound dial.
//
// NOT LEGAL ADVICE. What this unconditionally enforces, regardless of
// jurisdiction or Established Business Relationship status: any number
// a customer has asked this business to stop calling (dnc_suppressions
// table) is never dialed again — that part never depends on any
// external provider being configured.
//
// Optional second layer: set DNC_SCRUB_API_URL / DNC_SCRUB_API_KEY to
// check every number against a real National DNC Registry scrub
// provider (e.g. DNC.com, PossibleNOW) before dialing. Until those
// secrets are set, this layer is skipped — the internal list above is
// still always enforced.

import { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return phone.startsWith("+") ? phone : `+${digits}`;
}

async function checkExternalRegistry(phone: string): Promise<boolean | null> {
  const url = Deno.env.get("DNC_SCRUB_API_URL");
  const key = Deno.env.get("DNC_SCRUB_API_KEY");
  if (!url || !key) return null; // not configured — caller falls back to internal list only

  try {
    const res = await fetch(`${url}?phone=${encodeURIComponent(phone)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.on_dnc === true;
  } catch {
    return null;
  }
}

export async function isDncSuppressed(
  admin: SupabaseClient,
  userId: string,
  rawPhone: string
): Promise<boolean> {
  const phone = normalizePhone(rawPhone);

  const { data } = await admin
    .from("dnc_suppressions")
    .select("id")
    .eq("user_id", userId)
    .eq("phone_number", phone)
    .maybeSingle();

  if (data) return true;

  const external = await checkExternalRegistry(phone);
  return external === true;
}
