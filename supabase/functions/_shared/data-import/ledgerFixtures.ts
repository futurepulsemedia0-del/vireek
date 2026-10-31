// supabase/functions/_shared/data-import/ledgerFixtures.ts
//
// Deterministic, ANONYMIZED SYNTHETIC exports (no real customer data) in the column dialect of each
// source: a 6-month history (Jan–Jun 2027) of invoices, lines, payments and equipment.
// Header spellings follow each platform's typical report layout and are NOT verified against live
// exports — which is exactly why the wizard lets the user confirm/save the mapping.
import type { LedgerType } from "./ledger.ts";

export type FixtureSource = "service_titan" | "jobber" | "housecall_pro";
export const FIXTURE_SOURCES: FixtureSource[] = ["service_titan", "jobber", "housecall_pro"];

function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const money = (c: number) => (c / 100).toFixed(2);
const q = (v: string | number) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (headers: string[], rows: (string | number)[][]) => [headers.map(q).join(","), ...rows.map((r) => r.map(q).join(","))].join("\n");
const iso = (d: Date) => d.toISOString().slice(0, 10);
const us = (d: Date) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;

export interface Fixture { customerIds: string[]; files: Record<LedgerType, string>; counts: Record<LedgerType, number> }

/** Customer ids `${prefix}C001…`: what the customers import would have produced for this source. */
export function buildFixture(source: FixtureSource, opts: { invoices?: number; customers?: number; seed?: number } = {}): Fixture {
  const nInv = opts.invoices ?? 300, nCust = opts.customers ?? 40;
  const rand = rng((opts.seed ?? 7) + source.length);
  const customerIds = Array.from({ length: nCust }, (_, i) => `C${String(i + 1).padStart(3, "0")}`);
  const taxRate = source === "housecall_pro" ? 0 : 0.08;
  const start = Date.UTC(2027, 0, 1), span = 181 * 86400000;

  const inv: (string | number)[][] = [], lines: (string | number)[][] = [], pays: (string | number)[][] = [];
  for (let i = 1; i <= nInv; i++) {
    const cust = customerIds[Math.floor(rand() * nCust)];
    const date = new Date(start + Math.floor((i / nInv) * span));
    const due = new Date(date.getTime() + 30 * 86400000), paid = new Date(date.getTime() + Math.floor(rand() * 20) * 86400000);
    const id = `${source === "service_titan" ? 9000000 : 0}${1000 + i}`, num = String(1000 + i);
    const nLines = 2 + Math.floor(rand() * 3);
    let sub = 0;
    const lineRows: (string | number)[][] = [];
    for (let l = 1; l <= nLines; l++) {
      const labor = l === 1, qty = labor ? 1 + Math.floor(rand() * 3) : 1, unit = (labor ? 9500 : 1500 + Math.floor(rand() * 90000)) + Math.floor(rand() * 100);
      sub += qty * unit;
      const base = [source === "service_titan" ? id : num, labor ? (source === "jobber" ? "Service" : "Labor") : "Part", labor ? "Diagnostic and repair labor" : `Part ${l}, "OEM"`, labor ? "" : `P-${i}-${l}`, qty, money(unit), money(qty * unit)];
      lineRows.push(base);
    }
    const tax = Math.round(sub * taxRate), total = sub + tax;
    const isPaid = rand() < 0.7;
    lines.push(...lineRows);
    const status = isPaid ? (source === "jobber" ? "Paid" : "Paid in full") : (source === "jobber" ? "Awaiting payment" : "Unpaid");
    if (source === "service_titan") inv.push([id, num, cust, `Customer ${cust}`, `J${i}`, status, us(date), us(due), money(sub), money(tax), money(total), isPaid ? "0.00" : money(total)]);
    else if (source === "jobber") inv.push([num, `Client ${cust}`, cust, `J${i}`, iso(date), iso(due), isPaid ? iso(paid) : "", status, money(sub), money(total), isPaid ? "0.00" : money(total)]);
    else inv.push([num, cust, `Customer ${cust}`, `J${i}`, us(date), isPaid ? us(paid) : "", status, money(total), isPaid ? "0.00" : money(total)]);
    if (isPaid) {
      const method = ["Credit Card", "Check", "Cash", "ACH"][Math.floor(rand() * 4)];
      if (source === "service_titan") pays.push([`PM${i}`, num, us(paid), method, money(total), method === "Check" ? `#${2000 + i}` : ""]);
      else pays.push([num, us(paid), method, money(total), method === "Check" ? `#${2000 + i}` : ""]);
    }
  }
  const equip: (string | number)[][] = [];
  customerIds.slice(0, Math.floor(nCust * 0.6)).forEach((c, i) => equip.push([c, i % 2 ? "Furnace" : "Air Conditioner", i % 2 ? "Carrier" : "Trane", `MDL-${100 + i}`, `SN${50000 + i}`, us(new Date(Date.UTC(2020 + (i % 6), i % 12, 10)))]));

  const H = {
    service_titan: {
      invoices: ["Invoice ID", "Invoice #", "Customer ID", "Customer Name", "Job Number", "Status", "Invoice Date", "Due Date", "Subtotal", "Tax", "Invoice Total", "Balance"],
      line_items: ["Invoice ID", "Item Type", "Item Description", "SKU", "Quantity", "Price", "Total"],
      payments: ["Payment ID", "Invoice Number", "Payment Date", "Payment Type", "Amount", "Memo"],
    },
    jobber: {
      invoices: ["Invoice #", "Client name", "Client ID", "Job #", "Issued date", "Due date", "Marked paid date", "Status", "Subtotal ($)", "Total ($)", "Balance ($)"],
      line_items: ["Invoice #", "Type", "Name", "SKU", "Qty", "Unit price", "Total"],
      payments: ["Invoice #", "Payment date", "Payment method", "Amount", "Reference"],
    },
    housecall_pro: {
      invoices: ["Invoice #", "Customer ID", "Customer", "Job #", "Invoice date", "Paid date", "Status", "Total", "Amount due"],
      line_items: ["Invoice Number", "Type", "Item Name", "SKU", "Quantity", "Unit Price", "Total"],
      payments: ["Invoice Number", "Payment Date", "Payment Method", "Amount", "Reference"],
    },
  }[source];
  const eqH = source === "jobber" ? ["Customer ID", "Equipment type", "Make", "Model", "Serial number", "Install date"] : ["Customer ID", "Equipment Type", "Manufacturer", "Model", "Serial Number", "Install Date"];

  return {
    customerIds,
    files: { invoices: csv(H.invoices, inv), line_items: csv(H.line_items, lines), payments: csv(H.payments, pays), equipment: csv(eqH, equip) },
    counts: { invoices: inv.length, line_items: lines.length, payments: pays.length, equipment: equip.length },
  };
}
