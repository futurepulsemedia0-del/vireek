import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendSms, sendEmail } from "../_shared/notify/deliver.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
}

async function resolveAccountOwnerId(admin: any, caller: { id: string; email?: string | null }): Promise<string> {
  const { data: profile } = await admin.from("profiles").select("id").eq("id", caller.id).maybeSingle();
  if (profile) return profile.id;
  const { data: member } = await admin.from("team_members").select("account_owner_id").eq("member_email", caller.email ?? "").maybeSingle();
  return member?.account_owner_id ?? caller.id;
}

interface SignerInput {
  name: string;
  email?: string;
  phone?: string;
  role?: "signer" | "company_rep" | "witness";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse({ error: "Missing Authorization header." }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) return jsonResponse({ error: "Invalid or expired session." }, 401);
    const caller = userData.user;
    const ownerId = await resolveAccountOwnerId(admin, caller);

    const body = await req.json().catch(() => ({}));
    const documentType = (body.document_type as string) || "custom";
    if (!["quote", "contract", "invoice", "custom"].includes(documentType)) {
      return jsonResponse({ error: "Invalid document_type." }, 400);
    }
    const title = (body.title as string | undefined)?.trim();
    if (!title) return jsonResponse({ error: "title is required." }, 400);

    const signersInput = Array.isArray(body.signers) ? (body.signers as SignerInput[]) : [];
    const cleanSigners = signersInput
      .map((s, i) => ({
        name: (s.name || "").trim(),
        email: (s.email || "").trim() || null,
        phone: (s.phone || "").trim() || null,
        role: (["signer", "company_rep", "witness"].includes(s.role || "") ? s.role : "signer") as string,
        signing_order: i + 1,
      }))
      .filter((s) => s.name && (s.email || s.phone));
    if (cleanSigners.length === 0) {
      return jsonResponse({ error: "Add at least one signer with a name and an email or phone number." }, 400);
    }

    const { data: profile } = await admin.from("profiles").select("company_name").eq("id", ownerId).maybeSingle();
    const businessName = profile?.company_name || "Vireek";

    const expiresInDays = Number(body.expires_in_days) > 0 ? Number(body.expires_in_days) : 14;
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();

    const insertPayload: Record<string, unknown> = {
      user_id: ownerId,
      customer_id: body.customer_id || null,
      document_type: documentType,
      document_id: body.document_id || null,
      title,
      document_summary: (body.document_summary as string | undefined)?.slice(0, 2000) || null,
      document_url: (body.document_url as string | undefined) || null,
      status: "sent",
      sent_at: new Date().toISOString(),
      expires_at: expiresAt,
    };
    if (typeof body.consent_text === "string" && body.consent_text.trim()) {
      insertPayload.consent_text = body.consent_text.trim();
    }

    const { data: request, error: reqError } = await admin.from("signature_requests").insert(insertPayload).select().single();
    if (reqError || !request) throw reqError || new Error("Could not create the signature request.");

    const { data: signers, error: signersError } = await admin
      .from("signature_signers")
      .insert(cleanSigners.map((s) => ({ ...s, request_id: request.id })))
      .select();
    if (signersError || !signers) throw signersError || new Error("Could not add signers.");

    await admin.from("signature_events").insert({ request_id: request.id, event_type: "created", metadata: { signer_count: signers.length } });

    const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
    const results: { signer_id: string; sign_url: string; email_sent: boolean; sms_sent: boolean }[] = [];

    for (const signer of signers) {
      const signUrl = `${siteUrl}/sign/${signer.signer_token}`;
      let emailSent = false;
      let smsSent = false;

      if (signer.email) {
        const res = await sendEmail(
          signer.email,
          `${businessName} sent you "${title}" to sign`,
          `<div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
            <p style="font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin: 0 0 16px;">Signature requested</p>
            <h1 style="font-size: 22px; margin: 0 0 12px;">${escapeHtml(businessName)} sent you a document to sign</h1>
            <p style="font-size: 14px; color: #4b5563; margin: 0 0 20px;">${escapeHtml(title)}</p>
            <a href="${signUrl}" style="display: inline-block; margin-top: 8px; padding: 12px 24px; background: #111827; color: #ffffff; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 14px;">Review &amp; sign</a>
            <p style="margin-top: 24px; font-size: 12px; color: #9ca3af;">This link is unique to you — please don't forward it. It expires ${new Date(expiresAt).toLocaleDateString()}.</p>
          </div>`,
          `${businessName} sent you "${title}" to sign: ${signUrl}`
        );
        emailSent = res.ok;
      }
      if (signer.phone) {
        const res = await sendSms(signer.phone, `${businessName} sent you "${title}" to sign: ${signUrl}`);
        smsSent = res.ok;
      }

      await admin.from("signature_events").insert({
        request_id: request.id,
        signer_id: signer.id,
        event_type: "sent",
        metadata: { email_sent: emailSent, sms_sent: smsSent },
      });

      results.push({ signer_id: signer.id, sign_url: signUrl, email_sent: emailSent, sms_sent: smsSent });
    }

    return jsonResponse({ request, signers: results });
  } catch (err) {
    console.error("send-signature-request error:", err);
    return jsonResponse({ error: err instanceof Error ? err.message : "Unexpected error." }, 500);
  }
});
