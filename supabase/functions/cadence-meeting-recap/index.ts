// supabase/functions/cadence-meeting-recap/index.ts
//
// Emails the recap of a COMPLETED weekly meeting (notes + action items) to its
// attendees. Called from the dashboard by a manager with their own JWT.
//
// Safety:
//   - caller must be a manager (public.cadence_can_manage()); meeting is read
//     under the caller's RLS, so other accounts' meetings are invisible.
//   - recipients are the stored attendee ids INTERSECTED with this account's
//     owner + active team members (service role only used to look up emails).
//   - the email carries no dollar figures or KPI values (attendees may lack
//     billing access): only section titles, free-text notes and action items.
//   - one email per recipient (no shared recipient list); HTML is escaped.
//   - body {"meeting_id": uuid, "resend": boolean}; a second send needs resend=true.
//
// Secrets: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (provided),
//          RESEND_API_KEY / RESEND_FROM_EMAIL (via _shared/notify/deliver.ts),
//          SITE_URL (optional, default https://app.vireek.com)
// Deploy:  supabase functions deploy cadence-meeting-recap

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail } from "../_shared/notify/deliver.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esc = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

interface AgendaSegment { title?: unknown }
interface ActionRow { title: string; owner_name: string | null; due_date: string | null }

Deno.serve(async (req: Request) => {
  const requestId = crypto.randomUUID();
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed", requestId }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anon || !service) return json({ error: "Server not configured", requestId }, 500);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Unauthorized", requestId }, 401);

  let body: { meeting_id?: unknown; resend?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body", requestId }, 400);
  }
  const meetingId = typeof body.meeting_id === "string" ? body.meeting_id : "";
  if (!UUID_RE.test(meetingId)) return json({ error: "Invalid meeting_id", requestId }, 400);
  const resend = body.resend === true;

  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const admin = createClient(url, service, { auth: { autoRefreshToken: false, persistSession: false } });

  try {
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Unauthorized", requestId }, 401);

    const { data: canManage, error: permErr } = await userClient.rpc("cadence_can_manage");
    if (permErr) return json({ error: "Could not verify permissions", requestId }, 500);
    if (canManage !== true) return json({ error: "Only managers can send the recap.", requestId }, 403);

    const { data: meeting, error: mErr } = await userClient
      .from("cadence_meetings")
      .select("id, user_id, week_start, status, agenda, attendee_user_ids, notes, started_at, ended_at, recap_sent_at")
      .eq("id", meetingId)
      .maybeSingle();
    if (mErr) return json({ error: "Could not load the meeting", requestId }, 500);
    if (!meeting) return json({ error: "Meeting not found", requestId }, 404);
    if (meeting.status !== "completed") return json({ error: "End the meeting before sending the recap.", requestId }, 409);
    if (meeting.recap_sent_at && !resend) {
      return json({ error: "The recap was already sent. Use “Resend recap” to send it again.", requestId }, 409);
    }

    const ownerId = meeting.user_id as string;

    // Only the account's own people may receive it.
    const { data: members, error: tmErr } = await admin
      .from("team_members")
      .select("user_id")
      .eq("account_owner_id", ownerId)
      .eq("invite_status", "active")
      .not("user_id", "is", null);
    if (tmErr) return json({ error: "Could not load attendees", requestId }, 500);
    const allowed = new Set<string>([ownerId, ...((members ?? []) as { user_id: string }[]).map((m) => m.user_id)]);
    const recipients = [...new Set((meeting.attendee_user_ids ?? []) as string[])].filter((id) => allowed.has(id)).slice(0, 100);
    if (recipients.length === 0) return json({ success: true, sent: 0, requestId });

    const { data: items, error: aErr } = await userClient
      .from("cadence_action_items")
      .select("title, owner_name, due_date")
      .eq("meeting_id", meetingId)
      .order("created_at", { ascending: true })
      .limit(200);
    if (aErr) return json({ error: "Could not load action items", requestId }, 500);
    const actions = (items ?? []) as ActionRow[];

    const siteUrl = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");
    const link = `${siteUrl}/dashboard/cadence?tab=meeting`;
    const minutes = meeting.ended_at
      ? Math.max(1, Math.round((new Date(meeting.ended_at).getTime() - new Date(meeting.started_at).getTime()) / 60000))
      : null;
    const sections = ((meeting.agenda ?? []) as AgendaSegment[])
      .map((s) => (typeof s.title === "string" ? s.title : ""))
      .filter(Boolean);
    const subject = `Weekly meeting recap — week of ${meeting.week_start}`;
    const notes = typeof meeting.notes === "string" ? meeting.notes.trim() : "";

    const actionsHtml = actions.length
      ? `<ul style="margin:0 0 20px;padding-left:20px;color:#374151;font-size:15px;line-height:1.6">${actions
          .map(
            (a) =>
              `<li>${esc(a.title)} <span style="color:#6b7280;font-size:13px">— ${esc(a.owner_name ?? "Unassigned")}${a.due_date ? `, due ${esc(a.due_date)}` : ""}</span></li>`,
          )
          .join("")}</ul>`
      : `<p style="margin:0 0 20px;color:#6b7280;font-size:14px">No action items were recorded.</p>`;

    const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:16px;padding:28px"><tr><td>
<p style="margin:0 0 6px;font-size:13px;color:#6b7280">Vireek · Operating Cadence</p>
<h1 style="margin:0 0 6px;font-size:20px;line-height:1.35">${esc(subject)}</h1>
<p style="margin:0 0 20px;font-size:13px;color:#6b7280">${minutes ? `${minutes} minutes` : "Completed"}${sections.length ? ` · ${esc(sections.join(" → "))}` : ""}</p>
<h2 style="margin:0 0 8px;font-size:15px">Action items</h2>
${actionsHtml}
${notes ? `<h2 style="margin:0 0 8px;font-size:15px">Notes</h2><p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:#374151;white-space:pre-wrap">${esc(notes)}</p>` : ""}
<a href="${esc(link)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 20px;border-radius:12px">Open in Vireek</a>
<p style="margin:24px 0 0;font-size:12px;color:#9ca3af">You’re receiving this because you attended the weekly meeting.</p>
</td></tr></table></td></tr></table></body></html>`;

    const text = [
      subject,
      minutes ? `${minutes} minutes` : "",
      "",
      "Action items:",
      ...(actions.length ? actions.map((a) => `- ${a.title} (${a.owner_name ?? "Unassigned"}${a.due_date ? `, due ${a.due_date}` : ""})`) : ["- none"]),
      notes ? `\nNotes:\n${notes}` : "",
      `\nOpen in Vireek: ${link}`,
    ]
      .filter((l) => l !== "")
      .join("\n");

    // Resolve emails (service role), then send one message per person.
    const emails: string[] = [];
    for (const id of recipients) {
      const { data: u } = await admin.auth.admin.getUserById(id);
      const email = u?.user?.email;
      if (email) emails.push(email);
    }

    let sent = 0;
    let failed = 0;
    for (let i = 0; i < emails.length; i += 5) {
      const results = await Promise.all(emails.slice(i, i + 5).map((to) => sendEmail(to, subject, html, text)));
      for (const r of results) {
        if (r.ok) sent += 1;
        else failed += 1;
      }
    }

    if (sent === 0 && failed > 0) {
      console.error(JSON.stringify({ event: "cadence_recap_failed", requestId, meetingId, failed }));
      return json({ error: "The email provider rejected the messages. Try again shortly.", requestId }, 502);
    }

    if (sent > 0) {
      const { error: upErr } = await userClient.from("cadence_meetings").update({ recap_sent_at: new Date().toISOString() }).eq("id", meetingId);
      if (upErr) console.error(JSON.stringify({ event: "cadence_recap_mark_failed", requestId, meetingId, error: upErr.message }));
    }

    return json({ success: true, sent, failed, requestId });
  } catch (e) {
    console.error(JSON.stringify({ event: "cadence_recap_error", requestId, error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "Internal server error", requestId }, 500);
  }
});
