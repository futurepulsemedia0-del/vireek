// supabase/functions/_shared/data-import/upsert.ts
//
// Row-level upsert logic for the import engine. Match priority for
// customers: external_id first (safe re-run), then phone, then email —
// reusing the same anti-duplicate intent as the customers table's own
// unique indexes. Jobs have no natural unique key besides external_id,
// so jobs without one are always inserted as new (documented limitation
// — surfaced in the wizard copy, not hidden).

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import type { CustomerColumnMapping, JobColumnMapping } from "./types.ts";

export interface RowOutcome {
  action: "created" | "updated" | "skipped" | "error";
  message?: string;
}

function pick(row: Record<string, string>, header: string | undefined): string | undefined {
  if (!header) return undefined;
  const value = row[header];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

export async function upsertCustomerRow(
  client: SupabaseClient,
  ownerId: string,
  row: Record<string, string>,
  mapping: CustomerColumnMapping,
): Promise<RowOutcome> {
  const name = pick(row, mapping.name);
  if (!name) return { action: "error", message: "Missing required field: name" };

  const phone = pick(row, mapping.phone);
  const email = pick(row, mapping.email);
  const address = pick(row, mapping.address);
  const notes = pick(row, mapping.notes);
  const externalId = pick(row, mapping.external_id);
  const rawType = pick(row, mapping.customer_type)?.toLowerCase();
  const customerType = rawType === "commercial" ? "commercial" : rawType === "residential" ? "residential" : undefined;

  // 1) Match by external_id (safe to re-run the same import twice).
  if (externalId) {
    const { data: existing } = await client
      .from("customers")
      .select("id")
      .eq("user_id", ownerId)
      .eq("external_source", "csv")
      .eq("external_id", externalId)
      .maybeSingle();

    if (existing) {
      const { error } = await client
        .from("customers")
        .update({ name, phone, email, address, notes, customer_type: customerType })
        .eq("id", existing.id);
      return error ? { action: "error", message: error.message } : { action: "updated" };
    }
  }

  // 2) Match by phone, then email — avoids creating a duplicate contact
  // that already exists from a call/lead/manual entry.
  for (const [column, value] of [["phone", phone], ["email", email]] as const) {
    if (!value) continue;
    const { data: existing } = await client
      .from("customers")
      .select("id")
      .eq("user_id", ownerId)
      .eq(column, value)
      .maybeSingle();

    if (existing) {
      const { error } = await client
        .from("customers")
        .update({
          name,
          address: address ?? undefined,
          notes: notes ?? undefined,
          customer_type: customerType,
          external_source: "csv",
          external_id: externalId ?? undefined,
        })
        .eq("id", existing.id);
      return error ? { action: "error", message: error.message } : { action: "updated" };
    }
  }

  // 3) Nothing matched — create a new customer.
  const { error } = await client.from("customers").insert({
    user_id: ownerId,
    name,
    phone,
    email,
    address,
    notes,
    customer_type: customerType ?? "residential",
    lifecycle_stage: "active", // being imported means they're an existing customer, not a fresh lead
    source: "import",
    external_source: externalId ? "csv" : null,
    external_id: externalId ?? null,
  });

  return error ? { action: "error", message: error.message } : { action: "created" };
}

const VALID_JOB_STATUSES = new Set(["scheduled", "en_route", "in_progress", "completed", "cancelled"]);
const VALID_INVOICE_STATUSES = new Set(["not_sent", "sent", "paid"]);

export async function upsertJobRow(
  client: SupabaseClient,
  ownerId: string,
  row: Record<string, string>,
  mapping: JobColumnMapping,
): Promise<RowOutcome> {
  const customerName = pick(row, mapping.customer_name);
  if (!customerName) return { action: "error", message: "Missing required field: customer_name" };

  const customerPhone = pick(row, mapping.customer_phone);
  const serviceType = pick(row, mapping.service_type);
  const address = pick(row, mapping.address);
  const scheduledRaw = pick(row, mapping.scheduled_datetime);
  const externalId = pick(row, mapping.external_id);
  const invoiceAmountRaw = pick(row, mapping.invoice_amount);

  const scheduledDatetime = scheduledRaw && !isNaN(Date.parse(scheduledRaw)) ? new Date(scheduledRaw).toISOString() : null;
  const invoiceAmount = invoiceAmountRaw ? Number(invoiceAmountRaw.replace(/[^0-9.-]/g, "")) : null;

  const jobStatusRaw = pick(row, mapping.job_status)?.toLowerCase();
  const jobStatus = jobStatusRaw && VALID_JOB_STATUSES.has(jobStatusRaw) ? jobStatusRaw : "completed"; // importing history — default to completed, not a fresh booking

  const invoiceStatusRaw = pick(row, mapping.invoice_status)?.toLowerCase();
  const invoiceStatus = invoiceStatusRaw && VALID_INVOICE_STATUSES.has(invoiceStatusRaw) ? invoiceStatusRaw : undefined;

  // Best-effort link to an existing customer by phone — never blocks the import if it doesn't match.
  let customerId: string | null = null;
  if (customerPhone) {
    const { data: match } = await client
      .from("customers")
      .select("id")
      .eq("user_id", ownerId)
      .eq("phone", customerPhone)
      .maybeSingle();
    customerId = match?.id ?? null;
  }

  if (externalId) {
    const { data: existing } = await client
      .from("jobs")
      .select("id")
      .eq("user_id", ownerId)
      .eq("external_source", "csv")
      .eq("external_id", externalId)
      .maybeSingle();

    if (existing) {
      const { error } = await client
        .from("jobs")
        .update({
          customer_name: customerName,
          customer_id: customerId ?? undefined,
          service_type: serviceType,
          address,
          scheduled_datetime: scheduledDatetime,
          job_status: jobStatus,
          invoice_amount: invoiceAmount,
          invoice_status: invoiceStatus,
        })
        .eq("id", existing.id);
      return error ? { action: "error", message: error.message } : { action: "updated" };
    }
  }

  // No external_id, or external_id not seen before — insert as new.
  // NOTE: jobs has no natural unique key besides external_id, so an
  // import without stable source IDs run twice will create duplicates.
  // Strongly encourage mapping external_id when the source CSV has one.
  const { error } = await client.from("jobs").insert({
    user_id: ownerId,
    customer_id: customerId,
    customer_name: customerName,
    customer_phone: customerPhone,
    service_type: serviceType,
    address,
    scheduled_datetime: scheduledDatetime,
    job_status: jobStatus,
    invoice_amount: invoiceAmount,
    invoice_status: invoiceStatus ?? "paid", // historical jobs are typically already paid; override via mapping if not
    external_source: externalId ? "csv" : null,
    external_id: externalId ?? null,
  });

  return error ? { action: "error", message: error.message } : { action: "created" };
}
