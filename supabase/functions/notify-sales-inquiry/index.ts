import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const NOTIFY_EMAIL = "ali@vireek.com";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    const body = await req.json();
    const record = body?.record ?? body;

    const id = record?.id;
    const fullName = record?.full_name ?? "Unknown";
    const email = record?.email ?? "Unknown";
    const companyName = record?.company_name ?? "Not provided";
    const phone = record?.phone ?? "Not provided";
    const bestTimeToCall = record?.best_time_to_call ?? "Not specified";
    const smsConsent = record?.sms_consent ? "Yes" : "No";
    const createdAt = record?.created_at ?? new Date().toISOString();

    const emailHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
        <h1 style="color: #0f172a; font-size: 22px; margin-bottom: 20px;">New Sales Inquiry</h1>
        <p style="color: #475569; font-size: 15px; margin-bottom: 24px;">A new lead has been submitted via the Vireek website form.</p>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <tr><td style="padding: 8px 0; color: #64748b; font-weight: 600; width: 140px;">Full Name</td><td style="padding: 8px 0; color: #0f172a;">${fullName}</td></tr>
          <tr><td style="padding: 8px 0; color: #64748b; font-weight: 600;">Email</td><td style="padding: 8px 0; color: #0f172a;">${email}</td></tr>
          <tr><td style="padding: 8px 0; color: #64748b; font-weight: 600;">Company</td><td style="padding: 8px 0; color: #0f172a;">${companyName}</td></tr>
          <tr><td style="padding: 8px 0; color: #64748b; font-weight: 600;">Phone</td><td style="padding: 8px 0; color: #0f172a;">${phone}</td></tr>
          <tr><td style="padding: 8px 0; color: #64748b; font-weight: 600;">Best Time to Call</td><td style="padding: 8px 0; color: #0f172a;">${bestTimeToCall}</td></tr>
          <tr><td style="padding: 8px 0; color: #64748b; font-weight: 600;">SMS Consent</td><td style="padding: 8px 0; color: #0f172a;">${smsConsent}</td></tr>
          <tr><td style="padding: 8px 0; color: #64748b; font-weight: 600;">Submitted At</td><td style="padding: 8px 0; color: #0f172a;">${new Date(createdAt).toLocaleString()}</td></tr>
        </table>
        <p style="margin-top: 28px; padding-top: 20px; border-top: 1px solid #e2e8f0; color: #94a3b8; font-size: 13px;">
          Inquiry ID: ${id}
        </p>
      </div>
    `;

    if (!resendApiKey) {
      console.warn("RESEND_API_KEY not configured — email not sent. Row was still inserted.");
      return new Response(
        JSON.stringify({ success: false, reason: "RESEND_API_KEY not configured" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const emailResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Vireek Sales <onboarding@vireek.com>",
        to: [NOTIFY_EMAIL],
        subject: `New Sales Inquiry from ${fullName}`,
        html: emailHtml,
      }),
    });

    if (!emailResponse.ok) {
      const errText = await emailResponse.text();
      console.error("Resend API error:", errText);
      return new Response(
        JSON.stringify({ success: false, error: errText }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
