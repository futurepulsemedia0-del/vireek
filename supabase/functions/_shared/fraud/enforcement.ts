// supabase/functions/_shared/fraud/enforcement.ts
//
// Shared "change an account's abuse status" routine used by fraud-sweep (automatic) and fraud-admin (staff).
// One transaction in SQL (fraud_set_org_status: state + event + audit_log), then best-effort case upkeep and
// owner notification with an appeal path. Every change is reversible by calling it again with status "active".

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail } from "../notify/deliver.ts";
import type { AnomalySignal } from "./anomaly.ts";

export type OrgStatus = "active" | "throttled" | "suspended";

export interface StatusChange {
  userId: string;
  status: OrgStatus;
  reason: string;
  /** Throttles auto-expire; suspensions stay until a human restores them. */
  until?: Date | null;
  actorId?: string | null;
  source: string;
  severity?: "low" | "medium" | "high";
  signals?: AnomalySignal[];
  notifyOwner?: boolean;
}

export async function applyOrgStatus(admin: SupabaseClient, c: StatusChange): Promise<{ ok: boolean; error?: string }> {
  const { error } = await admin.rpc("fraud_set_org_status", {
    p_user: c.userId, p_status: c.status, p_reason: c.reason.slice(0, 500),
    p_until: c.until ? c.until.toISOString() : null, p_actor: c.actorId ?? null, p_source: c.source,
  });
  if (error) return { ok: false, error: error.message };

  if (c.status === "active") {
    await admin.from("fraud_cases").update({ status: "resolved", resolution: `Restored: ${c.reason}`.slice(0, 500), updated_at: new Date().toISOString() })
      .eq("user_id", c.userId).neq("status", "resolved");
    return { ok: true };
  }

  await upsertCase(admin, c.userId, c.severity ?? (c.status === "suspended" ? "high" : "medium"), c.reason, c.signals ?? []);
  if (c.notifyOwner !== false) await notifyOwner(admin, c.userId, c.status);
  return { ok: true };
}

/** One open case per account (unique index). New signals are appended to the existing case. */
export async function upsertCase(admin: SupabaseClient, userId: string, severity: "low" | "medium" | "high", title: string, signals: AnomalySignal[]): Promise<void> {
  const { data: open } = await admin.from("fraud_cases").select("id, signals, severity").eq("user_id", userId).neq("status", "resolved").maybeSingle();
  if (open) {
    const merged = [...(Array.isArray(open.signals) ? open.signals : []), ...signals].slice(-50);
    const rank = { low: 0, medium: 1, high: 2 } as const;
    await admin.from("fraud_cases").update({
      signals: merged, severity: rank[severity] > rank[open.severity as keyof typeof rank] ? severity : open.severity, updated_at: new Date().toISOString(),
    }).eq("id", open.id);
    return;
  }
  await admin.from("fraud_cases").insert({ user_id: userId, severity, title: title.slice(0, 200), signals });
}

async function notifyOwner(admin: SupabaseClient, userId: string, status: OrgStatus): Promise<void> {
  try {
    const { data: p } = await admin.from("profiles").select("email").eq("id", userId).maybeSingle();
    const site = Deno.env.get("SITE_URL") ?? "https://vireek.com";
    const headline = status === "suspended" ? "Outbound calling and texting is paused on your account" : "Outbound calling and texting is temporarily limited on your account";
    const text = `${headline}.\n\nWe saw activity that looks unusual and paused it to protect you from unexpected charges. Incoming calls and your AI receptionist keep working, and emergency transfers are not affected.\n\nIf this is a mistake, reply to this email or appeal in Settings > Security at ${site}/dashboard. A person will review it.`;
    await admin.from("ai_insights").insert({ user_id: userId, insight_type: "alert", title: headline, description: "Unusual outbound activity was detected. Open Settings > Security to appeal." });
    if (p?.email) await sendEmail(p.email, headline, `<p>${text.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`, text);
  } catch (e) {
    console.error(JSON.stringify({ event: "fraud_owner_notify_failed", error: String(e) }));
  }
}
