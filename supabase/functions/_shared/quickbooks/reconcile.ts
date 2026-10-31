// supabase/functions/_shared/quickbooks/reconcile.ts
//
// Read-only reconciliation audit between Vireek AR invoices (imported incumbent invoices first) and
// QuickBooks Online invoices. PURE and deterministic: no network, no database, no clock, no LLM.
// Imported by the qbo-sync-run edge function, the React client (CSV export) and the unit tests.
//
// Rules
//   1. Money is integer cents. Every "dollars at stake" figure is an integer computed from the two records.
//   2. Nothing here writes anywhere. Findings are suggestions for a human; no action voids or edits anything.
//   3. Anything that cannot be compared faithfully (unparseable QuickBooks invoice, unlinked customer)
//      is SKIPPED with a reason and reported, never guessed.
//   4. One QuickBooks invoice plays exactly one role: matched, duplicate, or missing-in-Vireek.
//   5. An invoice with payments (on either side) is flagged `hasPayments`: its suggested action never
//      mentions voiding or re-itemising, and its severity is raised one level.

import { parseQboInvoice, toCents, type BillToRule, type QboInvoiceDoc, type RawRecord } from './engine.ts';

export const RECON_BUCKETS = [
  'missing_in_qbo',
  'missing_in_fsm',
  'amount_mismatch',
  'duplicate_in_qbo',
  'modified_after_export',
  'deposit_credit_mismatch',
  'tax_mismatch',
  'bill_to_mismatch',
] as const;
export type ReconBucket = (typeof RECON_BUCKETS)[number];
export type ReconSeverity = 'low' | 'medium' | 'high' | 'critical';

export const BUCKET_LABEL: Record<ReconBucket, string> = {
  missing_in_qbo: 'Missing in QuickBooks',
  missing_in_fsm: 'Missing in Vireek',
  amount_mismatch: 'Amount mismatch',
  duplicate_in_qbo: 'Duplicate in QuickBooks',
  modified_after_export: 'Modified after export',
  deposit_credit_mismatch: 'Deposit / credit memo mismatch',
  tax_mismatch: 'Tax mismatch',
  bill_to_mismatch: 'Bill-to mismatch',
};

export const DEFAULT_TAX_TOLERANCE_CENTS = 1;
export const DEFAULT_DATE_WINDOW_DAYS = 7;

export interface ReconVireekInvoice {
  id: string;
  invoiceNumber: string;
  customerId: string | null;
  customerName: string | null;
  /** QuickBooks customer id this invoice's customer is linked to (qbo_record_links), null when unlinked. */
  qboCustomerId: string | null;
  status: 'draft' | 'sent' | 'partially_paid' | 'paid' | 'overdue' | 'void';
  issueDate: string; // YYYY-MM-DD
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  amountPaidCents: number;
  /** Sum of issued (non-void) credit memos tied to this invoice. */
  creditMemoCents: number;
  sourceSystem: string | null;
  sourceId: string | null;
  billToRole: 'owner' | 'tenant' | null;
  customerTaxExempt: boolean;
  link: { externalId: string; baseAmounts: string | null } | null;
}

export interface ReconQboInvoice {
  doc: QboInvoiceDoc;
  customerName: string | null;
  depositCents: number;
  linkedCreditMemo: boolean;
}

export interface ReconSettings {
  taxToleranceCents: number;
  dateWindowDays: number;
  billToRule: BillToRule;
}

export interface ReconFinding {
  fingerprint: string;
  bucket: ReconBucket;
  severity: ReconSeverity;
  centsAtStake: number;
  vireekId: string | null;
  qboId: string | null;
  hasPayments: boolean;
  evidence: { vireek: Record<string, unknown> | null; qbo: Record<string, unknown> | null; detail: Record<string, unknown> };
  evidenceSig: string;
  suggestedAction: string;
}

export interface ReconSkip {
  qboId: string | null;
  vireekId: string | null;
  reason: string;
}

export interface ReconSummary {
  matched: { count: number; cents: number };
  buckets: Record<ReconBucket, { count: number; cents: number }>;
  totalFindings: number;
  totalCentsAtStake: number;
  skipped: ReconSkip[];
}

export interface ReconResult {
  findings: ReconFinding[];
  summary: ReconSummary;
}

// ---------------------------------------------------------------- parsing --

const obj = (v: unknown): RawRecord => (v && typeof v === 'object' ? (v as RawRecord) : {});

export function toReconQbo(raw: RawRecord): { ok: true; inv: ReconQboInvoice } | { ok: false; id: string | null; reason: string } {
  const p = parseQboInvoice(raw);
  const id = raw.Id === undefined || raw.Id === null ? null : String(raw.Id);
  if (!p.ok) return { ok: false, id, reason: p.reason };
  const linked = Array.isArray(raw.LinkedTxn) ? (raw.LinkedTxn as RawRecord[]) : [];
  const name = obj(raw.CustomerRef).name;
  return {
    ok: true,
    inv: {
      doc: p.doc,
      customerName: typeof name === 'string' && name.trim() ? name.trim() : null,
      depositCents: toCents(raw.Deposit ?? 0),
      linkedCreditMemo: linked.some((t) => String(obj(t).TxnType) === 'CreditMemo'),
    },
  };
}

/** `invoiceAmountSig` starts with "<total>|<tax>|". Returns null for anything else (never guesses). */
export function parseBaseAmounts(sig: unknown): { totalCents: number; taxCents: number } | null {
  if (typeof sig !== 'string') return null;
  const m = /^(-?\d+)\|(-?\d+)\|/.exec(sig);
  return m ? { totalCents: Number(m[1]), taxCents: Number(m[2]) } : null;
}

// ---------------------------------------------------------------- helpers --

const normDoc = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();
const idOrder = (a: string, b: string) => (a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0);

function dayDiff(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const x = Date.parse(`${a}T00:00:00Z`);
  const y = Date.parse(`${b}T00:00:00Z`);
  return Number.isNaN(x) || Number.isNaN(y) ? null : Math.abs(Math.round((x - y) / 86_400_000));
}

export function severityFor(stakeCents: number, hasPayments: boolean): ReconSeverity {
  const order: ReconSeverity[] = ['low', 'medium', 'high', 'critical'];
  let i = stakeCents >= 100_000 ? 2 : stakeCents >= 10_000 ? 1 : 0;
  if (hasPayments) i = Math.min(3, i + 1);
  return order[i];
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

function actionFor(bucket: ReconBucket, hasPayments: boolean, d: Record<string, unknown>): string {
  const payNote = hasPayments ? ' This invoice has payments: do not void or re-itemise it on either side.' : '';
  switch (bucket) {
    case 'missing_in_qbo':
      return 'Confirm the invoice was never exported (check the QuickBooks recycle/void list and the sync log), then run a sync or create it in QuickBooks.';
    case 'missing_in_fsm':
      return 'Check whether this QuickBooks invoice belongs to an imported job. If it does, link it to the Vireek invoice; if not, record it as QuickBooks-only.';
    case 'duplicate_in_qbo':
      return `Keep the invoice that carries payments or the Vireek link and review the extra copy in QuickBooks.${hasPayments ? ' Do not void a copy that has payments.' : ' An accountant should void or delete it in QuickBooks; Vireek never does this automatically.'}`;
    case 'amount_mismatch':
      return `Compare line items on both records and correct the wrong side in its own system.${payNote}`;
    case 'modified_after_export':
      return `One side was edited after the last sync (${String(d.changedSide)}). Resolve it with "Keep Vireek / Keep QuickBooks" under Conflicts if listed, otherwise correct the stale side.${payNote}`;
    case 'deposit_credit_mismatch':
      return `Compare payments, deposits and credit memos on both invoices (${String(d.kind)}) and record the missing one on the side that lacks it.${payNote}`;
    case 'tax_mismatch':
      return d.exemptCustomerTaxed
        ? `The customer has a verified tax exemption but the invoice carries tax. Check the exemption certificate and tax code in both systems.${payNote}`
        : `Check the tax code and tax-exempt setting on the QuickBooks invoice against the Vireek tax snapshot.${payNote}`;
    case 'bill_to_mismatch':
      return `Confirm who should be billed (owner or tenant) and fix the customer on the wrong side.${payNote}`;
  }
}

function vSnap(v: ReconVireekInvoice): Record<string, unknown> {
  return {
    id: v.id,
    invoice_number: v.invoiceNumber,
    customer: v.customerName,
    status: v.status,
    issue_date: v.issueDate,
    subtotal_cents: v.subtotalCents,
    tax_cents: v.taxCents,
    total_cents: v.totalCents,
    amount_paid_cents: v.amountPaidCents,
    credit_memo_cents: v.creditMemoCents,
    source: v.sourceSystem ? `${v.sourceSystem}:${v.sourceId ?? ''}` : null,
    bill_to_role: v.billToRole,
  };
}
function qSnap(q: ReconQboInvoice): Record<string, unknown> {
  const d = q.doc;
  return {
    id: d.id,
    doc_number: d.docNumber,
    customer: q.customerName,
    customer_id: d.customerId,
    txn_date: d.txnDate,
    subtotal_cents: d.subtotalCents,
    tax_cents: d.taxCents,
    total_cents: d.totalCents,
    balance_cents: d.balanceCents,
    deposit_cents: q.depositCents,
    voided: d.voided,
    credit_memo_linked: q.linkedCreditMemo,
  };
}

// ------------------------------------------------------------------- core --

export interface ReconInput {
  vireek: ReconVireekInvoice[];
  qbo: ReconQboInvoice[];
  settings: ReconSettings;
  /** Only QuickBooks invoices on/after this date can be "missing in Vireek". Null = skip that bucket. */
  fromDate: string | null;
  /** Invoices QuickBooks returned that could not be parsed (reported as skipped). */
  unparsed?: { id: string | null; reason: string }[];
}

export function reconcileInvoices(input: ReconInput): ReconResult {
  const { settings } = input;
  const findings: ReconFinding[] = [];
  const skipped: ReconSkip[] = (input.unparsed ?? []).map((u) => ({ qboId: u.id, vireekId: null, reason: u.reason }));
  const qboById = new Map(input.qbo.map((q) => [q.doc.id, q]));
  const claimed = new Set<string>();
  const pairs = new Map<string, { v: ReconVireekInvoice; primary: ReconQboInvoice; matchedBy: string }>();
  const extras: { v: ReconVireekInvoice | null; q: ReconQboInvoice }[] = [];

  const vList = [...input.vireek].filter((v) => v.status !== 'draft').sort((a, b) => a.id.localeCompare(b.id));

  // Phase 1: stored links are authoritative.
  for (const v of vList) {
    const q = v.link ? qboById.get(v.link.externalId) : undefined;
    if (q && !claimed.has(q.doc.id)) {
      claimed.add(q.doc.id);
      pairs.set(v.id, { v, primary: q, matchedBy: 'link' });
    }
  }
  // Phase 2: document number (invoice number, or the incumbent's source id).
  const byDoc = new Map<string, ReconQboInvoice[]>();
  for (const q of input.qbo) {
    const k = normDoc(q.doc.docNumber);
    if (k) byDoc.set(k, [...(byDoc.get(k) ?? []), q]);
  }
  for (const v of vList) {
    const keys = [normDoc(v.invoiceNumber), normDoc(v.sourceId)].filter(Boolean);
    const cands = new Map<string, ReconQboInvoice>();
    for (const k of keys) for (const q of byDoc.get(k) ?? []) if (!claimed.has(q.doc.id)) cands.set(q.doc.id, q);
    const list = [...cands.values()].sort((a, b) => Number(a.doc.voided) - Number(b.doc.voided) || idOrder(a.doc.id, b.doc.id));
    const existing = pairs.get(v.id);
    if (!existing && list.length) {
      const [first, ...rest] = list;
      claimed.add(first.doc.id);
      pairs.set(v.id, { v, primary: first, matchedBy: 'doc_number' });
      for (const r of rest) {
        claimed.add(r.doc.id);
        extras.push({ v, q: r });
      }
    } else if (existing) {
      for (const r of list) {
        claimed.add(r.doc.id);
        extras.push({ v, q: r });
      }
    }
  }
  // Phase 3: heuristic (same known customer + same total + date inside the window). Never when a number exists.
  for (const v of vList) {
    if (pairs.has(v.id) || !v.qboCustomerId || v.status === 'void') continue;
    const cands = input.qbo
      .filter((q) => !claimed.has(q.doc.id) && !q.doc.voided && q.doc.customerId === v.qboCustomerId && q.doc.totalCents === v.totalCents)
      .filter((q) => {
        const dd = dayDiff(q.doc.txnDate, v.issueDate);
        return dd !== null && dd <= settings.dateWindowDays;
      })
      .sort((a, b) => (dayDiff(a.doc.txnDate, v.issueDate) ?? 0) - (dayDiff(b.doc.txnDate, v.issueDate) ?? 0) || idOrder(a.doc.id, b.doc.id));
    if (cands.length === 1) {
      claimed.add(cands[0].doc.id);
      pairs.set(v.id, { v, primary: cands[0], matchedBy: 'customer_amount_date' });
    } else if (cands.length > 1) {
      skipped.push({ qboId: null, vireekId: v.id, reason: `Ambiguous: ${cands.length} QuickBooks invoices share the customer, total and date window. Not matched automatically.` });
    }
  }

  const push = (
    bucket: ReconBucket,
    stake: number,
    v: ReconVireekInvoice | null,
    q: ReconQboInvoice | null,
    hasPayments: boolean,
    detail: Record<string, unknown>,
  ) => {
    const cents = Math.abs(Math.round(stake));
    findings.push({
      fingerprint: `${bucket}|${v?.id ?? '-'}|${q?.doc.id ?? '-'}`,
      bucket,
      severity: severityFor(cents, hasPayments),
      centsAtStake: cents,
      vireekId: v?.id ?? null,
      qboId: q?.doc.id ?? null,
      hasPayments,
      evidence: { vireek: v ? vSnap(v) : null, qbo: q ? qSnap(q) : null, detail },
      evidenceSig: `${bucket}|${cents}|${JSON.stringify(detail)}`,
      suggestedAction: actionFor(bucket, hasPayments, detail),
    });
  };

  // Duplicates among already-matched documents.
  for (const { v, q } of extras) {
    if (q.doc.voided) continue;
    const paid = q.doc.totalCents - q.doc.balanceCents > 0 || (v?.amountPaidCents ?? 0) > 0;
    push('duplicate_in_qbo', q.doc.totalCents, v, q, paid, { reason: 'Several QuickBooks invoices share this document number.' });
  }

  // Matched pairs.
  let matchedCount = 0;
  let matchedCents = 0;
  for (const { v, primary: q, matchedBy } of [...pairs.values()].sort((a, b) => a.v.id.localeCompare(b.v.id))) {
    const before = findings.length;
    const d = q.doc;
    const qApplied = Math.max(d.totalCents - d.balanceCents, 0);
    const hasPayments = v.amountPaidCents > 0 || qApplied > 0;
    const base = { matchedBy };

    if (v.status === 'void' || d.voided) {
      if (v.status === 'void' && !d.voided) push('amount_mismatch', d.totalCents, v, q, hasPayments, { ...base, reason: 'Voided in Vireek but active in QuickBooks.' });
      else if (v.status !== 'void' && d.voided && v.totalCents > 0) push('amount_mismatch', v.totalCents, v, q, hasPayments, { ...base, reason: 'Voided in QuickBooks but active in Vireek.' });
    } else {
      const subDiff = v.subtotalCents - d.subtotalCents;
      const taxDiff = v.taxCents - d.taxCents;
      const taxOff = Math.abs(taxDiff) > settings.taxToleranceCents;
      if (subDiff !== 0 || taxOff) {
        const b = parseBaseAmounts(v.link?.baseAmounts);
        const vChanged = b ? v.totalCents !== b.totalCents || v.taxCents !== b.taxCents : false;
        const qChanged = b ? d.totalCents !== b.totalCents || d.taxCents !== b.taxCents : false;
        if (b && vChanged !== qChanged) {
          push('modified_after_export', v.totalCents - d.totalCents, v, q, hasPayments, { ...base, changedSide: vChanged ? 'edited in Vireek after export' : 'edited in QuickBooks after export' });
        } else {
          if (subDiff !== 0) push('amount_mismatch', subDiff, v, q, hasPayments, { ...base, subtotalDiffCents: subDiff });
          if (taxOff) {
            const exemptCustomerTaxed = v.customerTaxExempt && (v.taxCents > 0 || d.taxCents > 0);
            push('tax_mismatch', taxDiff, v, q, hasPayments, { ...base, taxDiffCents: taxDiff, exemptCustomerTaxed });
          }
        }
      } else if (v.customerTaxExempt && (v.taxCents > 0 || d.taxCents > 0)) {
        push('tax_mismatch', Math.max(v.taxCents, d.taxCents), v, q, hasPayments, { ...base, taxDiffCents: taxDiff, exemptCustomerTaxed: true });
      }

      // Deposits / credit memos / applied amounts.
      const kind = q.depositCents > 0 ? 'deposit' : q.linkedCreditMemo || v.creditMemoCents > 0 ? 'credit_memo' : 'payment';
      if (qApplied !== v.amountPaidCents) {
        push('deposit_credit_mismatch', qApplied - v.amountPaidCents, v, q, hasPayments, { ...base, kind, qboAppliedCents: qApplied, vireekPaidCents: v.amountPaidCents });
      } else if (v.creditMemoCents > 0 && !q.linkedCreditMemo) {
        push('deposit_credit_mismatch', v.creditMemoCents, v, q, hasPayments, { ...base, kind: 'credit_memo', reason: 'Credit memo exists in Vireek but is not linked in QuickBooks.', creditMemoCents: v.creditMemoCents });
      }

      // Bill-to.
      if (!v.qboCustomerId) {
        skipped.push({ qboId: d.id, vireekId: v.id, reason: 'Customer is not linked to QuickBooks; bill-to not compared.' });
      } else if (d.customerId !== v.qboCustomerId) {
        push('bill_to_mismatch', d.totalCents, v, q, hasPayments, { ...base, expectedQboCustomerId: v.qboCustomerId, actualQboCustomerId: d.customerId, reason: 'QuickBooks bills a different customer than Vireek.' });
      } else if (settings.billToRule !== 'invoice_customer' && v.billToRole && v.billToRole !== settings.billToRule) {
        push('bill_to_mismatch', v.totalCents, v, q, hasPayments, { ...base, rule: settings.billToRule, billToRole: v.billToRole, reason: 'Invoice is billed to a different party than the configured bill-to rule.' });
      }
    }
    if (findings.length === before) {
      matchedCount += 1;
      matchedCents += v.totalCents;
    }
  }

  // Vireek invoices with no QuickBooks counterpart (imported ones only).
  for (const v of vList) {
    if (pairs.has(v.id) || !v.sourceSystem || v.status === 'void') continue;
    if (v.totalCents <= 0) continue;
    push('missing_in_qbo', v.totalCents, v, null, v.amountPaidCents > 0, { reason: 'No QuickBooks invoice matches by link, document number, or customer + amount + date.' });
  }

  // QuickBooks invoices with no Vireek counterpart.
  if (input.fromDate) {
    const loose = input.qbo
      .filter((q) => !claimed.has(q.doc.id) && !q.doc.voided && q.doc.txnDate !== null && q.doc.txnDate >= input.fromDate!)
      .sort((a, b) => idOrder(a.doc.id, b.doc.id));
    const seen = new Set<string>();
    for (const q of loose) {
      const k = normDoc(q.doc.docNumber);
      const paid = q.doc.totalCents - q.doc.balanceCents > 0;
      if (k && seen.has(k)) push('duplicate_in_qbo', q.doc.totalCents, null, q, paid, { reason: 'Several QuickBooks invoices share this document number.' });
      else {
        if (k) seen.add(k);
        push('missing_in_fsm', q.doc.totalCents, null, q, paid, { reason: 'No Vireek invoice matches by link, document number, or customer + amount + date.' });
      }
    }
  }

  findings.sort((a, b) => RECON_BUCKETS.indexOf(a.bucket) - RECON_BUCKETS.indexOf(b.bucket) || a.fingerprint.localeCompare(b.fingerprint));

  const buckets = Object.fromEntries(RECON_BUCKETS.map((b) => [b, { count: 0, cents: 0 }])) as ReconSummary['buckets'];
  for (const f of findings) {
    buckets[f.bucket].count += 1;
    buckets[f.bucket].cents += f.centsAtStake;
  }
  return {
    findings,
    summary: {
      matched: { count: matchedCount, cents: matchedCents },
      buckets,
      totalFindings: findings.length,
      totalCentsAtStake: findings.reduce((s, f) => s + f.centsAtStake, 0),
      skipped,
    },
  };
}

// -------------------------------------------------------------------- CSV --

/** RFC 4180 quoting plus spreadsheet formula-injection protection (cells starting = + - @ get a leading quote). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface CsvFindingRow {
  bucket: ReconBucket;
  severity: ReconSeverity;
  cents_at_stake: number;
  status: string;
  has_payments: boolean;
  suggested_action: string;
  resolution_note: string | null;
  evidence: { vireek: Record<string, unknown> | null; qbo: Record<string, unknown> | null };
}

export function findingsToCsv(rows: CsvFindingRow[]): string {
  const head = ['Bucket', 'Severity', 'Dollars at stake', 'Status', 'Has payments', 'Vireek invoice', 'QuickBooks doc #', 'Customer', 'Suggested action', 'Resolution note'];
  const lines = [head.map(csvCell).join(',')];
  for (const r of rows) {
    const v = r.evidence.vireek;
    const q = r.evidence.qbo;
    lines.push(
      [
        BUCKET_LABEL[r.bucket],
        r.severity,
        (r.cents_at_stake / 100).toFixed(2),
        r.status,
        r.has_payments ? 'yes' : 'no',
        v?.invoice_number ?? '',
        q?.doc_number ?? '',
        v?.customer ?? q?.customer ?? '',
        r.suggested_action,
        r.resolution_note ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}
