// supabase/functions/_shared/data-import/ledger.ts
//
// Pure planning for the incumbent ledger imports: invoices, line items, payments, equipment.
// No I/O. The handler loads `existing` state and applies the plan through the
// import_external_apply RPC (see migration 20280115000000_incumbent_ledger_import.sql).
//
// Rules: money is integer cents (string math, no floats); dates are calendar dates (no timezone
// shifting); every row carries a stable source id so re-imports are idempotent; a row that
// cannot be understood is rejected with a reason and never guessed.
//
// FUTURE LIVE API SYNC (NOT built here) would need these incumbent objects:
//   ServiceTitan  — jpm/v2 jobs, accounting/v2 invoices (+ items), accounting/v2 payments,
//                   crm/v2 customers, equipment-systems/v2 installed-equipment.
//   Housecall Pro — /jobs, /invoices (line_items), /customers, /payments (via reports).
//   Jobber        — GraphQL: jobs, invoices (lineItems), clients, payments.

import type { FieldMap, PlannedRow, RowIssue } from "./v2types.ts";

export type LedgerType = "invoices" | "line_items" | "payments" | "equipment";
export const LEDGER_TYPES: readonly LedgerType[] = ["invoices", "line_items", "payments", "equipment"];
export const isLedgerType = (t: unknown): t is LedgerType => LEDGER_TYPES.includes(t as LedgerType);

export const LEDGER_FIELDS: Record<LedgerType, readonly string[]> = {
  invoices: ["external_id", "invoice_number", "customer_external_id", "customer_name", "job_external_id", "status", "issued_on", "due_on", "paid_on", "subtotal", "tax", "total", "balance"],
  line_items: ["external_id", "invoice_external_id", "kind", "description", "sku", "quantity", "unit_price", "total"],
  payments: ["external_id", "invoice_external_id", "amount", "method", "paid_on", "reference"],
  equipment: ["external_id", "customer_external_id", "equipment_type", "make", "model", "serial_number", "install_date", "notes"],
};

export const MAX_CENTS = 9_000_000_000_00; // $9 billion sanity ceiling (also keeps Number math exact)

type Row = Record<string, string>;

// ------------------------------------------------------------------ parsers

const clean = (v: unknown): string => (v === null || v === undefined ? "" : String(v).replace(/\s+/g, " ").trim());

/** "$1,234.56" → 123456, "(12.50)" → -1250, "" → null, "abc" → undefined. Half-up rounding past 2 decimals. */
export function parseCents(raw: string | undefined): number | null | undefined {
  let t = clean(raw);
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  t = t.replace(/\s|[A-Za-z]{3}$|^[A-Za-z]{3}/g, "");
  if (t.startsWith("-")) { neg = !neg; t = t.slice(1); }
  t = t.replace(/^[$€£]/, "").replace(/[$€£]$/, "");
  if (t.startsWith("-")) { neg = !neg; t = t.slice(1); }
  // Separators: both present → the LAST one is the decimal point. Comma only → thousands when it
  // groups exactly 3 digits (1,234 / 1,234,567), otherwise a decimal comma (12,5).
  const lastDot = t.lastIndexOf("."), lastComma = t.lastIndexOf(",");
  if (lastDot !== -1 && lastComma !== -1) {
    t = lastComma > lastDot ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  } else if (lastComma !== -1) {
    t = /^\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, "") : t.replace(",", ".");
  } else if ((t.match(/\./g) ?? []).length > 1) {
    t = /^\d{1,3}(\.\d{3})+$/.test(t) ? t.replace(/\./g, "") : "x";
  }
  if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return undefined;
  const [whole, frac = ""] = t.split(".");
  const padded = (frac + "000").slice(0, 3);
  let cents = Number(whole || "0") * 100 + Number(padded.slice(0, 2));
  if (Number(padded[2]) >= 5) cents += 1;
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) return undefined;
  return neg ? -cents : cents;
}

/** quantity with up to 3 decimals; "" → null; invalid → undefined */
export function parseQuantity(raw: string | undefined): number | null | undefined {
  const t = clean(raw).replace(/,/g, "");
  if (!t) return null;
  if (!/^-?\d+(\.\d+)?$/.test(t)) return undefined;
  const n = Math.round(Number(t) * 1000) / 1000;
  return Number.isFinite(n) && Math.abs(n) < 1e9 ? n : undefined;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Calendar date → "YYYY-MM-DD". "" → null; invalid → undefined. Time-of-day is dropped, never shifted. */
export function parseDate(raw: string | undefined): string | null | undefined {
  const t = clean(raw);
  if (!t) return null;
  let y: number, m: number, d: number;
  let r: RegExpMatchArray | null;
  if ((r = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/))) { y = +r[1]; m = +r[2]; d = +r[3]; }
  else if ((r = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:[ ,T].*)?$/))) { m = +r[1]; d = +r[2]; y = +r[3]; if (r[3].length === 2) y += 2000; }
  else if ((r = t.match(/^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{4})(?:[ ,].*)?$/))) { m = MONTHS[r[1].toLowerCase()] ?? 0; d = +r[2]; y = +r[3]; }
  else if ((r = t.match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{4})$/))) { d = +r[1]; m = MONTHS[r[2].toLowerCase()] ?? 0; y = +r[3]; }
  else return undefined;
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export type InvoiceStatus = "draft" | "sent" | "paid" | "partial" | "void" | "unknown";
export function mapLedgerInvoiceStatus(raw: string | undefined): InvoiceStatus | null {
  const t = clean(raw).toLowerCase();
  if (!t) return null;
  if (/part/.test(t)) return "partial";
  if (/void|cancel|written.?off|deleted/.test(t)) return "void";
  if (/\bpaid\b|settled|closed/.test(t) && !/unpaid|not paid/.test(t)) return "paid";
  if (/draft|pending approval/.test(t)) return "draft";
  if (/sent|open|unpaid|outstanding|past due|overdue|awaiting|issued|due|posted|not paid/.test(t)) return "sent";
  return "unknown";
}

export type PaymentMethod = "cash" | "check" | "card" | "bank_transfer" | "other";
export function mapPaymentMethod(raw: string | undefined): PaymentMethod {
  const t = clean(raw).toLowerCase();
  if (!t) return "other";
  if (/cash/.test(t)) return "cash";
  if (/cheque|check/.test(t)) return "check";
  if (/card|visa|master|amex|discover|credit|debit|stripe|square/.test(t)) return "card";
  if (/ach|bank|wire|transfer|eft|zelle|e-?check/.test(t)) return "bank_transfer";
  return "other";
}

export type LineKind = "part" | "labor" | "other";
export function mapLineKind(raw: string | undefined): LineKind {
  const t = clean(raw).toLowerCase();
  if (/labou?r|hour|service|install|diagnos|trip|visit|time/.test(t)) return "labor";
  if (/part|material|equipment|product|inventory|item|supply/.test(t)) return "part";
  return "other";
}

// ------------------------------------------------------------------ plan types

/** Context loaded by the handler (all keyed by source id, for this account + source system). */
export interface LedgerContext {
  /** source id → signature of the stored row (see ledgerSignature) for this entity type */
  existing: Map<string, string>;
  /** customers already stored for this source (external_id) */
  customerIds: Set<string>;
  /** invoices already stored for this source: source id → header amounts used for the totals check */
  invoices: Map<string, { subtotal: number | null; tax: number | null; total: number }>;
}

export interface LedgerPayload { source_id: string; [k: string]: unknown }
export type LedgerPlanned = PlannedRow & { values: LedgerPayload };

export const requiredLedgerFieldsMapped = (type: LedgerType, m: FieldMap): boolean => {
  switch (type) {
    case "invoices": return Boolean((m.external_id || m.invoice_number) && m.total);
    case "line_items": return Boolean(m.invoice_external_id && (m.total || (m.quantity && m.unit_price)));
    case "payments": return Boolean(m.amount);
    case "equipment": return Boolean(m.customer_external_id && (m.external_id || m.serial_number || m.equipment_type));
  }
};

export const ledgerRequirementMessage = (type: LedgerType): string => ({
  invoices: "Map an invoice ID or invoice number column, and an invoice total column.",
  line_items: "Map the invoice reference column and either a line total, or quantity and unit price.",
  payments: "Map a payment amount column.",
  equipment: "Map the customer ID column and at least a serial number, equipment type, or equipment ID.",
})[type];

/** Canonical comparison string. MUST mirror the comparison done in SQL (null ≡ missing). */
export function ledgerSignature(type: LedgerType, p: Record<string, unknown>): string {
  const keys: Record<LedgerType, string[]> = {
    invoices: ["customer_source_id", "job_source_id", "invoice_number", "status", "issued_on", "due_on", "paid_on", "subtotal_cents", "tax_cents", "total_cents", "balance_cents"],
    line_items: ["invoice_source_id", "kind", "description", "sku", "quantity", "unit_price_cents", "total_cents"],
    payments: ["invoice_source_id", "amount_cents", "method", "paid_on", "reference"],
    equipment: ["customer_source_id", "equipment_type", "make", "model", "serial_number", "install_date", "notes"],
  };
  return JSON.stringify(keys[type].map((k) => (p[k] === undefined || p[k] === "" ? null : p[k])));
}

// ------------------------------------------------------------------ planner

const get = (row: Row, map: FieldMap, f: string): string => (map[f] ? clean(row[map[f]!]) : "");
const nz = (s: string): string | null => (s ? s : null);

/** Stable short hash for derived ids (FNV-1a, 32 bit hex) — only used to keep derived ids short and filesystem-safe. */
export function stableHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

export function planLedger(type: LedgerType, rows: Row[], map: FieldMap, ctx: LedgerContext): LedgerPlanned[] {
  const out: LedgerPlanned[] = [];
  const seen = new Map<string, number>(); // source id → first row number (in-file duplicates)
  const perInvoiceSeq = new Map<string, number>(); // derived line ids
  const perPaymentSeq = new Map<string, number>();
  const fileLineSums = new Map<string, { sum: number; firstRow: number; rows: number }>();

  const linesPass: { idx: number; invoice: string; cents: number }[] = [];

  rows.forEach((row, i) => {
    const rowNumber = i + 2;
    const issues: RowIssue[] = [];
    const fail = (message: string, field?: string): LedgerPlanned => ({
      rowNumber, action: "error", label: `Row ${rowNumber}`, issues: [...issues, { severity: "error", field, message }], values: { source_id: "" }, display: {},
    });
    const warn = (message: string, field?: string) => issues.push({ severity: "warning", field, message });

    const money = (f: string): number | null | "bad" => {
      const v = parseCents(get(row, map, f));
      return v === undefined ? "bad" : v;
    };
    const date = (f: string): string | null | "bad" => {
      const v = parseDate(get(row, map, f));
      return v === undefined ? "bad" : v;
    };

    let payload: LedgerPayload;
    let label = "";
    let display: Record<string, string> = {};

    if (type === "invoices") {
      const number = get(row, map, "invoice_number");
      const sourceId = get(row, map, "external_id") || number;
      if (!sourceId) return void out.push(fail("Missing invoice ID / number.", "external_id"));
      const total = money("total"), subtotal = money("subtotal"), tax = money("tax"), balance = money("balance");
      if (total === "bad" || total === null) return void out.push(fail(total === null ? "Missing invoice total." : "Invoice total isn't a valid amount.", "total"));
      for (const [n, v] of [["subtotal", subtotal], ["tax", tax], ["balance", balance]] as const) if (v === "bad") return void out.push(fail(`${n} isn't a valid amount.`, n));
      const issued = date("issued_on"), due = date("due_on"), paid = date("paid_on");
      for (const [n, v] of [["issued_on", issued], ["due_on", due], ["paid_on", paid]] as const) if (v === "bad") { warn(`${n} isn't a valid date — left blank.`, n); }
      const sub = subtotal as number | null, tx = tax as number | null;
      if (sub !== null && tx !== null && sub + tx !== total) warn(`Subtotal + tax (${fmt(sub + tx)}) ≠ total (${fmt(total)}).`, "total");
      const cust = get(row, map, "customer_external_id");
      if (!cust) warn("No customer ID — invoice will not be linked to a customer.", "customer_external_id");
      else if (!ctx.customerIds.has(cust)) warn(`Customer "${cust}" isn't imported yet — import customers first to link this invoice.`, "customer_external_id");
      const status = mapLedgerInvoiceStatus(get(row, map, "status")) ?? "unknown";
      payload = {
        source_id: sourceId, customer_source_id: nz(cust), job_source_id: nz(get(row, map, "job_external_id")), invoice_number: nz(number),
        status, issued_on: issued === "bad" ? null : issued, due_on: due === "bad" ? null : due, paid_on: paid === "bad" ? null : paid,
        subtotal_cents: sub, tax_cents: tx, total_cents: total, balance_cents: balance === "bad" ? null : balance,
      };
      label = `Invoice ${number || sourceId}`;
      display = { Invoice: number || sourceId, Customer: get(row, map, "customer_name") || cust, Status: status, Total: fmt(total) };
    } else if (type === "line_items") {
      const inv = get(row, map, "invoice_external_id");
      if (!inv) return void out.push(fail("Missing invoice reference.", "invoice_external_id"));
      const qty = parseQuantity(get(row, map, "quantity")), unit = parseCents(get(row, map, "unit_price")), totalRaw = parseCents(get(row, map, "total"));
      if (qty === undefined) return void out.push(fail("Quantity isn't a number.", "quantity"));
      if (unit === undefined) return void out.push(fail("Unit price isn't a valid amount.", "unit_price"));
      if (totalRaw === undefined) return void out.push(fail("Line total isn't a valid amount.", "total"));
      const quantity = qty ?? 1;
      let total = totalRaw;
      if (total === null) {
        if (unit === null) return void out.push(fail("Line has neither a total nor a unit price.", "total"));
        total = Math.round(unit * quantity);
      }
      const unitCents = unit ?? (quantity !== 0 ? Math.round(total / quantity) : 0);
      if (unit !== null && totalRaw !== null && Math.abs(Math.round(unit * quantity) - totalRaw) > 1) warn("Quantity × unit price doesn't equal the line total; the line total is used.", "total");
      const seq = (perInvoiceSeq.get(inv) ?? 0) + 1;
      perInvoiceSeq.set(inv, seq);
      const sourceId = get(row, map, "external_id") || `${inv}#${seq}`;
      if (!ctx.invoices.has(inv)) warn(`Invoice "${inv}" isn't imported yet — this line will be rejected until invoices are imported.`, "invoice_external_id");
      payload = {
        source_id: sourceId, invoice_source_id: inv, kind: mapLineKind(get(row, map, "kind")), description: nz(get(row, map, "description")),
        sku: nz(get(row, map, "sku")), quantity, unit_price_cents: unitCents, total_cents: total,
      };
      linesPass.push({ idx: out.length, invoice: inv, cents: total });
      label = `Line ${inv} #${seq}`;
      display = { Invoice: inv, Item: get(row, map, "description") || get(row, map, "sku"), Qty: String(quantity), Total: fmt(total) };
    } else if (type === "payments") {
      const amount = parseCents(get(row, map, "amount"));
      if (amount === null || amount === undefined) return void out.push(fail(amount === null ? "Missing payment amount." : "Payment amount isn't valid.", "amount"));
      if (amount === 0) return void out.push(fail("Payment amount is zero.", "amount"));
      const paid = date("paid_on");
      if (paid === "bad") warn("Payment date isn't valid — left blank.", "paid_on");
      const inv = get(row, map, "invoice_external_id");
      if (!inv) warn("No invoice reference — payment is kept unlinked.", "invoice_external_id");
      else if (!ctx.invoices.has(inv)) warn(`Invoice "${inv}" isn't imported yet — payment will stay unlinked.`, "invoice_external_id");
      const paidOn = paid === "bad" ? null : paid;
      const natural = `${inv}|${paidOn ?? ""}|${amount}`;
      const seq = (perPaymentSeq.get(natural) ?? 0) + 1;
      perPaymentSeq.set(natural, seq);
      const sourceId = get(row, map, "external_id") || `${inv || "none"}|${paidOn ?? "nodate"}|${amount}|${seq}`;
      payload = { source_id: sourceId, invoice_source_id: nz(inv), amount_cents: amount, method: mapPaymentMethod(get(row, map, "method")), paid_on: paidOn, reference: nz(get(row, map, "reference")) };
      label = `Payment ${fmt(amount)}${paidOn ? ` on ${paidOn}` : ""}`;
      display = { Invoice: inv, Date: paidOn ?? "", Method: String(payload.method), Amount: fmt(amount) };
    } else {
      const cust = get(row, map, "customer_external_id");
      if (!cust) return void out.push(fail("Missing customer ID.", "customer_external_id"));
      if (!ctx.customerIds.has(cust)) return void out.push(fail(`Customer "${cust}" not found — import customers first.`, "customer_external_id"));
      const install = date("install_date");
      if (install === "bad") warn("Install date isn't valid — left blank.", "install_date");
      const serial = get(row, map, "serial_number"), etype = get(row, map, "equipment_type"), make = get(row, map, "make"), model = get(row, map, "model");
      const sourceId = get(row, map, "external_id") || (serial ? `${cust}|${serial.toLowerCase()}` : `${cust}|${stableHash([etype, make, model, install === "bad" ? "" : install ?? ""].join("|").toLowerCase())}`);
      if (!serial) warn("No serial number — equipment is matched by type/make/model/install date on re-import.", "serial_number");
      payload = { source_id: sourceId, customer_source_id: cust, equipment_type: etype || "Equipment", make: nz(make), model: nz(model), serial_number: nz(serial), install_date: install === "bad" ? null : install, notes: nz(get(row, map, "notes")) };
      label = [make, model].filter(Boolean).join(" ") || etype || `Equipment ${sourceId}`;
      display = { Customer: cust, Equipment: label, Serial: serial, Installed: install === "bad" ? "" : install ?? "" };
    }

    const prior = seen.get(payload.source_id);
    if (prior !== undefined) {
      out.push({ rowNumber, action: "skip", label, matchedBy: "in_file", duplicateOfRow: prior, issues: [...issues, { severity: "info", message: `Duplicate of row ${prior} in this file.` }], values: payload, display });
      return;
    }
    seen.set(payload.source_id, rowNumber);

    const stored = ctx.existing.get(payload.source_id);
    const action = stored === undefined ? "create" : stored === ledgerSignature(type, payload) ? "skip" : "update";
    out.push({ rowNumber, action, label, matchedBy: stored === undefined ? undefined : "external_id", issues, values: payload, display });
  });

  // ---- totals check: sum(lines per invoice) == invoice subtotal (or total − tax)
  if (type === "line_items") {
    for (const l of linesPass) {
      const cur = fileLineSums.get(l.invoice);
      if (cur) { cur.sum += l.cents; cur.rows++; } else fileLineSums.set(l.invoice, { sum: l.cents, firstRow: out[l.idx].rowNumber, rows: 1 });
    }
    for (const [inv, s] of fileLineSums) {
      const h = ctx.invoices.get(inv);
      if (!h) continue;
      const expected = expectedLinesTotal(h);
      if (s.sum !== expected) {
        const first = out.find((r) => r.rowNumber === s.firstRow)!;
        first.issues.push({ severity: "warning", field: "total", message: `Lines for invoice ${inv} add up to ${fmt(s.sum)} but the invoice expects ${fmt(expected)} (difference ${fmt(s.sum - expected)}).` });
      }
    }
  }
  return out;
}

export const expectedLinesTotal = (h: { subtotal: number | null; tax: number | null; total: number }): number => h.subtotal ?? h.total - (h.tax ?? 0);

export function fmt(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const a = Math.abs(cents);
  return `${sign}$${Math.floor(a / 100).toLocaleString("en-US")}.${String(a % 100).padStart(2, "0")}`;
}

/** Totals report for the validation screen: per-invoice mismatch count is derived from warnings, this gives file-level sums. */
export function ledgerTotals(plan: LedgerPlanned[], type: LedgerType): { rows: number; sum_cents: number } | null {
  const key = type === "invoices" ? "total_cents" : type === "line_items" ? "total_cents" : type === "payments" ? "amount_cents" : null;
  if (!key) return null;
  let sum = 0, rows = 0;
  for (const r of plan) if (r.action !== "error" && r.matchedBy !== "in_file") { sum += Number(r.values[key] ?? 0); rows++; }
  return { rows, sum_cents: sum };
}
