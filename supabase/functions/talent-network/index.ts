// supabase/functions/talent-network/index.ts
//
// Talent Network orchestrator (JWT required).
//   reference_request  { referenceId }                 worker  -> emails the referee a single-use link
//   background_start   { applicationId, package? }     manager -> starts a background check with the provider
//
// Secrets: see docs/TALENT_NETWORK.md
//   RESEND_API_KEY, RESEND_FROM_EMAIL, SITE_URL                    (reference emails)
//   CHECKR_API_KEY, CHECKR_DEFAULT_PACKAGE, [CHECKR_API_BASE]      (background checks, optional)
//
// Authorization is always resolved by Postgres under the CALLER's identity (RPCs). The service role
// only writes provider results and issues reference tokens, so neither can be forged from a browser.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { isValidPackage, referenceEmail, splitName } from "../_shared/talent-network/engine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function asUuid(v: unknown, field: string): string {
  if (typeof v !== "string" || !UUID_RE.test(v)) throw new HttpError(400, `${field} must be a UUID`);
  return v;
}

function pgMessage(err: { code?: string; message?: string }): HttpError {
  // 22023 = a validation message written for end users; 42501 = not allowed.
  if (err.code === "22023") return new HttpError(400, err.message ?? "Invalid request", "validation");
  if (err.code === "42501") return new HttpError(403, "You don't have permission to do that.", "forbidden");
  return new HttpError(500, "Something went wrong. Please try again.", "internal");
}

async function sendReference(admin: ReturnType<typeof createClient>, userId: string, referenceId: string) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) throw new HttpError(503, "Email is not configured yet.", "email_not_configured");
  const from = Deno.env.get("RESEND_FROM_EMAIL") || "Vireek <onboarding@resend.dev>";
  const site = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");

  const { data, error } = await admin.rpc("talent_issue_reference_token", { p_user_id: userId, p_reference_id: referenceId });
  if (error) throw pgMessage(error);
  const t = data as { token: string; referee_email: string; referee_name: string; worker_name: string };

  const mail = referenceEmail({ refereeName: t.referee_name, workerName: t.worker_name, url: `${site}/talent/reference/${t.token}` });
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [t.referee_email], subject: mail.subject, html: mail.html, text: mail.text }),
  });
  if (!res.ok) throw new HttpError(502, "The email could not be sent. Try again later.", "email_failed");
  return { ok: true };
}

async function checkrFetch(path: string, body: unknown) {
  const key = Deno.env.get("CHECKR_API_KEY");
  if (!key) throw new HttpError(503, "Background checks are not configured.", "provider_not_configured");
  const base = (Deno.env.get("CHECKR_API_BASE") || "https://api.checkr.com/v1").replace(/\/$/, "");
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${key}:`)}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, "The screening provider rejected the request.", `provider_${res.status}`);
  return payload as Record<string, unknown>;
}

async function startBackground(
  userClient: ReturnType<typeof createClient>,
  admin: ReturnType<typeof createClient>,
  applicationId: string,
  pkg: string | undefined,
) {
  if (!Deno.env.get("CHECKR_API_KEY")) throw new HttpError(503, "Background checks are not configured.", "provider_not_configured");
  const chosen = pkg ?? Deno.env.get("CHECKR_DEFAULT_PACKAGE") ?? "default";
  if (!isValidPackage(chosen)) throw new HttpError(400, "Invalid package name.");

  // Authorizes (manager, offer stage, posting requires it) and inserts the check row.
  const { data, error } = await userClient.rpc("talent_prepare_background_check", { p_application_id: applicationId, p_package: chosen });
  if (error) throw pgMessage(error);
  const prep = data as {
    check_id: string;
    package: string;
    candidate: { email: string; name: string; city: string | null; region: string | null; country: string };
  };
  const loc = { country: prep.candidate.country || "US", state: prep.candidate.region ?? undefined, city: prep.candidate.city ?? undefined };

  try {
    const { first, last } = splitName(prep.candidate.name);
    const candidate = await checkrFetch("/candidates", { first_name: first, last_name: last, email: prep.candidate.email, work_locations: [loc] });
    // The hosted invitation shows the FCRA disclosure + authorization to the candidate; we never collect SSN/DOB.
    const invitation = await checkrFetch("/invitations", { candidate_id: candidate.id, package: prep.package, work_locations: [loc] });
    await admin.rpc("talent_background_set_provider", {
      p_check_id: prep.check_id,
      p_candidate_id: String(candidate.id),
      p_invitation_id: String(invitation.id),
      p_invitation_url: typeof invitation.invitation_url === "string" ? invitation.invitation_url : null,
      p_status: "invited",
      p_error_code: null,
    });
    return { ok: true, checkId: prep.check_id };
  } catch (e) {
    const code = e instanceof HttpError ? (e.code ?? "provider_error") : "provider_error";
    await admin.rpc("talent_background_set_provider", {
      p_check_id: prep.check_id, p_candidate_id: null, p_invitation_id: null, p_invitation_url: null, p_status: "failed", p_error_code: code,
    });
    throw e instanceof HttpError ? e : new HttpError(502, "The screening provider could not be reached.", code);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL");
    const anon = Deno.env.get("SUPABASE_ANON_KEY");
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !anon || !service) throw new HttpError(500, "Server is not configured.");

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!/^Bearer\s+\S+/i.test(authHeader)) throw new HttpError(401, "Missing Authorization header.");

    const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
    const admin = createClient(url, service, { auth: { persistSession: false } });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) throw new HttpError(401, "Invalid session.");

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    switch (body.action) {
      case "reference_request":
        return json(await sendReference(admin, userData.user.id, asUuid(body.referenceId, "referenceId")));
      case "background_start": {
        const pkg = body.package === undefined || body.package === null || body.package === "" ? undefined : String(body.package);
        return json(await startBackground(userClient, admin, asUuid(body.applicationId, "applicationId"), pkg));
      }
      default:
        throw new HttpError(400, "Unknown action.");
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code ?? null }, e.status);
    console.error("talent-network failed", e instanceof Error ? e.message : e);
    return json({ error: "Something went wrong." }, 500);
  }
});
