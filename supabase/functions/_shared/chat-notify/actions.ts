// Button actions shared by the Slack and Teams webhooks. Deno-only (takes a service-role client).
import type { Db } from "./server.ts";
import { truncate } from "./events.ts";

export interface ActionResult { ok: boolean; message: string; already?: boolean }
type Provider = "slack" | "teams";

async function audit(db: Db, ownerId: string, action: string, targetId: string) {
  await db.from("audit_log").insert({ user_id: ownerId, action: truncate(action, 200), target_table: "chat_events", target_id: targetId });
}

async function ownedEvent(db: Db, eventId: string, ownerId: string) {
  const { data } = await db.from("chat_events").select("id, user_id, entity_type, entity_id, acknowledged_at, acknowledged_by").eq("id", eventId).maybeSingle();
  return data && data.user_id === ownerId ? data : null;
}

async function markAcknowledged(db: Db, eventId: string, actor: string, provider: Provider): Promise<boolean> {
  const { data } = await db
    .from("chat_events")
    .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: truncate(actor, 80), acknowledged_via: provider })
    .eq("id", eventId)
    .is("acknowledged_at", null) // race-safe: exactly one click wins
    .select("id");
  return !!data?.length;
}

export async function acknowledgeEvent(db: Db, p: { eventId: string; ownerId: string; actor: string; provider: Provider }): Promise<ActionResult> {
  const ev = await ownedEvent(db, p.eventId, p.ownerId);
  if (!ev) return { ok: false, message: "This notification no longer exists." };
  if (ev.acknowledged_at) return { ok: true, already: true, message: `Already acknowledged by ${ev.acknowledged_by ?? "a teammate"}.` };
  if (!(await markAcknowledged(db, p.eventId, p.actor, p.provider))) return { ok: true, already: true, message: "Already acknowledged." };
  await audit(db, p.ownerId, `chat.acknowledge via ${p.provider} by ${p.actor}`, p.eventId);
  return { ok: true, message: "Acknowledged." };
}

export async function assignEvent(db: Db, p: { eventId: string; ownerId: string; technicianId: string; actor: string; provider: Provider }): Promise<ActionResult> {
  const ev = await ownedEvent(db, p.eventId, p.ownerId);
  if (!ev) return { ok: false, message: "This notification no longer exists." };

  const { data: tech } = await db
    .from("team_members")
    .select("id, member_name, member_email")
    .eq("id", p.technicianId)
    .eq("account_owner_id", p.ownerId)
    .eq("invite_status", "active")
    .maybeSingle();
  if (!tech) return { ok: false, message: "That team member is not available for assignment." };

  await db
    .from("chat_events")
    .update({ assigned_to: tech.id, assigned_by: truncate(p.actor, 80), assigned_at: new Date().toISOString() })
    .eq("id", p.eventId);

  // Assigning implies someone has seen it.
  await markAcknowledged(db, p.eventId, p.actor, p.provider);

  // Keep the operational record in sync: the job itself, or the job booked from this call.
  if (ev.entity_type === "job") {
    await db.from("jobs").update({ assigned_technician_id: tech.id }).eq("id", ev.entity_id).eq("user_id", p.ownerId);
  } else if (ev.entity_type === "call") {
    await db.from("jobs").update({ assigned_technician_id: tech.id }).eq("call_id", ev.entity_id).eq("user_id", p.ownerId).in("job_status", ["scheduled", "en_route"]);
  }

  await audit(db, p.ownerId, `chat.assign via ${p.provider} by ${p.actor} -> ${tech.member_name || tech.member_email}`, p.eventId);
  return { ok: true, message: `Assigned to ${tech.member_name || tech.member_email}.` };
}
