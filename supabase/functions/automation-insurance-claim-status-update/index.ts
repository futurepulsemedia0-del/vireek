// Cron-triggered sweep: texts the customer whenever their insurance_claims
// row's status has moved since the last text we sent (new -> submitted ->
// approved/denied). No DB trigger needed — same polling pattern as
// automation-no-show-reschedule.
//
// Deploy:
//   supabase functions deploy automation-insurance-claim-status-update --no-verify-jwt
//   supabase secrets set INSURANCE_CLAIM_CRON_SECRET=<random-string>

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendCompliantSms } from "../_shared/messaging/sendSms.ts";
import { isAutomationEnabled } from "../_shared/automation/gate.ts";

const STATUS_COPY: Record<string, string> = {
  submitted: "has been submitted to your insurance company",
  approved: "has been approved",
  denied: "was denied — our office will reach out to discuss next steps",
};

Deno.serve(async (req: Request) => {
  const cronSecret = Deno.env.get("INSURANCE_CLAIM_CRON_SECRET");
  if (cronSecret && req.headers.get("X-Cron-Secret") !== cronSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const { data: claims, error } = await admin
    .from("insurance_claims")
    .select("id, user_id, customer_name, customer_phone, claim_number, status, last_texted_status")
    .not("customer_phone", "is", null)
    .or("last_texted_status.is.null,status.neq.last_texted_status");

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  let sent = 0, skipped = 0, failed = 0;

  for (const claim of claims ?? []) {
    if (claim.status === claim.last_texted_status) continue; // belt-and-suspenders for the .or() above
    if (claim.status === "new") continue; // don't text on initial intake, only on real progress

    if (!(await isAutomationEnabled(admin, claim.user_id, "insurance-claim-status-update"))) {
      skipped += 1;
      continue;
    }

    const statusPhrase = STATUS_COPY[claim.status] ?? `is now "${claim.status}"`;
    const claimRef = claim.claim_number ? ` (claim #${claim.claim_number})` : "";
    const body = `Hi ${claim.customer_name}, an update on your insurance claim${claimRef}: it ${statusPhrase}.`;

    const result = await sendCompliantSms(admin, claim.user_id, claim.customer_phone as string, body);

    if (result.ok) {
      await admin.from("insurance_claims").update({ last_texted_status: claim.status, status_texted_at: new Date().toISOString() }).eq("id", claim.id);
      sent += 1;
    } else {
      console.error(JSON.stringify({ event: "insurance_claim_text_failed", claim_id: claim.id, reason: result.reason }));
      failed += 1;
    }
  }

  return new Response(JSON.stringify({ sent, skipped, failed }), { headers: { "Content-Type": "application/json" } });
});
