// supabase/functions/_shared/emergency-access/csv.ts
// CSV for exports. Customer-controlled text (names, notes, addresses) ends up in a file the contact
// opens in a spreadsheet, so cells that could be read as formulas are neutralised (CSV/formula injection).

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (typeof v === "number") s = Number.isFinite(v) ? String(v) : "";
  else if (typeof v === "boolean") s = v ? "true" : "false";
  else if (typeof v === "string") s = FORMULA_START.test(v) ? `'${v}` : v;
  else s = JSON.stringify(v);
  if (typeof v === "object" && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: readonly string[], rows: ReadonlyArray<Record<string, unknown>>): string {
  const lines = [columns.map(csvCell).join(",")];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

/** Fixed column order per scope; must match the whitelist in emergency_read(). */
export const SCOPE_COLUMNS: Record<string, readonly string[]> = {
  customers: ["id", "name", "phone", "email", "address", "customer_type", "lifecycle_stage"],
  invoices: ["id", "invoice_number", "customer_name", "status", "issue_date", "due_date", "subtotal_cents", "tax_cents", "total_cents", "amount_paid_cents"],
  jobs: ["id", "customer_name", "service_type", "address", "scheduled_datetime", "job_status", "invoice_amount", "invoice_status"],
};
