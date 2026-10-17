import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { buildStripeEvidence, normalizeDispute } from "../_shared/disputes/normalize.ts";
import { stripeCall, stripeUploadEvidenceFile } from "../_shared/disputes/stripeApi.ts";

// Authenticated actions on one dispute: { action: 'submit' | 'accept' | 'sync', dispute_id: <stripe_disputes.id> }
//   submit — upload files to Stripe, attach the saved evidence and submit it (Stripe allows ONE submission)
//   accept — concede the dispute (Stripe closes it as lost)
//   sync   — re-pull the dispute from Stripe (covers a missed webhook)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const OPEN = ["needs_response", "warning_needs_response"];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) throw new HttpError(401, "Missing Authorization header.");

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) throw new HttpError(401, "Invalid or expired session.");
    const caller = userData.user;

    // Account owner + permission (owner, or team member with can_view_billing) — enforced server-side too.
    const { data: profile } = await admin.from("profiles").select("id").eq("id", caller.id).maybeSingle();
    let ownerId = profile?.id as string | undefined;
    if (!ownerId) {
      const { data: member } = await admin.from("team_members").select("account_owner_id, permissions").eq("member_email", caller.email ?? "").maybeSingle();
      if (!member?.account_owner_id || !member.permissions?.can_view_billing) throw new HttpError(403, "You don't have permission to manage disputes.");
      ownerId = member.account_owner_id;
    }

    const body = await req.json().catch(() => ({}));
    const action = body.action as string;
    const disputeId = body.dispute_id as string | undefined;
    if (!["submit", "accept", "sync"].includes(action) || !disputeId) throw new HttpError(400, "action and dispute_id are required.");

    const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!secretKey) throw new HttpError(500, "Payments aren't configured on this server yet (missing STRIPE_SECRET_KEY).");

    const { data: dispute } = await admin.from("stripe_disputes").select("*").eq("id", disputeId).eq("user_id", ownerId).maybeSingle();
    if (!dispute) throw new HttpError(404, "Dispute not found.");
    const acct = dispute.stripe_account_id as string | null;

    const persist = async (stripeDispute: any) => {
      const { error } = await admin.rpc("apply_stripe_dispute_event", {
        p: {
          event_id: `manual_${action}_${dispute.stripe_dispute_id}_${Date.now()}`,
          event_type: "charge.dispute.updated",
          event_created: Math.floor(Date.now() / 1000),
          stripe_account_id: acct,
          dispute: normalizeDispute(stripeDispute),
        },
      });
      if (error) throw error;
      return stripeDispute.status as string;
    };

    if (action === "sync") {
      const status = await persist(await stripeCall("GET", `disputes/${dispute.stripe_dispute_id}`, secretKey, undefined, acct));
      return json({ ok: true, status });
    }

    if (!OPEN.includes(dispute.status)) throw new HttpError(409, "This dispute is no longer open for a response.");

    if (action === "accept") {
      const status = await persist(await stripeCall("POST", `disputes/${dispute.stripe_dispute_id}/close`, secretKey, {}, acct));
      return json({ ok: true, status });
    }

    // ---- submit ----
    if (dispute.submission_count > 0) throw new HttpError(409, "Evidence was already submitted. Stripe allows only one submission.");
    if (dispute.evidence_due_by && new Date(dispute.evidence_due_by).getTime() <= Date.now()) throw new HttpError(409, "The evidence deadline has passed.");

    const { data: files } = await admin.from("stripe_dispute_evidence_files").select("*").eq("dispute_id", dispute.id).eq("user_id", ownerId).order("created_at");
    const draft = (dispute.evidence_draft ?? {}) as Record<string, unknown>;
    if (!(files?.length) && !Object.values(draft).some((v) => typeof v === "string" && v.trim())) {
      throw new HttpError(400, "Add at least one piece of evidence (text or a file) before submitting.");
    }

    for (const f of files ?? []) {
      if (f.stripe_file_id) continue; // already uploaded on an earlier (failed) attempt
      const { data: blob, error: dlError } = await admin.storage.from("dispute-evidence").download(f.storage_path);
      if (dlError || !blob) throw new HttpError(500, `Could not read "${f.file_name}" from storage.`);
      f.stripe_file_id = await stripeUploadEvidenceFile(new Uint8Array(await blob.arrayBuffer()), f.file_name, f.mime_type, secretKey, acct);
      await admin.from("stripe_dispute_evidence_files").update({ stripe_file_id: f.stripe_file_id }).eq("id", f.id);
    }

    const evidence = buildStripeEvidence(draft, (files ?? []).filter((f) => f.stripe_file_id) as { category: string; stripe_file_id: string }[]);
    const updated = await stripeCall("POST", `disputes/${dispute.stripe_dispute_id}`, secretKey, { evidence, submit: true }, acct);
    const status = await persist(updated);
    return json({ ok: true, status });
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    // Stripe validation messages (file too large, text too long…) are safe and actionable — surface them.
    const message = error instanceof Error ? error.message : "Something went wrong.";
    console.error(JSON.stringify({ event: "dispute_evidence_failed", error: message }));
    return json({ error: message.length < 300 ? message : "Something went wrong submitting the evidence." }, 502);
  }
});
