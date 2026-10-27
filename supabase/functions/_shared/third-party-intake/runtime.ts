// supabase/functions/_shared/third-party-intake/runtime.ts
//
// Production wiring (Deno only, service role). All parsing rules live in core.ts.
// A partner request is idempotent: the same partner + reference (or identical
// content) returns the existing row instead of creating a second work order.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { buildDedupeKey, type ParsedIntake } from "./core.ts";

export interface PayerRow {
  id: string;
  user_id: string;
  name: string;
  enabled: boolean;
  email_tag: string | null;
  sender_domains: string[];
}

const PAYER_COLS = "id,user_id,name,enabled,email_tag,sender_domains";

export async function getPayerByToken(admin: SupabaseClient, token: string): Promise<PayerRow | null> {
  const { data } = await admin.from("third_party_payers").select(PAYER_COLS).eq("intake_token", token).eq("enabled", true).maybeSingle();
  return (data as PayerRow | null) ?? null;
}

export async function listEnabledPayers(admin: SupabaseClient, userId: string): Promise<PayerRow[]> {
  const { data } = await admin.from("third_party_payers").select(PAYER_COLS).eq("user_id", userId).eq("enabled", true);
  return (data as PayerRow[] | null) ?? [];
}

export interface IngestResult {
  id: string;
  duplicate: boolean;
  status: string;
}

export async function ingestIntake(
  admin: SupabaseClient,
  args: { payer: PayerRow; via: "email" | "api"; intake: ParsedIntake; raw: string; extraReasons?: string[] },
): Promise<IngestResult> {
  const { payer, via, intake, raw } = args;
  const dedupeKey = await buildDedupeKey(payer.id, intake, raw);
  const reasons = [...intake.reviewReasons, ...(args.extraReasons ?? [])];

  const { data, error } = await admin
    .from("third_party_work_orders")
    .insert({
      user_id: payer.user_id,
      payer_id: payer.id,
      payer_name: payer.name,
      received_via: via,
      external_ref: intake.externalRef,
      dedupe_key: dedupeKey,
      priority: intake.priority,
      title: intake.title,
      description: intake.description,
      service_type: intake.serviceType,
      customer_name: intake.customerName,
      customer_phone: intake.customerPhone,
      customer_email: intake.customerEmail,
      service_address: intake.serviceAddress,
      policy_number: intake.policyNumber,
      nte_cents: intake.nteCents,
      authorization_status: intake.preAuthorized ? "authorized" : "pending",
      authorized_cents: intake.authorizedCents,
      complete_due_at: intake.dueAt,
      needs_review: reasons.length > 0,
      review_reasons: reasons,
      raw_payload: raw.slice(0, 16_000),
    })
    .select("id,status")
    .single();

  if (!error && data) return { id: data.id as string, duplicate: false, status: data.status as string };

  if (error?.code === "23505") {
    const { data: existing } = await admin
      .from("third_party_work_orders")
      .select("id,status")
      .eq("user_id", payer.user_id)
      .eq("dedupe_key", dedupeKey)
      .single();
    if (existing) return { id: existing.id as string, duplicate: true, status: existing.status as string };
  }
  throw new Error(`insert_intake_failed: ${error?.message ?? "unknown"}`);
}
