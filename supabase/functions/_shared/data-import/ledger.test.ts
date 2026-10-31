// supabase/functions/_shared/data-import/ledger.test.ts
import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv";
import {
  LEDGER_FIELDS, expectedLinesTotal, ledgerSignature, ledgerTotals, mapLedgerInvoiceStatus, mapLineKind, mapPaymentMethod,
  parseCents, parseDate, parseQuantity, planLedger, requiredLedgerFieldsMapped, stableHash,
  type LedgerContext, type LedgerPlanned, type LedgerType,
} from "./ledger";
import { FIXTURE_SOURCES, buildFixture, type FixtureSource } from "./ledgerFixtures";
import { autoMap } from "../../../../src/lib/importPresets";
import { LEDGER_FIELD_DEFS, isLedgerMappingComplete } from "../../../../src/lib/importLedgerProfiles";

/** In-memory twin of public.import_external_apply (same keys, same compare, same parent rules). */
class FakeDb {
  stores: Record<LedgerType, Map<string, string>> = { invoices: new Map(), line_items: new Map(), payments: new Map(), equipment: new Map() };
  invoiceHeaders = new Map<string, { subtotal: number | null; tax: number | null; total: number }>();
  customers = new Set<string>();
  apply(type: LedgerType, plan: LedgerPlanned[]) {
    let created = 0, updated = 0, skipped = 0, errors = 0;
    for (const r of plan) {
      if (r.action === "error" || r.matchedBy === "in_file") continue;
      const v = r.values;
      if (type === "line_items" && !this.invoiceHeaders.has(String(v.invoice_source_id))) { errors++; continue; }
      if (type === "equipment" && !this.customers.has(String(v.customer_source_id))) { errors++; continue; }
      const sig = ledgerSignature(type, v), cur = this.stores[type].get(v.source_id);
      if (cur === undefined) created++; else if (cur !== sig) updated++; else skipped++;
      this.stores[type].set(v.source_id, sig);
      if (type === "invoices") this.invoiceHeaders.set(v.source_id, { subtotal: v.subtotal_cents as number | null, tax: v.tax_cents as number | null, total: v.total_cents as number });
    }
    return { created, updated, skipped, errors };
  }
  ctx(type: LedgerType): LedgerContext {
    return { existing: new Map(this.stores[type]), customerIds: new Set(this.customers), invoices: new Map(this.invoiceHeaders) };
  }
  counts() { return Object.fromEntries((Object.keys(this.stores) as LedgerType[]).map((t) => [t, this.stores[t].size])); }
}

const ORDER: LedgerType[] = ["invoices", "line_items", "payments", "equipment"];
const PRESET_FOR = (s: FixtureSource, t: LedgerType) => (s === "jobber" && t === "equipment" ? "csv" : s);

function planFile(src: FixtureSource, type: LedgerType, text: string, ctx: LedgerContext) {
  const { headers, rows } = parseCsv(text);
  const { mapping } = autoMap(headers, type, PRESET_FOR(src, type));
  expect(isLedgerMappingComplete(type, mapping as Record<string, string>), `${src}/${type} auto-map complete: ${JSON.stringify(mapping)}`).toBe(true);
  return { plan: planLedger(type, rows, mapping, ctx), rows, mapping };
}

describe("parsers", () => {
  it("parses money to integer cents without float drift", () => {
    expect(parseCents("$1,234.56")).toBe(123456);
    expect(parseCents("(12.50)")).toBe(-1250);
    expect(parseCents("-12.5")).toBe(-1250);
    expect(parseCents("0.1")).toBe(10);
    expect(parseCents("19.995")).toBe(2000);
    expect(parseCents("1.005")).toBe(101);
    expect(parseCents("1,234")).toBe(123400);
    expect(parseCents("1.234,56")).toBe(123456);
    expect(parseCents("12,5")).toBe(1250);
    expect(parseCents("")).toBeNull();
    expect(parseCents("abc")).toBeUndefined();
    expect(parseCents("1e9999")).toBeUndefined();
    expect(parseCents("99999999999999")).toBeUndefined();
  });
  it("parses dates as calendar dates and rejects impossible ones", () => {
    expect(parseDate("2027-02-03")).toBe("2027-02-03");
    expect(parseDate("2/3/2027")).toBe("2027-02-03");
    expect(parseDate("2/3/27 4:15 PM")).toBe("2027-02-03");
    expect(parseDate("Feb 3, 2027")).toBe("2027-02-03");
    expect(parseDate("2027-02-30")).toBeUndefined();
    expect(parseDate("13/45/2027")).toBeUndefined();
    expect(parseDate("")).toBeNull();
    expect(parseDate("soon")).toBeUndefined();
  });
  it("maps status / method / kind / quantity", () => {
    expect(mapLedgerInvoiceStatus("Paid in full")).toBe("paid");
    expect(mapLedgerInvoiceStatus("Unpaid")).toBe("sent");
    expect(mapLedgerInvoiceStatus("Partially paid")).toBe("partial");
    expect(mapLedgerInvoiceStatus("Voided")).toBe("void");
    expect(mapLedgerInvoiceStatus("Awaiting payment")).toBe("sent");
    expect(mapLedgerInvoiceStatus("???")).toBe("unknown");
    expect(mapPaymentMethod("Credit Card")).toBe("card");
    expect(mapPaymentMethod("Check #12")).toBe("check");
    expect(mapPaymentMethod("ACH")).toBe("bank_transfer");
    expect(mapLineKind("Material")).toBe("part");
    expect(mapLineKind("Labor")).toBe("labor");
    expect(parseQuantity("2.5")).toBe(2.5);
    expect(parseQuantity("x")).toBeUndefined();
  });
});

describe("import profiles (ServiceTitan / Jobber / Housecall Pro)", () => {
  for (const src of FIXTURE_SOURCES) {
    it(`${src}: every file auto-maps, parses with zero rejected rows and zero warnings that matter`, () => {
      const fx = buildFixture(src);
      const db = new FakeDb();
      fx.customerIds.forEach((c) => db.customers.add(c));
      for (const t of ORDER) {
        const { plan } = planFile(src, t, fx.files[t], db.ctx(t));
        expect(plan.length).toBe(fx.counts[t]);
        expect(plan.filter((p) => p.action === "error"), `${src}/${t} rejected`).toHaveLength(0);
        const totalsWarn = plan.flatMap((p) => p.issues).filter((i) => i.severity === "warning" && /add up|≠/.test(i.message));
        expect(totalsWarn, `${src}/${t} totals warnings`).toHaveLength(0);
        db.apply(t, plan);
      }
    });

    it(`${src}: a 6-month export imports twice with identical final counts (DONE-WHEN)`, () => {
      const fx = buildFixture(src);
      const db = new FakeDb();
      fx.customerIds.forEach((c) => db.customers.add(c));
      const run = () => ORDER.map((t) => db.apply(t, planFile(src, t, fx.files[t], db.ctx(t)).plan));
      const first = run();
      const afterFirst = db.counts();
      const second = run();
      expect(db.counts()).toEqual(afterFirst);
      expect(afterFirst).toEqual({ invoices: fx.counts.invoices, line_items: fx.counts.line_items, payments: fx.counts.payments, equipment: fx.counts.equipment });
      second.forEach((r, i) => { expect(r.created, `${src}/${ORDER[i]} created on re-import`).toBe(0); expect(r.updated).toBe(0); expect(r.errors).toBe(0); expect(r.skipped).toBe(fx.counts[ORDER[i]]); });
      first.forEach((r, i) => expect(r.created, `${src}/${ORDER[i]} created on first import`).toBe(fx.counts[ORDER[i]]));
    });
  }
});

describe("validation: rejected rows, totals, duplicates", () => {
  const map = { external_id: "id", total: "total", subtotal: "subtotal", tax: "tax", customer_external_id: "cust", issued_on: "date" };
  const ctx = (customers: string[] = ["C1"]): LedgerContext => ({ existing: new Map(), customerIds: new Set(customers), invoices: new Map() });

  it("rejects malformed invoice rows with a reason and never guesses", () => {
    const rows = [
      { id: "A1", total: "10.00", subtotal: "10.00", tax: "0", cust: "C1", date: "1/2/2027" },
      { id: "", total: "10.00", subtotal: "", tax: "", cust: "C1", date: "" },
      { id: "A3", total: "twelve", subtotal: "", tax: "", cust: "C1", date: "" },
      { id: "A4", total: "", subtotal: "", tax: "", cust: "C1", date: "" },
      { id: "A5", total: "5.00", subtotal: "", tax: "", cust: "C1", date: "31/31/2027" },
    ];
    const plan = planLedger("invoices", rows, map, ctx());
    expect(plan.map((p) => p.action)).toEqual(["create", "error", "error", "error", "create"]);
    expect(plan[1].issues[0].message).toMatch(/Missing invoice ID/);
    expect(plan[2].issues[0].message).toMatch(/total isn't a valid amount/);
    expect(plan[3].issues[0].message).toMatch(/Missing invoice total/);
    expect(plan[4].values.issued_on).toBeNull();
    expect(plan[4].issues.some((i) => i.severity === "warning" && i.field === "issued_on")).toBe(true);
  });

  it("warns when subtotal + tax ≠ total, and when the customer is not imported yet", () => {
    const plan = planLedger("invoices", [{ id: "B1", total: "110.00", subtotal: "100.00", tax: "5.00", cust: "NOPE", date: "" }], map, ctx());
    const msgs = plan[0].issues.map((i) => i.message).join(" | ");
    expect(msgs).toMatch(/Subtotal \+ tax/);
    expect(msgs).toMatch(/isn't imported yet/);
    expect(plan[0].action).toBe("create");
  });

  it("totals check: lines must add up to the invoice (sum(lines) == invoice total)", () => {
    const c: LedgerContext = { existing: new Map(), customerIds: new Set(), invoices: new Map([["I1", { subtotal: 10000, tax: 800, total: 10800 }], ["I2", { subtotal: null, tax: null, total: 5000 }]]) };
    const lm = { invoice_external_id: "inv", description: "d", total: "t" };
    const ok = planLedger("line_items", [{ inv: "I2", d: "a", t: "20.00" }, { inv: "I2", d: "b", t: "30.00" }], lm, c);
    expect(ok.flatMap((p) => p.issues).filter((i) => i.severity === "warning")).toHaveLength(0);
    const bad = planLedger("line_items", [{ inv: "I1", d: "a", t: "90.00" }], lm, c);
    expect(bad[0].issues.find((i) => i.severity === "warning")?.message).toMatch(/\$90\.00 .*expects \$100\.00 .*-\$10\.00/);
    expect(expectedLinesTotal({ subtotal: null, tax: 800, total: 10800 })).toBe(10000);
  });

  it("derives stable ids: line position, payment natural key, equipment serial", () => {
    const c: LedgerContext = { existing: new Map(), customerIds: new Set(["C1"]), invoices: new Map([["I1", { subtotal: null, tax: null, total: 300 }]]) };
    const L = planLedger("line_items", [{ inv: "I1", t: "1.00" }, { inv: "I1", t: "2.00" }], { invoice_external_id: "inv", total: "t" }, c);
    expect(L.map((p) => p.values.source_id)).toEqual(["I1#1", "I1#2"]);
    const P = planLedger("payments", [{ i: "I1", a: "5.00", d: "1/1/2027" }, { i: "I1", a: "5.00", d: "1/1/2027" }], { invoice_external_id: "i", amount: "a", paid_on: "d" }, c);
    expect(P.map((p) => p.values.source_id)).toEqual(["I1|2027-01-01|500|1", "I1|2027-01-01|500|2"]);
    const E = planLedger("equipment", [{ c: "C1", s: "SN-9", t: "Furnace" }, { c: "C1", s: "", t: "Furnace" }], { customer_external_id: "c", serial_number: "s", equipment_type: "t" }, c);
    expect(E[0].values.source_id).toBe("C1|sn-9");
    expect(E[1].values.source_id).toBe(`C1|${stableHash("furnace|||")}`);
  });

  it("flags in-file duplicates as skipped and rejects unusable lines/payments/equipment", () => {
    const dup = planLedger("invoices", [{ id: "D1", total: "1.00", cust: "C1" }, { id: "D1", total: "1.00", cust: "C1" }], map, ctx());
    expect(dup[1]).toMatchObject({ action: "skip", matchedBy: "in_file", duplicateOfRow: 2 });
    expect(planLedger("payments", [{ a: "0.00" }, { a: "" }, { a: "x" }], { amount: "a" }, ctx()).map((p) => p.action)).toEqual(["error", "error", "error"]);
    expect(planLedger("line_items", [{ inv: "", t: "1.00" }], { invoice_external_id: "inv", total: "t" }, ctx())[0].action).toBe("error");
    expect(planLedger("equipment", [{ c: "GHOST", s: "S1" }], { customer_external_id: "c", serial_number: "s" }, ctx())[0].issues[0].message).toMatch(/import customers first/);
  });

  it("changed rows become updates, identical rows skips", () => {
    const first = planLedger("invoices", [{ id: "U1", total: "10.00", cust: "C1" }], map, ctx());
    const c = ctx(); c.existing.set("U1", ledgerSignature("invoices", first[0].values));
    expect(planLedger("invoices", [{ id: "U1", total: "10.00", cust: "C1" }], map, c)[0].action).toBe("skip");
    expect(planLedger("invoices", [{ id: "U1", total: "11.00", cust: "C1" }], map, c)[0].action).toBe("update");
  });

  it("reports file-level totals without counting rejected or duplicate rows", () => {
    const plan = planLedger("invoices", [{ id: "T1", total: "10.00" }, { id: "T1", total: "10.00" }, { id: "", total: "5.00" }, { id: "T2", total: "2.50" }], map, ctx());
    expect(ledgerTotals(plan, "invoices")).toEqual({ rows: 2, sum_cents: 1250 });
    expect(ledgerTotals(plan, "equipment")).toBeNull();
  });
});

describe("contract with the client profiles", () => {
  it("server field allow-list equals client field defs for every ledger type", () => {
    for (const t of Object.keys(LEDGER_FIELDS) as LedgerType[]) expect(LEDGER_FIELD_DEFS[t].map((f) => f.key)).toEqual([...LEDGER_FIELDS[t]]);
  });
  it("client and server agree on when a mapping is complete", () => {
    const cases: [LedgerType, Record<string, string>][] = [
      ["invoices", { total: "t" }], ["invoices", { total: "t", invoice_number: "n" }], ["line_items", { invoice_external_id: "i" }],
      ["line_items", { invoice_external_id: "i", quantity: "q", unit_price: "u" }], ["payments", { amount: "a" }], ["equipment", { customer_external_id: "c" }], ["equipment", { customer_external_id: "c", serial_number: "s" }],
    ];
    for (const [t, m] of cases) expect(isLedgerMappingComplete(t, m)).toBe(requiredLedgerFieldsMapped(t, m));
  });
});

describe("performance (10,000 rows)", () => {
  it("plans a 10k-row invoice file well inside an edge-function budget", () => {
    const fx = buildFixture("service_titan", { invoices: 10_000, customers: 500 });
    const parseStart = performance.now();
    const { headers, rows } = parseCsv(fx.files.invoices);
    const parseMs = performance.now() - parseStart;
    const { mapping } = autoMap(headers, "invoices", "service_titan");
    const ctx: LedgerContext = { existing: new Map(), customerIds: new Set(fx.customerIds), invoices: new Map() };
    const planStart = performance.now();
    const plan = planLedger("invoices", rows, mapping, ctx);
    const planMs = performance.now() - planStart;
    console.info(`[perf] 10k invoices: parse ${parseMs.toFixed(0)}ms, plan ${planMs.toFixed(0)}ms`);
    expect(plan).toHaveLength(10_000);
    expect(plan.filter((p) => p.action === "error")).toHaveLength(0);
    expect(parseMs + planMs).toBeLessThan(3000);
  });
});
