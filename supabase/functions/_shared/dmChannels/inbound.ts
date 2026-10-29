// supabase/functions/_shared/dmChannels/inbound.ts
//
// Shared inbound persistence for the Telegram and Messenger webhooks: find-or-create the
// conversation, store the message idempotently, apply STOP / START consent, and (for the
// webhook) report what happened so it can send the acknowledgement.
//
// Idempotency: dm_messages has UNIQUE (conversation_id, direction, provider_message_id), so a
// provider retry hits 23505 and is reported as `duplicate` without touching the conversation.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { classifyDmKeyword, type InboundMessage } from "./protocol.ts";

export interface DmConnection {
  id: string;
  user_id: string;
  channel: "telegram" | "messenger";
  external_account_id: string;
  access_token: string;
  webhook_secret: string | null;
  display_name: string | null;
  status: string;
}

export interface InboundOutcome {
  conversationId: string;
  duplicate: boolean;
  keyword: "stop" | "start" | null;
}

interface ConvRow { id: string; customer_name: string | null }

export async function persistInbound(
  admin: SupabaseClient,
  userId: string,
  msg: InboundMessage,
  resolveName?: () => Promise<string | null>,
): Promise<InboundOutcome> {
  const find = async (): Promise<ConvRow | null> => {
    const { data, error } = await admin
      .from("dm_conversations")
      .select("id, customer_name")
      .eq("user_id", userId).eq("channel", msg.channel).eq("customer_external_id", msg.customerId)
      .maybeSingle();
    if (error) throw error;
    return data as ConvRow | null;
  };

  const nowIso = new Date().toISOString();
  let conv = await find();
  if (!conv) {
    const { data, error } = await admin
      .from("dm_conversations")
      .insert({
        user_id: userId, channel: msg.channel, customer_external_id: msg.customerId,
        customer_name: msg.customerName, unread: true, last_message_at: nowIso, last_inbound_at: msg.sentAt,
      })
      .select("id, customer_name")
      .single();
    if (error?.code === "23505") conv = await find(); // concurrent webhook created it first
    else if (error) throw error;
    else conv = data as ConvRow;
  }
  if (!conv) throw new Error("dm conversation could not be created");

  const { error: insertError } = await admin.from("dm_messages").insert({
    conversation_id: conv.id, direction: "inbound", body: msg.text, provider_message_id: msg.providerMessageId,
  });
  if (insertError?.code === "23505") return { conversationId: conv.id, duplicate: true, keyword: null };
  if (insertError) throw insertError;

  const keyword = classifyDmKeyword(msg.text);
  let name = msg.customerName ?? conv.customer_name;
  if (!name && resolveName) name = await resolveName().catch(() => null);

  const patch: Record<string, unknown> = {
    unread: true, last_message_at: nowIso, last_inbound_at: msg.sentAt, customer_name: name,
  };
  if (keyword === "stop") patch.opted_out_at = nowIso;
  if (keyword === "start") patch.opted_out_at = null;

  const { error: updateError } = await admin.from("dm_conversations").update(patch).eq("id", conv.id);
  if (updateError) throw updateError;

  return { conversationId: conv.id, duplicate: false, keyword };
}

/** Stores an outbound message that the system itself sent (consent acknowledgements). */
export async function recordSystemReply(admin: SupabaseClient, conversationId: string, body: string, providerMessageId: string): Promise<void> {
  const { error } = await admin.from("dm_messages").insert({
    conversation_id: conversationId, direction: "outbound", body, provider_message_id: providerMessageId, sent_by: "system",
  });
  if (error && error.code !== "23505") throw error;
}
