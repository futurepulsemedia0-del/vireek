// supabase/functions/send-team-invite/index.ts
//
// Sends a branded invite email to a newly added (or re-invited) team member
// so they know they've been added to their company's Vireek account and can
// create their login. Called from the dashboard's Team page right after a
// row is inserted into `team_members` — see src/pages/TeamPage.tsx.
//
// Required secrets (set once):
//   supabase secrets set RESEND_API_KEY=re_xxxxxxxxxxxx
//   supabase secrets set RESEND_FROM_EMAIL="Vireek <team@yourdomain.com>"
//   supabase secrets set SITE_URL=https://vireek.com
//
// Deploy:
//   supabase functions deploy send-team-invite

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface InviteRequestBody {
  memberEmail: string;
  memberName?: string | null;
  role?: string;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) {
      return new Response(JSON.stringify({ error: "Missing Authorization header." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    // Confirm the caller is a real, logged-in Vireek user before sending any email.
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: "Invalid or expired session." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const caller = userData.user;

    const body = (await req.json()) as InviteRequestBody;
    const memberEmail = (body.memberEmail ?? "").trim().toLowerCase();
    const memberName = body.memberName?.trim() || null;
    const role = body.role ?? "member";

    if (!memberEmail || !EMAIL_REGEX.test(memberEmail)) {
      return new Response(JSON.stringify({ error: "A valid memberEmail is required." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Look up the inviter's name/company so the email feels personal, not generic.
    const { data: inviterProfile } = await admin
      .from("profiles")
      .select("full_name, company_name, email")
      .eq("id", caller.id)
      .maybeSingle();

    const inviterName = inviterProfile?.full_name || inviterProfile?.email || "A Vireek admin";
    const companyName = inviterProfile?.company_name || "their company";

    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) {
      return new Response(
        JSON.stringify({ error: "Email is not configured yet (missing RESEND_API_KEY)." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Every send (first invite AND resend) rotates the token and gives the
    // recipient a fresh window, so a stale/leaked link can't be replayed.
    const inviteToken = crypto.randomUUID();
    const inviteTokenExpiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data: teamRow, error: teamRowError } = await admin
      .from("team_members")
      .update({
        invite_token: inviteToken,
        invite_token_expires_at: inviteTokenExpiresAt,
        last_invited_at: new Date().toISOString(),
      })
      .eq("account_owner_id", caller.id)
      .eq("member_email", memberEmail)
      .select("id")
      .maybeSingle();

    if (teamRowError || !teamRow) {
      return new Response(
        JSON.stringify({ error: "No pending team member found for this email. Add them first." }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "Vireek <onboarding@resend.dev>";
    const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
    const inviteUrl = `${siteUrl}/invite/${inviteToken}`;

    const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
    const greetingName = memberName ? memberName.split(" ")[0] : "there";

    const html = `
      <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
        <p style="font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin: 0 0 16px;">You've been invited</p>
        <h1 style="font-size: 22px; margin: 0 0 16px;">Hi ${escapeHtml(greetingName)}, join ${escapeHtml(companyName)} on Vireek</h1>
        <p style="font-size: 15px; line-height: 1.6; color: #374151;">
          ${escapeHtml(inviterName)} added you as a <strong>${escapeHtml(roleLabel)}</strong> on their Vireek account —
          the AI voice receptionist platform that answers calls, books jobs, and keeps the whole team in sync.
        </p>
        <a href="${inviteUrl}"
           style="display: inline-block; margin-top: 24px; padding: 12px 24px; background: #111827; color: #ffffff; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 14px;">
          Accept invite &amp; create your account
        </a>
        <p style="margin-top: 24px; font-size: 13px; color: #9ca3af;">
          Sign up with <strong>${escapeHtml(memberEmail)}</strong> so your account links automatically to ${escapeHtml(companyName)}.
          If you weren't expecting this, you can ignore this email.
        </p>
      </div>
    `;

    const text = `${inviterName} added you as a ${roleLabel} on their Vireek account (${companyName}).\n\nAccept your invite: ${inviteUrl}\n\nUse ${memberEmail} to sign in or sign up so it links automatically. If you weren't expecting this, ignore this email.`;

    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [memberEmail],
        subject: `${inviterName} invited you to join ${companyName} on Vireek`,
        html,
        text,
      }),
    });

    if (!resendResponse.ok) {
      const errText = await resendResponse.text();
      console.error("Resend error:", errText);
      return new Response(
        JSON.stringify({ error: "The invite email failed to send. Please try again." }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }


    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("send-team-invite error:", err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "Unexpected error." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
