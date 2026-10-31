// supabase/functions/_shared/data-import/ledgerApply.ts
//
// I/O half of the incumbent ledger import: loads the state the planner needs and applies a plan
// through the import_external_apply / import_external_rollback RPCs (SECURITY DEFINER, see
// migration 20280115000000_incumbent_ledger_import.sql). Uses the CALLER's JWT client, like the
// rest of the import handler — nothing here bypasses RLS or the can_run_data_imports() gate.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { ledgerSignature, type LedgerContext, type LedgerPlanned, type LedgerType } from "./ledger.ts";

type Row = Record<string, string>;
type Page<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

const PAGE = 1000;
const RPC_CHUNK = 500; // must match the limit enforced inside import_external_apply

async function fetchAll<T>(page: (from: number, to: number) => Page<T>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`Could not read existing records: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

interface InvRow { source_id: string; subtotal_cents: number | null; tax_cents: number | null; total_cents: number }

export async function loadLedgerContext(client: SupabaseClient, ownerId: string, type: LedgerType, source: string): Promise<LedgerContext> {
  const q = (table: string, cols: string, sourceCol: string) =>
    (from: number, to: number) => client.from(table).select(cols).eq("user_id", ownerId).eq(sourceCol, source).order("id").range(from, to) as unknown as Page<Record<string, unknown>>;

  const customers = await fetchAll<{ external_id: string }>(
    (from, to) => client.from("customers").select("external_id").eq("user_id", ownerId).eq("external_source", source).not("external_id", "is", null).order("id").range(from, to) as unknown as Page<{ external_id: string }>);
  const invoices = await fetchAll<InvRow>(q("external_invoices", "source_id,subtotal_cents,tax_cents,total_cents", "source_system") as unknown as (f: number, t: number) => Page<InvRow>);

  const existing = new Map<string, string>();
  if (type === "invoices") {
    const rows = await fetchAll<Record<string, unknown>>(q("external_invoices", "source_id,customer_source_id,job_source_id,invoice_number,status,issued_on,due_on,paid_on,subtotal_cents,tax_cents,total_cents,balance_cents", "source_system"));
    for (const r of rows) existing.set(String(r.source_id), ledgerSignature(type, r));
  } else if (type === "line_items") {
    const rows = await fetchAll<Record<string, unknown>>(q("external_invoice_lines", "source_id,invoice_source_id,kind,description,sku,quantity,unit_price_cents,total_cents", "source_system"));
    for (const r of rows) existing.set(String(r.source_id), ledgerSignature(type, { ...r, quantity: Number(r.quantity) }));
  } else if (type === "payments") {
    const rows = await fetchAll<Record<string, unknown>>(q("external_payments", "source_id,invoice_source_id,amount_cents,method,paid_on,reference", "source_system"));
    for (const r of rows) existing.set(String(r.source_id), ledgerSignature(type, r));
  } else {
    const rows = await fetchAll<Record<string, unknown>>(
      (from, to) => client.from("equipment").select("external_id,equipment_type,make,model,serial_number,install_date,notes,customers(external_id)").eq("user_id", ownerId).eq("external_source", source).not("external_id", "is", null).order("id").range(from, to) as unknown as Page<Record<string, unknown>>);
    for (const r of rows) {
      const c = r.customers as { external_id?: string } | { external_id?: string }[] | null;
      const customerSourceId = Array.isArray(c) ? c[0]?.external_id : c?.external_id;
      existing.set(String(r.external_id), ledgerSignature(type, { ...r, customer_source_id: customerSourceId }));
    }
  }

  return {
    existing,
    customerIds: new Set(customers.map((c) => c.external_id)),
    invoices: new Map(invoices.map((i) => [i.source_id, { subtotal: i.subtotal_cents, tax: i.tax_cents, total: i.total_cents }])),
  };
}

interface RowErr { row_number: number; raw_row: Row; error_message: string }

/**
 * Sends every non-rejected row to the RPC (it decides created / updated / unchanged in SQL, so the
 * database stays the single authority and a row the preview called "skip" is still re-checked).
 * Returns the same shape as the handler's applyPlan; effects are recorded inside the RPC.
 */
export async function applyLedgerPlan(client: SupabaseClient, jobId: string, plan: LedgerPlanned[], rows: Row[]) {
  const errors: RowErr[] = [];
  const rawOf = (n: number) => rows[n - 2] ?? {};
  for (const p of plan) {
    if (p.action === "error") {
      errors.push({ row_number: p.rowNumber, raw_row: rawOf(p.rowNumber), error_message: p.issues.filter((i) => i.severity === "error").map((i) => i.message).join(" ") || "Invalid row." });
    }
  }

  const sendable = plan.filter((p) => p.action !== "error" && p.matchedBy !== "in_file");
  let created = 0, updated = 0;
  for (let i = 0; i < sendable.length; i += RPC_CHUNK) {
    const chunk = sendable.slice(i, i + RPC_CHUNK);
    const { data, error } = await client.rpc("import_external_apply", { p_job_id: jobId, p_rows: chunk.map((c) => c.values) });
    if (error) {
      // The RPC is atomic per call: nothing from this chunk was written.
      for (const c of chunk) errors.push({ row_number: c.rowNumber, raw_row: rawOf(c.rowNumber), error_message: friendly(error.message) });
      continue;
    }
    const r = data as { created: number; updated: number; skipped: number; errors: { index: number; message: string }[] };
    created += r.created;
    updated += r.updated;
    for (const e of r.errors ?? []) {
      const c = chunk[e.index - 1];
      if (c) errors.push({ row_number: c.rowNumber, raw_row: rawOf(c.rowNumber), error_message: e.message });
    }
  }
  return { errors, effects: [] as { entity_id: string; action: "created" | "updated"; before_values: Record<string, unknown> | null }[], created, updated };
}

export async function rollbackLedger(client: SupabaseClient, jobId: string): Promise<{ deleted: number; restored: number }> {
  const { data, error } = await client.rpc("import_external_rollback", { p_job_id: jobId });
  if (error) throw new Error(friendly(error.message));
  const r = data as { deleted: number; restored: number };
  return { deleted: r.deleted, restored: r.restored };
}

function friendly(message: string): string {
  if (/not authorized/i.test(message)) return "You don't have permission to import data.";
  return message.length > 300 ? `${message.slice(0, 297)}…` : message;
}
