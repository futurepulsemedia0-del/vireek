// Human-approval endpoint for AI drafts (Unified Inbox → "Approve & send" / "Reject").
//
// POST { action: "approve" | "reject", logId, body? }  — authenticated tenant only.
// Approve sends through the same compliant path as every other message
// (sendCompliantSms: A2P + STOP gates; Resend for email). The draft is claimed
// atomically first, so a double-click or two teammates can never send twice.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { deliverReply } from "../_shared/autoReply/runtime.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  const accessToken = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!accessToken) return json({ error: "Missing Authorization header" }, 401);
  const { data: userData, error: userError } = await admin.auth.getUser(accessToken);
  if (userError || !userData?.user) return json({ error: "Invalid or expired session" }, 401);
  const userId = userData.user.id;

  const { action, logId, body } = await req.json().catch(() => ({}));
  if (!["approve", "reject"].includes(action) || typeof logId !== "string") {
    return json({ error: "action (approve|reject) and logId are required" }, 400);
  }

  // Atomic claim: only a still-pending draft owned by this user can move on.
  const { data: claimed } = await admin
    .from("auto_reply_log")
    .update({ status: action === "approve" ? "processing" : "rejected", approved_by: userId, resolved_at: action === "reject" ? new Date().toISOString() : null })
    .eq("id", logId).eq("user_id", userId).eq("status", "pending_approval")
    .select("id, channel, conversation_id, draft_body")
    .maybeSingle();
  if (!claimed) return json({ error: "This draft was already handled or no longer exists." }, 409);
  if (action === "reject") return json({ ok: true });

  const finalBody = String(typeof body === "string" && body.trim() ? body : claimed.draft_body ?? "").trim().slice(0, 4000);
  const result = finalBody
    ? await deliverReply(admin, { userId, channel: claimed.channel, conversationId: claimed.conversation_id, body: finalBody, sentBy: "ai_approved" })
    : ({ ok: false, reason: "EMPTY" } as const);

  const sentButUnlogged = !result.ok && result.reason === "LOG_FAILED"; // delivered; only our bookkeeping failed
  if (!result.ok && !sentButUnlogged) {
    // Put the draft back so the owner can retry or answer manually.
    await admin.from("auto_reply_log").update({ status: "pending_approval", resolved_at: null }).eq("id", logId);
    return json({ error: result.reason }, 422);
  }

  await admin.from("auto_reply_log")
    .update({ status: "sent", reason: "approved_by_human", final_body: finalBody, outbound_message_id: result.ok ? result.messageId : null, resolved_at: new Date().toISOString() })
    .eq("id", logId);
  await admin.from(claimed.channel === "sms" ? "sms_conversations" : "email_conversations").update({ needs_human: false }).eq("id", claimed.conversation_id);
  return json({ ok: true });
});
