// supabase/functions/_shared/portal/killSwitch.ts
// One decision function used by every entry point (API, cron, worker step loop). Everything defaults to OFF.

export interface GateInput {
  globalAutomationEnabled: boolean; // platform flag (portal_global_settings.automation_enabled)
  globalKill: boolean;              // platform kill switch
  accountEnabled: boolean;          // portal_account_settings.submission_enabled
  accountChannelEnabled: boolean;   // per-channel flag for the requested channel
  accountAutomationKill: boolean;   // account-level kill
  profileAutomationKill: boolean;   // per-portal kill (customer_portal_profiles.automation_kill)
  channel: "email" | "assisted" | "api" | "automation";
  consentActive: boolean;           // only relevant for automation
}
export type GateDecision = { allowed: true } | { allowed: false; reason: string };

export function evaluateGate(g: GateInput): GateDecision {
  if (g.globalKill) return { allowed: false, reason: "global_kill_switch" };
  if (!g.accountEnabled) return { allowed: false, reason: "feature_disabled" };
  if (!g.accountChannelEnabled) return { allowed: false, reason: "channel_disabled" };
  if (g.channel === "automation") {
    if (!g.globalAutomationEnabled) return { allowed: false, reason: "automation_not_enabled_platform" };
    if (g.accountAutomationKill) return { allowed: false, reason: "account_kill_switch" };
    if (g.profileAutomationKill) return { allowed: false, reason: "portal_kill_switch" };
    if (!g.consentActive) return { allowed: false, reason: "consent_required" };
  }
  return { allowed: true };
}
