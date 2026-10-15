// supabase/functions/_shared/data-import/plan.ts
//
// The import engine's brain: turns parsed rows + a column mapping + the
// account's EXISTING records into a per-row plan (create / update / skip /
// error) with human-readable issues. Pure — no database, no clock unless
// injected — so the validation preview, the real run, and the unit tests all
// execute exactly the same logic.
//
// Dedupe philosophy (why re-imports are safe and nothing is silently merged
// into the wrong person):
//   1. Same source + same external id  → the same record (authoritative).
//   2. Otherwise phone / email / name+address match an existing record, UNLESS
//      both sides carry DIFFERENT external ids from the same source — then
//      they are provably different people (e.g. spouses sharing a phone) and
//      the shared phone/email is dropped from the new record with a warning
//      (customers has a unique index on phone and email per account).
//   3. Rows that repeat inside the file are skipped, pointing at the first row.

import {
  cleanText, joinAddress, looseKey, mapCustomerType, mapInvoiceStatus, mapJobStatus, normalizeEmail,
  normalizePhone, parseDateTime, parseMoney, phoneKey,
} from "./normalize.ts";
import type {
  DedupeStrategy, ExistingCustomer, ExistingJob, FieldMap, MatchedBy, PlannedRow, PlanSummary, RowIssue,
} from "./v2types.ts";

type Row = Record<string, string>;

const pick = (row: Row, header: string | undefined): string => (header ? cleanText(row[header]) : "");

const sameText = (a: unknown, b: unknown) => cleanText(a).toLowerCase() === cleanText(b).toLowerCase();

function nameAddressKey(name: string | null | undefined, address: string | null | undefined): string | null {
  const n = looseKey(name);
  const a = looseKey(address);
  return n && a ? `${n}|${a}` : null;
}

interface FileEntry { row: number; ext: string }

/** Two rows are "provably distinct" only when both carry different external ids. */
const distinctByExt = (a: string, b: string | null | undefined) => Boolean(a && b && a !== b);

export function summarize(plan: PlannedRow[]): PlanSummary {
  const summary: PlanSummary = { total: plan.length, create: 0, update: 0, skip: 0, error: 0, warnings: 0, duplicates: 0 };
  for (const row of plan) {
    summary[row.action] += 1;
    if (row.issues.some((i) => i.severity === "warning")) summary.warnings += 1;
    if (row.matchedBy) summary.duplicates += 1;
  }
  return summary;
}

// =================================================================== customers

export function requiredCustomerFieldsMapped(map: FieldMap): boolean {
  return Boolean(map.name || map.first_name || map.last_name || map.company);
}

export function planCustomers(
  rows: Row[],
  map: FieldMap,
  source: string,
  strategy: DedupeStrategy,
  existing: ExistingCustomer[],
): PlannedRow[] {
  const byExt = new Map<string, ExistingCustomer>();
  const byPhone = new Map<string, ExistingCustomer>();
  const byEmail = new Map<string, ExistingCustomer>();
  const byNameAddr = new Map<string, ExistingCustomer>();
  for (const c of existing) {
    if (c.external_source === source && c.external_id) byExt.set(c.external_id, c);
    const pk = phoneKey(c.phone);
    if (pk && !byPhone.has(pk)) byPhone.set(pk, c);
    const em = cleanText(c.email).toLowerCase();
    if (em && !byEmail.has(em)) byEmail.set(em, c);
    const na = nameAddressKey(c.name, c.address);
    if (na && !byNameAddr.has(na)) byNameAddr.set(na, c);
  }

  const claimed = new Map<string, FileEntry>(); // existing id → first row that targeted it
  const fileExt = new Map<string, number>();
  const filePhone = new Map<string, FileEntry>();
  const fileEmail = new Map<string, FileEntry>();
  const fileNameAddr = new Map<string, FileEntry>();

  return rows.map((row, i): PlannedRow => {
    const rowNumber = i + 2; // header row + 1-indexing
    const issues: RowIssue[] = [];

    const first = pick(row, map.first_name);
    const last = pick(row, map.last_name);
    const company = pick(row, map.company);
    const personName = pick(row, map.name) || [first, last].filter(Boolean).join(" ");
    const name = personName || company;

    const rawPhone = pick(row, map.phone);
    let phone = rawPhone ? normalizePhone(rawPhone) : null;
    if (rawPhone && !phone) issues.push({ severity: "warning", field: "phone", message: `"${rawPhone}" isn't a valid phone number — left blank.` });

    const rawEmail = pick(row, map.email);
    let email = rawEmail ? normalizeEmail(rawEmail) : null;
    if (rawEmail && !email) issues.push({ severity: "warning", field: "email", message: `"${rawEmail}" isn't a valid email — left blank.` });

    const address = joinAddress({ street: pick(row, map.address), city: pick(row, map.city), state: pick(row, map.state), zip: pick(row, map.zip) });
    const notes = pick(row, map.notes);
    const ext = pick(row, map.external_id);

    let customerType = mapCustomerType(pick(row, map.customer_type));
    if (customerType === undefined) {
      issues.push({ severity: "warning", field: "customer_type", message: `Unrecognized customer type "${pick(row, map.customer_type)}" — defaulted to residential.` });
      customerType = null;
    }
    if (customerType === null && company && !personName) customerType = "commercial";

    const display = { name, phone: phone?.e164 ?? "", email: email ?? "", address };
    const base = { rowNumber, label: name || "(no name)", display, issues, values: {} as Record<string, unknown> };

    if (!name) {
      issues.push({ severity: "error", field: "name", message: "Missing required field: name." });
      return { ...base, action: "error" };
    }

    // ---- find the existing record this row refers to
    let target: ExistingCustomer | undefined;
    let by: MatchedBy | undefined;
    if (ext && byExt.has(ext)) {
      target = byExt.get(ext);
      by = "external_id";
    } else {
      const tries: [MatchedBy, ExistingCustomer | undefined][] = [
        ["phone", phone ? byPhone.get(phone.key) : undefined],
        ["email", email ? byEmail.get(email) : undefined],
        ["name_address", nameAddressKey(name, address) ? byNameAddr.get(nameAddressKey(name, address)!) : undefined],
      ];
      for (const [kind, rec] of tries) {
        if (!rec) continue;
        if (ext && rec.external_source === source && distinctByExt(ext, rec.external_id)) continue; // provably another person
        target = rec;
        by = kind;
        break;
      }
    }

    // ---- an existing record already claimed by an earlier row of this file
    if (target) {
      const prior = claimed.get(target.id);
      if (prior) {
        if (distinctByExt(ext, prior.ext)) {
          target = undefined;
          by = undefined;
        } else {
          return {
            ...base, action: "skip", matchedBy: "in_file", targetId: target.id, duplicateOfRow: prior.row,
            issues: [...issues, { severity: "info", message: `Duplicate of row ${prior.row} (same customer) — skipped.` }],
          };
        }
      }
    }

    // ---- in-file duplicates of rows that will be CREATED
    if (!target) {
      const dupOf = (entry: FileEntry | undefined, what: string): PlannedRow | null =>
        entry && !distinctByExt(ext, entry.ext)
          ? { ...base, action: "skip", matchedBy: "in_file", duplicateOfRow: entry.row, issues: [...issues, { severity: "info", message: `Duplicate of row ${entry.row} (same ${what}) — skipped.` }] }
          : null;
      const nameAddr = nameAddressKey(name, address);
      const dup =
        (ext && fileExt.has(ext) ? dupOf({ row: fileExt.get(ext)!, ext }, "customer ID") : null) ??
        (phone ? dupOf(filePhone.get(phone.key), "phone number") : null) ??
        (email ? dupOf(fileEmail.get(email), "email") : null) ??
        (nameAddr ? dupOf(fileNameAddr.get(nameAddr), "name and address") : null);
      if (dup) return dup;
    }

    // ---- phone/email that belong to a DIFFERENT customer can't be written (unique per account)
    if (phone) {
      const owner = byPhone.get(phone.key);
      const inFile = filePhone.get(phone.key);
      if ((owner && owner.id !== target?.id) || (inFile && !target)) {
        issues.push({ severity: "warning", field: "phone", message: `Phone ${phone.e164} already belongs to another customer — not copied to this record.` });
        phone = null;
      }
    }
    if (email) {
      const owner = byEmail.get(email);
      const inFile = fileEmail.get(email);
      if ((owner && owner.id !== target?.id) || (inFile && !target)) {
        issues.push({ severity: "warning", field: "email", message: `Email ${email} already belongs to another customer — not copied to this record.` });
        email = null;
      }
    }

    const register = (id?: string) => {
      const entry = { row: rowNumber, ext };
      if (ext) fileExt.set(ext, rowNumber);
      if (phone) filePhone.set(phone.key, entry);
      if (email) fileEmail.set(email, entry);
      const na = nameAddressKey(name, address);
      if (na) fileNameAddr.set(na, entry);
      if (id) claimed.set(id, entry);
    };

    // ---- UPDATE / SKIP existing
    if (target) {
      register(target.id);
      if (strategy === "skip") {
        return { ...base, action: "skip", matchedBy: by, targetId: target.id, issues: [...issues, { severity: "info", message: "Already in Vireek — left unchanged." }] };
      }
      const patch: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      const consider = (column: string, incoming: unknown, current: unknown, same: (a: unknown, b: unknown) => boolean = sameText) => {
        if (incoming === null || incoming === undefined || incoming === "") return;
        if (strategy === "fill_blanks" ? cleanText(current) !== "" : same(incoming, current)) return;
        patch[column] = incoming;
        before[column] = current ?? null;
      };
      consider("name", name, target.name);
      consider("phone", phone?.e164, target.phone, (a, b) => phoneKey(String(a)) === phoneKey(b as string | null));
      consider("email", email, target.email);
      consider("address", address, target.address);
      consider("notes", notes, target.notes);
      if (strategy === "overwrite" && customerType) consider("customer_type", customerType, target.customer_type);
      if (ext && !target.external_id) {
        patch.external_source = source;
        patch.external_id = ext;
        before.external_source = target.external_source ?? null;
        before.external_id = null;
      }
      if (Object.keys(patch).length === 0) {
        return { ...base, action: "skip", matchedBy: by, targetId: target.id, issues: [...issues, { severity: "info", message: "Already up to date — nothing to change." }] };
      }
      return { ...base, action: "update", matchedBy: by, targetId: target.id, values: patch, before };
    }

    // ---- CREATE
    register();
    return {
      ...base,
      action: "create",
      values: {
        name,
        phone: phone?.e164 ?? null,
        email: email ?? null,
        address: address || null,
        notes: notes || null,
        customer_type: customerType ?? "residential",
        lifecycle_stage: "active", // being imported means an existing customer, not a fresh lead
        source: "import",
        external_source: ext ? source : null,
        external_id: ext || null,
      },
    };
  });
}

// ======================================================================= jobs

export function requiredJobFieldsMapped(map: FieldMap): boolean {
  return Boolean(map.customer_name || map.customer_first_name || map.customer_last_name || map.customer_external_id);
}

export interface JobPlanContext {
  customers: ExistingCustomer[];
  existingJobs: ExistingJob[];
  timezone: string;
  nowMs?: number;
}

const toMinuteIso = (iso: string) => new Date(iso).toISOString().slice(0, 16);
const toCents = (v: number | string | null | undefined) => (v === null || v === undefined || v === "" ? "" : String(Math.round(Number(v) * 100)));

function jobFingerprint(name: string | null, iso: string | null, service: string | null, amount: number | string | null | undefined): string | null {
  const n = looseKey(name);
  if (!n || !iso) return null;
  return `${n}|${toMinuteIso(iso)}|${looseKey(service)}|${toCents(amount)}`;
}

export function planJobs(rows: Row[], map: FieldMap, source: string, strategy: DedupeStrategy, ctx: JobPlanContext): PlannedRow[] {
  const now = ctx.nowMs ?? Date.now();
  const custByExt = new Map<string, ExistingCustomer>();
  const custByPhone = new Map<string, ExistingCustomer>();
  const custByName = new Map<string, ExistingCustomer | null>(); // null = ambiguous (several customers share the name)
  for (const c of ctx.customers) {
    if (c.external_source === source && c.external_id) custByExt.set(c.external_id, c);
    const pk = phoneKey(c.phone);
    if (pk && !custByPhone.has(pk)) custByPhone.set(pk, c);
    const nk = looseKey(c.name);
    if (nk) custByName.set(nk, custByName.has(nk) ? null : c);
  }

  const jobByExt = new Map<string, ExistingJob>();
  const jobByFp = new Map<string, ExistingJob>();
  for (const j of ctx.existingJobs) {
    if (j.external_source === source && j.external_id) jobByExt.set(j.external_id, j);
    const fp = jobFingerprint(j.customer_name, j.scheduled_datetime, j.service_type, j.invoice_amount);
    if (fp && !jobByFp.has(fp)) jobByFp.set(fp, j);
  }

  const claimed = new Map<string, FileEntry>();
  const fileExt = new Map<string, number>();
  const fileFp = new Map<string, FileEntry>();

  return rows.map((row, i): PlannedRow => {
    const rowNumber = i + 2;
    const issues: RowIssue[] = [];

    const custExt = pick(row, map.customer_external_id);
    const rawPhone = pick(row, map.customer_phone);
    const phone = rawPhone ? normalizePhone(rawPhone) : null;
    if (rawPhone && !phone) issues.push({ severity: "warning", field: "customer_phone", message: `"${rawPhone}" isn't a valid phone number — left blank.` });

    let name = pick(row, map.customer_name) || [pick(row, map.customer_first_name), pick(row, map.customer_last_name)].filter(Boolean).join(" ");

    // ---- link to a customer already in Vireek (never blocks the row)
    let linked: ExistingCustomer | undefined;
    if (custExt) linked = custByExt.get(custExt);
    if (!linked && phone) linked = custByPhone.get(phone.key);
    if (!linked && name) linked = custByName.get(looseKey(name)) ?? undefined;
    if (!name && linked?.name) name = linked.name;

    const serviceType = pick(row, map.service_type);
    const address = joinAddress({ street: pick(row, map.address), city: pick(row, map.city), state: pick(row, map.state), zip: pick(row, map.zip) });
    const ext = pick(row, map.external_id);

    const rawDate = pick(row, map.scheduled_datetime);
    const parsedDate = parseDateTime(rawDate, ctx.timezone);
    let scheduled: string | null = null;
    if (parsedDate === undefined) issues.push({ severity: "warning", field: "scheduled_datetime", message: `Couldn't read the date "${rawDate}" — imported without a scheduled time.` });
    else if (parsedDate === null) { if (map.scheduled_datetime) issues.push({ severity: "info", field: "scheduled_datetime", message: "No date on this row — imported without a scheduled time." }); }
    else scheduled = parsedDate;

    const rawAmount = pick(row, map.invoice_amount);
    const parsedAmount = parseMoney(rawAmount);
    let amount: number | null = null;
    if (parsedAmount === undefined) issues.push({ severity: "warning", field: "invoice_amount", message: `Couldn't read the amount "${rawAmount}" — left blank.` });
    else amount = parsedAmount;

    const rawStatus = pick(row, map.job_status);
    const mappedStatus = mapJobStatus(rawStatus);
    if (mappedStatus === undefined) issues.push({ severity: "warning", field: "job_status", message: `Unrecognized job status "${rawStatus}" — imported as ${scheduled && Date.parse(scheduled) > now ? "scheduled" : "completed"}.` });
    const jobStatus = mappedStatus ?? (scheduled && Date.parse(scheduled) > now ? "scheduled" : "completed"); // history defaults to completed, future dates to scheduled

    const rawInvoice = pick(row, map.invoice_status);
    const mappedInvoice = mapInvoiceStatus(rawInvoice);
    if (mappedInvoice === undefined) issues.push({ severity: "warning", field: "invoice_status", message: `Unrecognized invoice status "${rawInvoice}" — inferred from the job instead.` });
    const invoiceStatus = mappedInvoice ?? (jobStatus === "completed" && amount !== null && amount > 0 ? "paid" : "not_sent");

    if (!linked && (name || custExt) && (map.customer_phone || map.customer_external_id)) {
      issues.push({ severity: "info", message: "No matching customer in Vireek — imported as an unlinked job. Import customers first to link them." });
    }

    const display = {
      customer: name, service: serviceType, date: scheduled ?? "", amount: amount === null ? "" : String(amount),
    };
    const base = { rowNumber, label: name || "(no customer)", display, issues, values: {} as Record<string, unknown> };

    if (!name) {
      issues.push({ severity: "error", field: "customer_name", message: "Missing required field: customer name." });
      return { ...base, action: "error" };
    }

    // ---- match an existing job
    let target: ExistingJob | undefined;
    let by: MatchedBy | undefined;
    const fp = jobFingerprint(name, scheduled, serviceType, amount);
    if (ext && jobByExt.has(ext)) {
      target = jobByExt.get(ext);
      by = "external_id";
    } else if (fp && jobByFp.has(fp)) {
      const rec = jobByFp.get(fp)!;
      if (!(ext && rec.external_source === source && distinctByExt(ext, rec.external_id))) {
        target = rec;
        by = "fingerprint";
      }
    }

    if (target) {
      const prior = claimed.get(target.id);
      if (prior) {
        if (distinctByExt(ext, prior.ext)) { target = undefined; by = undefined; }
        else return { ...base, action: "skip", matchedBy: "in_file", targetId: target.id, duplicateOfRow: prior.row, issues: [...issues, { severity: "info", message: `Duplicate of row ${prior.row} (same job) — skipped.` }] };
      }
    }

    if (!target) {
      const sameExtRow = ext ? fileExt.get(ext) : undefined;
      const fpEntry = fp ? fileFp.get(fp) : undefined;
      if (sameExtRow) return { ...base, action: "skip", matchedBy: "in_file", duplicateOfRow: sameExtRow, issues: [...issues, { severity: "info", message: `Duplicate of row ${sameExtRow} (same job ID) — skipped.` }] };
      if (fpEntry && !distinctByExt(ext, fpEntry.ext)) return { ...base, action: "skip", matchedBy: "in_file", duplicateOfRow: fpEntry.row, issues: [...issues, { severity: "info", message: `Duplicate of row ${fpEntry.row} (same customer, time, service and amount) — skipped.` }] };
    }

    const register = (id?: string) => {
      const entry = { row: rowNumber, ext };
      if (ext) fileExt.set(ext, rowNumber);
      if (fp) fileFp.set(fp, entry);
      if (id) claimed.set(id, entry);
    };

    if (target) {
      register(target.id);
      if (strategy === "skip") return { ...base, action: "skip", matchedBy: by, targetId: target.id, issues: [...issues, { severity: "info", message: "Job already in Vireek — left unchanged." }] };

      const patch: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      const consider = (column: string, incoming: unknown, current: unknown, same: (a: unknown, b: unknown) => boolean = sameText) => {
        if (incoming === null || incoming === undefined || incoming === "") return;
        if (strategy === "fill_blanks" ? cleanText(current) !== "" : same(incoming, current)) return;
        patch[column] = incoming;
        before[column] = current ?? null;
      };
      consider("customer_name", name, target.customer_name);
      consider("customer_id", linked?.id, target.customer_id, (a, b) => a === b);
      consider("customer_phone", phone?.e164, target.customer_phone, (a, b) => phoneKey(String(a)) === phoneKey(b as string | null));
      consider("service_type", serviceType, target.service_type);
      consider("address", address, target.address);
      consider("scheduled_datetime", scheduled, target.scheduled_datetime, (a, b) => !!b && Date.parse(String(a)) === Date.parse(String(b)));
      consider("invoice_amount", amount, target.invoice_amount, (a, b) => Number(a) === Number(b));
      if (strategy === "overwrite") {
        if (mappedStatus) consider("job_status", mappedStatus, target.job_status);
        if (mappedInvoice) consider("invoice_status", mappedInvoice, target.invoice_status);
      }
      if (ext && !target.external_id) {
        patch.external_source = source;
        patch.external_id = ext;
        before.external_source = target.external_source ?? null;
        before.external_id = null;
      }
      if (Object.keys(patch).length === 0) return { ...base, action: "skip", matchedBy: by, targetId: target.id, issues: [...issues, { severity: "info", message: "Already up to date — nothing to change." }] };
      return { ...base, action: "update", matchedBy: by, targetId: target.id, values: patch, before };
    }

    register();
    return {
      ...base,
      action: "create",
      values: {
        customer_id: linked?.id ?? null,
        customer_name: name,
        customer_phone: phone?.e164 ?? linked?.phone ?? null,
        service_type: serviceType || null,
        address: address || null,
        scheduled_datetime: scheduled,
        job_status: jobStatus,
        invoice_amount: amount,
        invoice_status: invoiceStatus,
        external_source: ext ? source : null,
        external_id: ext || null,
      },
    };
  });
}
