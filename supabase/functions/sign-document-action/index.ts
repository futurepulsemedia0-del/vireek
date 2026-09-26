import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail } from "../_shared/notify/deliver.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "unknown";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action as string;
    const signerToken = body.signer_token as string;
    if (!signerToken) return jsonResponse({ error: "signer_token is required." }, 400);

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const ip = clientIp(req);
    const userAgent = req.headers.get("user-agent") || "unknown";

    if (action === "view") {
      await admin.rpc("record_signature_view", { p_signer_token: signerToken, p_ip: ip, p_user_agent: userAgent });
      return jsonResponse({ ok: true });
    }

    if (action === "consent") {
      await admin.rpc("record_signature_consent", { p_signer_token: signerToken, p_ip: ip, p_user_agent: userAgent });
      return jsonResponse({ ok: true });
    }

    if (action === "sign") {
      const signatureType = body.signature_type as string;
      const signatureData = body.signature_data as string;
      if (!signatureType || !signatureData) return jsonResponse({ error: "Missing signature." }, 400);

      const { data, error } = await admin.rpc("submit_signature_by_token", {
        p_signer_token: signerToken,
        p_signature_type: signatureType,
        p_signature_data: signatureData,
        p_typed_font: (body.typed_font as string) || null,
        p_signed_name: (body.signed_name as string) || null,
        p_ip: ip,
        p_user_agent: userAgent,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.ok) return jsonResponse({ error: "This document can no longer be signed (it may already be signed, declined, or expired)." }, 409);

      if (row.request_completed) {
        const { data: signer } = await admin.from("signature_signers").select("request_id").eq("signer_token", signerToken).maybeSingle();
        if (signer) {
          const { data: request } = await admin.from("signature_requests").select("title, user_id").eq("id", signer.request_id).maybeSingle();
          if (request) {
            const { data: profile } = await admin.from("profiles").select("email, company_name").eq("id", request.user_id).maybeSingle();
            if (profile?.email) {
              await sendEmail(
                profile.email,
                `Fully signed: ${request.title}`,
                `<div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
                  <p style="font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: #16a34a; margin: 0 0 16px;">Fully executed</p>
                  <h1 style="font-size: 22px; margin: 0 0 12px;">"${request.title}" has been signed by everyone</h1>
                  <p style="font-size: 14px; color: #4b5563;">Open it in Vireek to view the signatures and the audit trail.</p>
                </div>`,
                `"${request.title}" has been signed by everyone. Open Vireek to view it.`
              );
            }
          }
        }
      }

      return jsonResponse({ ok: true, request_completed: !!row.request_completed });
    }

    if (action === "decline") {
      const { data, error } = await admin.rpc("decline_signature_by_token", {
        p_signer_token: signerToken,
        p_reason: (body.reason as string) || null,
        p_ip: ip,
        p_user_agent: userAgent,
      });
      if (error) throw error;
      return jsonResponse({ ok: Boolean(data) });
    }

    return jsonResponse({ error: "Unknown action." }, 400);
  } catch (err) {
    console.error("sign-document-action error:", err);
    return jsonResponse({ error: err instanceof Error ? err.message : "Unexpected error." }, 500);
  }
});
