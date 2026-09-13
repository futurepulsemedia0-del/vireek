import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const BATCH_SIZE = 20;
const VAPI_CALL_URL = "https://api.vapi.ai/call";

interface QueuedCall {
  id: string;
  user_id: string;
  campaign_type: "quote_followup" | "appointment_reminder" | "review_request_call";
  customer_name: string;
  customer_phone: string;
  attempt_count: number;
}

const CAMPAIGN_CONTEXT: Record<QueuedCall["campaign_type"], string> = {
  quote_followup: "quote_followup",
  appointment_reminder: "appointment_reminder",
  review_request_call: "review_request_call",
};

Deno.serve(async (req: Request) => {
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && req.headers.get("X-Cron-Secret") !== cronSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const vapiKey = Deno.env.get("VAPI_PRIVATE_KEY");
  if (!vapiKey) return new Response(JSON.stringify({ error: "VAPI_PRIVATE_KEY is not configured." }), { status: 500 });

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  const { data: queue, error } = await admin
    .from("outbound_calls")
    .select("id, user_id, campaign_type, customer_name, customer_phone, attempt_count")
    .eq("status", "queued")
    .lte("scheduled_for", new Date().toISOString())
    .lt("attempt_count", 3)
    .order("scheduled_for", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  if (!queue || queue.length === 0) return new Response(JSON.stringify({ dialed: 0 }), { headers: { "Content-Type": "application/json" } });

  let dialed = 0, failed = 0;

  for (const call of queue as QueuedCall[]) {
    const { data: business } = await admin
      .from("business_profile")
      .select("vapi_assistant_id, vapi_phone_number_id")
      .eq("user_id", call.user_id)
      .maybeSingle();

    if (!business?.vapi_assistant_id || !business?.vapi_phone_number_id) {
      await admin.from("outbound_calls").update({
        status: "failed", outcome_notes: "No Vapi assistant/phone number configured for this business.", attempt_count: call.attempt_count + 1,
      }).eq("id", call.id);
      failed += 1;
      continue;
    }

    try {
      const res = await fetch(VAPI_CALL_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${vapiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          assistantId: business.vapi_assistant_id,
          phoneNumberId: business.vapi_phone_number_id,
          customer: { number: call.customer_phone },
          assistantOverrides: { variableValues: { customer_name: call.customer_name, call_purpose: CAMPAIGN_CONTEXT[call.campaign_type] } },
        }),
      });

      if (!res.ok) {
        const bodyText = await res.text();
        await admin.from("outbound_calls").update({
          status: call.attempt_count + 1 >= 3 ? "failed" : "queued",
          outcome_notes: `Vapi error ${res.status}: ${bodyText.slice(0, 300)}`,
          attempt_count: call.attempt_count + 1,
        }).eq("id", call.id);
        failed += 1;
        continue;
      }

      const json = await res.json();
      await admin.from("outbound_calls").update({
        status: "calling", vapi_call_id: json.id ?? null, called_at: new Date().toISOString(), attempt_count: call.attempt_count + 1,
      }).eq("id", call.id);
      dialed += 1;
    } catch (err) {
      await admin.from("outbound_calls").update({
        status: call.attempt_count + 1 >= 3 ? "failed" : "queued",
        outcome_notes: err instanceof Error ? err.message : String(err),
        attempt_count: call.attempt_count + 1,
      }).eq("id", call.id);
      failed += 1;
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return new Response(JSON.stringify({ dialed, failed }), { headers: { "Content-Type": "application/json" } });
});
