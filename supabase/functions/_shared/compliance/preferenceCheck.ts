// supabase/functions/_shared/compliance/preferenceCheck.ts
//
// Reads a customer's communication preferences (public /preferences/:token page) so ANY sender can honour
// them. Call it before sending an OPTIONAL message (marketing, surveys, reminders). Essential service
// messages (confirmations, invoices, safety) must not be gated on this.
//
// Fails OPEN on a missing row (a customer who never opened the preference center has no restrictions beyond
// the existing STOP/DNC gates) but fails CLOSED on a query error for the optional categories.

import { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export type OptionalCategory = "reminders" | "surveys" | "marketing";
export type PreferenceChannel = "sms" | "email" | "voice";

export interface CustomerPreferences {
  sms: boolean; email: boolean; voice: boolean;
  reminders: boolean; surveys: boolean; marketing: boolean;
  language: string; frequency: "all" | "weekly" | "monthly" | "essential";
  unsubscribedAll: boolean;
}

const OPEN: CustomerPreferences = {
  sms: true, email: true, voice: true, reminders: true, surveys: true, marketing: true,
  language: "en", frequency: "all", unsubscribedAll: false,
};

export async function getPreferences(
  admin: SupabaseClient,
  customerId: string | null | undefined,
): Promise<CustomerPreferences | "error"> {
  if (!customerId) return OPEN;
  const { data, error } = await admin
    .from("customer_communication_preferences")
    .select("sms_enabled,email_enabled,voice_enabled,reminders_enabled,surveys_enabled,marketing_enabled,language,frequency,unsubscribed_all")
    .eq("customer_id", customerId)
    .maybeSingle();
  if (error) return "error";
  if (!data) return OPEN;
  return {
    sms: data.sms_enabled, email: data.email_enabled, voice: data.voice_enabled,
    reminders: data.reminders_enabled, surveys: data.surveys_enabled, marketing: data.marketing_enabled,
    language: data.language, frequency: data.frequency, unsubscribedAll: data.unsubscribed_all,
  };
}

/** Pure decision helper (unit-testable): may we send this optional category on this channel? */
export function mayContact(
  prefs: CustomerPreferences | "error",
  category: OptionalCategory,
  channel: PreferenceChannel,
): { ok: true } | { ok: false; reason: string } {
  if (prefs === "error") return { ok: false, reason: "Preferences could not be verified." };
  if (prefs.unsubscribedAll) return { ok: false, reason: "Customer unsubscribed from optional messages." };
  if (!prefs[category]) return { ok: false, reason: `Customer opted out of ${category}.` };
  if (!prefs[channel]) return { ok: false, reason: `Customer opted out of ${channel}.` };
  if (prefs.frequency === "essential" && (category === "marketing" || category === "surveys")) {
    return { ok: false, reason: "Customer wants essential messages only." };
  }
  return { ok: true };
}

/** Batch lookup for dispatchers. A customer missing from the map has no row = no restrictions. */
export async function getPreferencesBatch(
  admin: SupabaseClient,
  customerIds: string[],
): Promise<Map<string, CustomerPreferences> | "error"> {
  const out = new Map<string, CustomerPreferences>();
  if (customerIds.length === 0) return out;
  const { data, error } = await admin
    .from("customer_communication_preferences")
    .select("customer_id,sms_enabled,email_enabled,voice_enabled,reminders_enabled,surveys_enabled,marketing_enabled,language,frequency,unsubscribed_all")
    .in("customer_id", customerIds);
  if (error) return "error";
  for (const d of data ?? []) {
    out.set(d.customer_id, {
      sms: d.sms_enabled, email: d.email_enabled, voice: d.voice_enabled,
      reminders: d.reminders_enabled, surveys: d.surveys_enabled, marketing: d.marketing_enabled,
      language: d.language, frequency: d.frequency, unsubscribedAll: d.unsubscribed_all,
    });
  }
  return out;
}
