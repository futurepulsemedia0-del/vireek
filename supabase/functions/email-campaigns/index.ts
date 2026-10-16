// supabase/functions/email-campaigns/index.ts
//
// Authenticated API behind /dashboard/email-campaigns. All campaign STATE
// changes happen here (the browser can only edit drafts via RLS):
//   preview | send | unschedule | pause | resume | cancel | test
//
// Only the account owner, or a team member with can_view_billing, may call it
// (same rule as the page). Everything is scoped to the ACCOUNT OWNER's id.
//
// Deploy:  supabase functions deploy email-campaigns

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  analyzeCampaignAudience,
  buildFrom,
  Campaign,
  functionsBase,
  renderEmail,
  runCampaign,
  siteUrl,
  startCampaign,
} from "../_shared/email-campaigns/engine.ts";
import { firstNameOf, singleLine } from "../_shared/email-campaigns/render.ts";
import { isValidEmail } from "../_shared/email-campaigns/audience.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const MIN_LEAD_MS = 60_000;
const MAX_LEAD_MS = 365 * 86_400_000;

function problems(c: Campaign): string | null {
  if (!c.name?.trim()) return "Give the campaign a name.";
  if (!singleLine(c.subject ?? "")) return "Add a subject line.";
  if (!(c.body ?? "").trim()) return "Write the email body.";
  if ((c.sender_address ?? "").trim().length < 8) return "Add your business postal address — it's required in every marketing email footer.";
  if (c.reply_to && !isValidEmail(c.reply_to.trim().toLowerCase())) return "The reply-to address isn't a valid email.";
  if (c.audience === "segment" && !c.segment_id) return "Choose an audience.";
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  // ---- authenticate + resolve the ACCOUNT OWNER ----
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Missing Authorization header" }, 401);
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData?.user) return json({ error: "Invalid or expired session" }, 401);
  const user = userData.user;

  let ownerId: string | null = null;
  const { data: ownProfile } = await admin.from("profiles").select("id").eq("id", user.id).maybeSingle();
  if (ownProfile) {
    ownerId = ownProfile.id;
  } else {
    const { data: member } = await admin
      .from("team_members")
      .select("account_owner_id, permissions, custom_role:custom_roles(permissions)")
      .eq("member_email", (user.email ?? "").toLowerCase())
      .maybeSingle();
    const perms = {
      ...((member?.permissions as Record<string, boolean> | null) ?? {}),
      // deno-lint-ignore no-explicit-any
      ...(((member as any)?.custom_role?.permissions as Record<string, boolean> | null) ?? {}),
    };
    if (member && perms.can_view_billing) ownerId = member.account_owner_id;
  }
  if (!ownerId) return json({ error: "Only the account owner, or a team member with billing access, can manage email campaigns." }, 403);

  // ---- parse ----
  const payload = await req.json().catch(() => null);
  const action = String(payload?.action ?? "");
  const campaignId = String(payload?.campaignId ?? "");
  if (!campaignId) return json({ error: "campaignId is required" }, 400);

  const { data: campaign } = await admin
    .from("email_campaigns")
    .select("*")
    .eq("id", campaignId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (!campaign) return json({ error: "Campaign not found" }, 404);
  const c = campaign as Campaign;

  try {
    switch (action) {
      case "preview": {
        const a = await analyzeCampaignAudience(admin, c);
        return json({ total: a.total, eligible: a.eligible.length, excluded: a.excluded });
      }

      case "send": {
        if (!["draft", "paused"].includes(c.status) && c.status !== "scheduled") return json({ error: `A ${c.status} campaign can't be sent.` }, 409);
        if (c.status === "paused") return json({ error: "Use resume for a paused campaign." }, 409);
        const issue = problems(c);
        if (issue) return json({ error: issue }, 422);
        if (payload?.ack !== true) return json({ error: "Confirm that your recipients agreed to receive marketing email." }, 422);
        if (!Deno.env.get("RESEND_API_KEY")) return json({ error: "NOT_CONFIGURED", detail: "Email isn't configured yet (missing RESEND_API_KEY)." }, 422);

        let when = new Date();
        if (payload?.scheduledAt) {
          when = new Date(String(payload.scheduledAt));
          const lead = when.getTime() - Date.now();
          if (Number.isNaN(when.getTime()) || lead < MIN_LEAD_MS || lead > MAX_LEAD_MS) {
            return json({ error: "Pick a send time between 1 minute and 1 year from now." }, 422);
          }
        }
        const analysis = await analyzeCampaignAudience(admin, c);
        if (analysis.eligible.length === 0) return json({ error: "Nobody in this audience can be emailed yet (no consent, suppressed, or no email).", excluded: analysis.excluded }, 422);

        const sendNow = !payload?.scheduledAt;
        const { error } = await admin
          .from("email_campaigns")
          .update({ status: "scheduled", scheduled_at: when.toISOString(), compliance_ack_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() })
          .eq("id", c.id)
          .in("status", ["draft", "scheduled"]);
        if (error) throw error;

        if (sendNow) {
          const count = await startCampaign(admin, { ...c, status: "scheduled" });
          // Kick off the first batches immediately; the cron dispatcher finishes the rest.
          const { data: fresh } = await admin.from("email_campaigns").select("*").eq("id", c.id).single();
          if (fresh?.status === "sending") await runCampaign(admin, fresh as Campaign, 1, Date.now() + 20_000);
          return json({ status: "sending", recipients: count });
        }
        return json({ status: "scheduled", scheduledAt: when.toISOString(), recipients: analysis.eligible.length });
      }

      case "unschedule": {
        if (c.status !== "scheduled") return json({ error: "Only a scheduled campaign can be unscheduled." }, 409);
        await admin.from("email_campaigns").update({ status: "draft", scheduled_at: null }).eq("id", c.id).eq("status", "scheduled");
        return json({ status: "draft" });
      }

      case "pause": {
        if (c.status !== "sending") return json({ error: "Only a sending campaign can be paused." }, 409);
        await admin.from("email_campaigns").update({ status: "paused" }).eq("id", c.id).eq("status", "sending");
        return json({ status: "paused" });
      }

      case "resume": {
        if (c.status !== "paused") return json({ error: "Only a paused campaign can be resumed." }, 409);
        await admin.from("email_campaigns").update({ status: "sending" }).eq("id", c.id).eq("status", "paused");
        return json({ status: "sending" });
      }

      case "cancel": {
        if (!["scheduled", "sending", "paused"].includes(c.status)) return json({ error: "This campaign can't be cancelled." }, 409);
        await admin.from("email_campaigns").update({ status: "cancelled", completed_at: new Date().toISOString() }).eq("id", c.id);
        await admin.from("email_campaign_recipients").update({ status: "skipped", error: "campaign cancelled" }).eq("campaign_id", c.id).in("status", ["queued", "sending"]);
        await admin.rpc("email_refresh_campaign_counts", { p_campaign: c.id });
        return json({ status: "cancelled" });
      }

      case "test": {
        // Test sends go ONLY to the signed-in user's own address — never to arbitrary recipients.
        const to = (user.email ?? "").toLowerCase();
        if (!isValidEmail(to)) return json({ error: "Your account has no valid email address." }, 422);
        const issue = problems(c);
        if (issue) return json({ error: issue }, 422);
        const apiKey = Deno.env.get("RESEND_API_KEY");
        if (!apiKey) return json({ error: "NOT_CONFIGURED", detail: "Email isn't configured yet (missing RESEND_API_KEY)." }, 422);

        const { data: profile } = await admin.from("profiles").select("company_name, full_name").eq("id", ownerId).maybeSingle();
        const company = profile?.company_name || "Your service provider";
        const rendered = renderEmail({
          subject: `[TEST] ${c.subject}`,
          preheader: c.preheader,
          body: c.body,
          vars: { name: profile?.full_name || "Alex Customer", first_name: firstNameOf(profile?.full_name || "Alex"), company_name: company },
          companyName: company,
          senderAddress: c.sender_address ?? "",
          unsubscribeUrl: `${siteUrl()}/email/unsubscribe/test`,
        });
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: buildFrom(c.from_name || company),
            to: [to],
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
            ...(c.reply_to ? { reply_to: c.reply_to } : {}),
          }),
        });
        if (!res.ok) return json({ error: "PROVIDER_ERROR", detail: (await res.text()).slice(0, 300) }, 422);
        return json({ sentTo: to, trackingNote: `${functionsBase()} tracking is disabled for test sends.` });
      }

      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    console.error("email-campaigns error", e);
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});
