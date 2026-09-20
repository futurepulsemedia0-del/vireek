// Single source of truth for "did this business turn this automation on in
// the Marketplace". Any Edge Function that runs an automated action tied to
// an automation_installs slug should check this before acting — otherwise
// the Marketplace toggle is decorative (the exact bug this closes).
//
// Fails OPEN on a lookup error (returns true) so a transient DB hiccup
// never silently disables a business's automations — the same fail-safe
// direction the rest of this codebase already uses for tenant lookups.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export async function isAutomationEnabled(
  admin: SupabaseClient,
  userId: string,
  slug: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("automation_installs")
    .select("status")
    .eq("user_id", userId)
    .eq("template_slug", slug)
    .maybeSingle();

  if (error) {
    console.error(JSON.stringify({ event: "automation_gate_lookup_failed", user_id: userId, slug, error: error.message }));
    return true;
  }

  // Not installed at all = automation never appeared as "on" for this
  // business, so default to enabled (matches today's unconditional
  // behavior for businesses who never touched the Marketplace).
  if (!data) return true;

  return data.status === "active";
}
