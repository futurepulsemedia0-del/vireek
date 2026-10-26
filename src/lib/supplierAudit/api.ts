/** Supabase access for the Supplier Entitlement Audit. All writes to findings / packets / recoveries go through RPCs. */
import { supabase } from '@/lib/supabase';
import { readImportFile, fileKind } from '@/lib/importFile';
import { runAudit, resolveProgram } from './engine';
import { mapTable, sha256Hex, type DateOrder } from './parse';
import { normName } from './money';
import type {
  AuditInput, CreditMemo, Program, StatementLine, StatementMeta, VendorBillLite, WarrantyClaimLite, FindingStatus, EvidenceRef, ConfidenceBand, DeadlineRisk, FindingType,
} from './types';
import type { BankTxnLite } from './reconcile';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fail = (e: { message: string } | null) => { if (e) throw new Error(e.message); };
const PAGE = 1000;

async function fetchAll(table: string, select: string, order = 'created_at'): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(table).select(select).order(order, { ascending: true }).range(from, from + PAGE - 1);
    fail(error);
    out.push(...((data as Row[] | null) ?? []));
    if (!data || data.length < PAGE) break;
    if (from > 50_000) break;
  }
  return out;
}

export interface FindingRecord {
  id: string; dedupe_key: string; finding_type: FindingType; kind: string | null; vendor_id: string; program_id: string | null; warranty_claim_id: string | null;
  title: string; summary: string; low_cents: number; likely_cents: number; high_cents: number; currency: string; confidence: number; confidence_band: ConfidenceBand;
  deadline: string | null; deadline_risk: DeadlineRisk; is_opportunity: boolean; evidence: EvidenceRef[]; how_calculated: string[]; warnings: string[];
  status: FindingStatus; dismiss_reason: string | null; recovered_cents: number; first_seen_at: string; last_seen_at: string; label: 'estimate';
}
export interface PacketRecord { id: string; finding_id: string; status: 'draft' | 'approved' | 'marked_sent' | 'cancelled'; draft_message: string; checklist: unknown; approved_at: string | null; approved_by: string | null; sent_marked_at: string | null; created_at: string }
export interface RecoveryRecord { id: string; finding_id: string; amount_cents: number; currency: string; source: string; evidence_label: string | null; received_on: string; capped: boolean; confirmed_at: string }
export interface VendorRef { id: string; name: string; tier: string | null }
export interface LogRecord { id: string; actor_email: string | null; action: string; entity_type: string; created_at: string; detail: Record<string, unknown> }
export interface ProgramRow {
  id: string; vendor_id: string; name: string; program_type: Program['type']; status: Program['status']; period_start: string | null; period_end: string | null; currency: string;
  rules: Record<string, unknown>; rules_override: Record<string, unknown>; enrollment_status: Program['enrollment']; claim_deadline: string | null;
  required_documents: string[]; documents_on_file: string[]; source_url: string | null; last_verified_at: string | null; notes: string | null;
}
export interface StatementRow { id: string; vendor_id: string; period_start: string; period_end: string; currency: string; source_kind: string; source_file_name: string | null; parse_status: string; parse_error: string | null; line_count: number; created_at: string }
export interface LineRow { id: string; statement_id: string; line_no: number; invoice_no: string | null; invoice_date: string | null; sku: string | null; description: string | null; qty: number | null; unit_price_cents: number | null; extended_cents: number | null; is_credit: boolean; currency: string; confidence: number; review_status: StatementLine['reviewStatus']; review_note: string | null }
export interface MemoRow { id: string; vendor_id: string; memo_no: string | null; memo_date: string | null; amount_cents: number; applied_cents: number; currency: string; reason: CreditMemo['reason']; applied_status: CreditMemo['appliedStatus']; invoice_no: string | null; program_id: string | null; warranty_claim_id: string | null; confidence: number; needs_review: boolean; notes: string | null }

export interface AuditData {
  ownerId: string; vendors: VendorRef[]; programRows: ProgramRow[]; programs: Program[]; statements: StatementRow[]; lineRows: LineRow[]; memos: MemoRow[];
  findings: FindingRecord[]; packets: PacketRecord[]; recoveries: RecoveryRecord[]; log: LogRecord[]; input: Omit<AuditInput, 'now' | 'timeZone'>;
}

export async function getOwnerId(): Promise<string> {
  const { data, error } = await supabase.rpc('get_account_owner_id'); fail(error);
  if (!data) throw new Error('Could not resolve your account.');
  return data as string;
}

export async function loadAuditData(): Promise<AuditData> {
  const ownerId = await getOwnerId();
  const [vendors, programRows, statements, lineRows, memos, findings, packets, recoveries, log, claims, bills] = await Promise.all([
    fetchAll('vendors', 'id, name, tier', 'name'),
    fetchAll('supplier_programs', '*'),
    fetchAll('supplier_statements', '*'),
    fetchAll('supplier_statement_lines', 'id, statement_id, line_no, invoice_no, invoice_date, sku, description, qty, unit_price_cents, extended_cents, is_credit, currency, confidence, review_status, review_note', 'statement_id'),
    fetchAll('supplier_credit_memos', '*'),
    fetchAll('supplier_audit_findings', '*'),
    fetchAll('supplier_claim_packets', 'id, finding_id, status, draft_message, checklist, approved_at, approved_by, sent_marked_at, created_at'),
    fetchAll('supplier_recoveries', 'id, finding_id, amount_cents, currency, source, evidence_label, received_on, capped, confirmed_at'),
    supabase.from('supplier_audit_log').select('id, actor_email, action, entity_type, created_at, detail').order('created_at', { ascending: false }).limit(200).then((r) => { fail(r.error); return (r.data as Row[]) ?? []; }),
    fetchAll('warranty_claims', 'id, status, customer_name, manufacturer, distributor, part_description, submitted_at, claim_deadline, claimed_amount_cents, approved_amount_cents, credit_received_cents'),
    fetchAll('vendor_bills', 'id, vendor_name, bill_number, amount_cents, bill_date, status', 'bill_date'),
  ]);

  const byName = new Map<string, string>();
  (vendors as VendorRef[]).forEach((v) => byName.set(normName(v.name), v.id));
  const vendorIdFor = (...names: (string | null | undefined)[]): string | null => {
    for (const n of names) { const k = normName(n); if (k && byName.has(k)) return byName.get(k)!; }
    return null;
  };
  const programsEff = (programRows as ProgramRow[]).map((r) => resolveProgram(r));
  const stMeta: StatementMeta[] = (statements as StatementRow[]).map((s) => ({ id: s.id, vendorId: s.vendor_id, periodStart: s.period_start, periodEnd: s.period_end, currency: s.currency, parseStatus: s.parse_status, fileName: s.source_file_name }));
  const lines: StatementLine[] = (lineRows as LineRow[]).map((l) => ({ id: l.id, statementId: l.statement_id, lineNo: l.line_no, invoiceNo: l.invoice_no, invoiceDate: l.invoice_date, sku: l.sku, description: l.description, qty: l.qty === null ? null : Number(l.qty), unitPriceCents: l.unit_price_cents === null ? null : Number(l.unit_price_cents), extendedCents: l.extended_cents === null ? null : Number(l.extended_cents), isCredit: l.is_credit, currency: l.currency, confidence: Number(l.confidence), reviewStatus: l.review_status }));
  const creditMemos: CreditMemo[] = (memos as MemoRow[]).map((m) => ({ id: m.id, vendorId: m.vendor_id, memoNo: m.memo_no, memoDate: m.memo_date, amountCents: Number(m.amount_cents), appliedCents: Number(m.applied_cents), currency: m.currency, reason: m.reason, appliedStatus: m.applied_status, invoiceNo: m.invoice_no, programId: m.program_id, warrantyClaimId: m.warranty_claim_id, confidence: Number(m.confidence), needsReview: m.needs_review }));
  const warrantyClaims: WarrantyClaimLite[] = (claims as Row[]).map((c) => ({
    id: c.id, vendorId: vendorIdFor(c.distributor, c.manufacturer), label: `${c.customer_name || 'Customer'} – ${c.part_description || 'warranty claim'}`, status: c.status,
    submittedAt: c.submitted_at ? String(c.submitted_at).slice(0, 10) : null, claimDeadline: c.claim_deadline, claimedCents: c.claimed_amount_cents, approvedCents: c.approved_amount_cents, creditReceivedCents: c.credit_received_cents,
  }));
  const vendorBills: VendorBillLite[] = (bills as Row[]).map((b) => ({ id: b.id, vendorId: vendorIdFor(b.vendor_name), billNumber: b.bill_number, amountCents: Number(b.amount_cents), billDate: b.bill_date, status: b.status }));

  return {
    ownerId, vendors: vendors as VendorRef[], programRows: programRows as ProgramRow[], programs: programsEff, statements: statements as StatementRow[], lineRows: lineRows as LineRow[], memos: memos as MemoRow[],
    findings: findings as FindingRecord[], packets: packets as PacketRecord[], recoveries: recoveries as RecoveryRecord[], log: log as LogRecord[],
    input: { vendors: (vendors as VendorRef[]).map((v) => ({ id: v.id, name: v.name })), programs: programsEff, statements: stMeta, lines, creditMemos, warrantyClaims, vendorBills },
  };
}

export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** Pure engine run -> idempotent RPC upsert -> auto-measure warranty credits that arrived after the finding. */
export async function runAuditNow(data: AuditData): Promise<{ inserted: number; updated: number; unchanged: number; superseded: number; warrantyRecovered: number; total: number }> {
  const findings = runAudit({ ...data.input, now: new Date(), timeZone: browserTimeZone() });
  const payload = findings.map((f) => ({
    dedupe_key: f.dedupeKey, finding_type: f.type, kind: f.kind, vendor_id: f.vendorId, program_id: f.programId, warranty_claim_id: f.warrantyClaimId,
    title: f.title, summary: f.summary, low_cents: f.lowCents, likely_cents: f.likelyCents, high_cents: f.highCents, currency: f.currency, confidence: f.confidence,
    confidence_band: f.confidenceBand, deadline: f.deadline, deadline_risk: f.deadlineRisk, is_opportunity: f.isOpportunity, evidence: f.evidence, how_calculated: f.howCalculated, warnings: f.warnings, fingerprint: f.fingerprint,
  }));
  const { data: res, error } = await supabase.rpc('sa_upsert_findings', { p_findings: payload, p_complete: true }); fail(error);
  const { data: n, error: e2 } = await supabase.rpc('sa_sync_warranty_recoveries'); fail(e2);
  const r = res as { inserted: number; updated: number; unchanged: number; superseded: number };
  return { ...r, warrantyRecovered: Number(n ?? 0), total: findings.length };
}

// ------------------------------------------------------------------ statements
export interface UploadParams { file: File; vendorId: string; periodStart: string; periodEnd: string; currency: string; dateOrder: DateOrder }

export async function uploadStatement(p: UploadParams, ownerId: string): Promise<{ statementId: string; lines: number; needsReview: number; duplicate: boolean }> {
  const { data: u } = await supabase.auth.getUser();
  const uid = u.user?.id; if (!uid) throw new Error('Not signed in.');
  const buf = await p.file.arrayBuffer();
  const hash = await sha256Hex(buf);
  const existing = await supabase.from('supplier_statements').select('id').eq('user_id', ownerId).eq('file_sha256', hash).maybeSingle(); fail(existing.error);
  if (existing.data) return { statementId: existing.data.id as string, lines: 0, needsReview: 0, duplicate: true };

  const kind = fileKind(p.file.name);
  const isPdf = /\.pdf$/i.test(p.file.name) || p.file.type === 'application/pdf';
  const sourceKind = isPdf ? 'pdf' : kind === 'xlsx' ? 'xlsx' : 'csv';
  if (!isPdf && !kind) throw new Error('Upload a .pdf, .csv or .xlsx file.');
  const path = `${ownerId}/${uid}/${hash.slice(0, 16)}-${p.file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)}`;
  const up = await supabase.storage.from('supplier-statements').upload(path, p.file, { upsert: false, contentType: p.file.type || undefined });
  if (up.error && !/exists/i.test(up.error.message)) throw new Error(up.error.message);

  const ins = await supabase.from('supplier_statements').insert({
    user_id: ownerId, vendor_id: p.vendorId, period_start: p.periodStart, period_end: p.periodEnd, currency: p.currency, source_kind: sourceKind,
    source_file_path: path, source_file_name: p.file.name.slice(0, 300), file_sha256: hash, parse_status: 'pending',
  }).select('id').single(); fail(ins.error);
  const statementId = ins.data!.id as string;

  try {
    type L = { lineNo: number; invoiceNo: string | null; invoiceDate: string | null; sku: string | null; description: string | null; qty: number | null; unitPriceCents: number | null; extendedCents: number | null; isCredit: boolean; confidence: number; fieldConfidence: Record<string, number>; reviewStatus: string };
    let parsed: L[];
    if (isPdf) {
      const { data, error } = await supabase.functions.invoke('supplier-statement-parse', { body: { path } });
      if (error || !data?.ok) throw new Error((data as { error?: string } | null)?.error ?? error?.message ?? 'The statement could not be read.');
      parsed = data.lines as L[];
    } else {
      const table = await readImportFile(p.file);
      const m = mapTable(table.headers, table.rows, { dateOrder: p.dateOrder });
      if (m.missing.length) throw new Error(`Could not find a ${m.missing.map((x) => (x === 'extended' ? 'amount' : 'date')).join(' or ')} column. Rename the header (e.g. "Amount", "Date") and upload again.`);
      parsed = m.lines;
    }
    if (!parsed.length) throw new Error('No statement lines were found in this file.');
    for (let i = 0; i < parsed.length; i += 400) {
      const chunk = parsed.slice(i, i + 400).map((l, j) => ({
        user_id: ownerId, statement_id: statementId, line_no: i + j + 1, invoice_no: l.invoiceNo, invoice_date: l.invoiceDate, sku: l.sku, description: l.description,
        qty: l.qty, unit_price_cents: l.unitPriceCents, extended_cents: l.extendedCents, is_credit: l.isCredit, currency: p.currency, confidence: l.confidence,
        field_confidence: l.fieldConfidence, review_status: l.reviewStatus,
      }));
      const r = await supabase.from('supplier_statement_lines').insert(chunk); fail(r.error);
    }
    const review = parsed.filter((l) => l.reviewStatus !== 'auto_accepted').length;
    await supabase.from('supplier_statements').update({ parse_status: review ? 'needs_review' : 'parsed', line_count: parsed.length, parse_error: null }).eq('id', statementId);
    return { statementId, lines: parsed.length, needsReview: review, duplicate: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Parsing failed';
    await supabase.from('supplier_statements').update({ parse_status: 'failed', parse_error: msg.slice(0, 500) }).eq('id', statementId);
    throw e;
  }
}

export async function updateLine(id: string, patch: Partial<{ invoice_no: string | null; invoice_date: string | null; sku: string | null; qty: number | null; unit_price_cents: number | null; extended_cents: number | null; is_credit: boolean; review_status: StatementLine['reviewStatus']; review_note: string | null }>): Promise<void> {
  const { data: u } = await supabase.auth.getUser();
  const { error } = await supabase.from('supplier_statement_lines').update({ ...patch, reviewed_by: u.user?.id ?? null, reviewed_at: new Date().toISOString() }).eq('id', id); fail(error);
}
export async function deleteStatement(id: string): Promise<void> { const { error } = await supabase.from('supplier_statements').delete().eq('id', id); fail(error); }
export async function refreshStatementStatus(statementId: string): Promise<void> {
  const { count } = await supabase.from('supplier_statement_lines').select('id', { count: 'exact', head: true }).eq('statement_id', statementId).eq('review_status', 'needs_review');
  await supabase.from('supplier_statements').update({ parse_status: (count ?? 0) > 0 ? 'needs_review' : 'reviewed' }).eq('id', statementId);
}

// ------------------------------------------------------------------ programs & memos
export async function saveProgram(ownerId: string, row: Partial<ProgramRow> & { vendor_id: string; name: string; program_type: Program['type'] }): Promise<void> {
  const { id, ...rest } = row;
  const res = id ? await supabase.from('supplier_programs').update(rest).eq('id', id) : await supabase.from('supplier_programs').insert({ ...rest, user_id: ownerId });
  fail(res.error);
}
export async function deleteProgram(id: string): Promise<void> { const { error } = await supabase.from('supplier_programs').delete().eq('id', id); fail(error); }
export async function saveMemo(ownerId: string, row: Partial<MemoRow> & { vendor_id: string; amount_cents: number }): Promise<void> {
  const { id, ...rest } = row;
  const res = id ? await supabase.from('supplier_credit_memos').update(rest).eq('id', id) : await supabase.from('supplier_credit_memos').insert({ ...rest, user_id: ownerId });
  fail(res.error);
}
export async function deleteMemo(id: string): Promise<void> { const { error } = await supabase.from('supplier_credit_memos').delete().eq('id', id); fail(error); }

// ------------------------------------------------------------------ finding workflow (RPCs)
export const dismissFinding = async (id: string, reason: string) => fail((await supabase.rpc('sa_dismiss_finding', { p_finding: id, p_reason: reason })).error);
export const reopenFinding = async (id: string) => fail((await supabase.rpc('sa_reopen_finding', { p_finding: id })).error);
export async function savePacket(findingId: string, message: string, checklist: unknown, snapshot: unknown): Promise<string> {
  const { data, error } = await supabase.rpc('sa_save_packet', { p_finding: findingId, p_message: message, p_checklist: checklist, p_snapshot: snapshot }); fail(error); return data as string;
}
export const approvePacket = async (id: string) => fail((await supabase.rpc('sa_approve_packet', { p_packet: id })).error);
export const markPacketSent = async (id: string, note: string) => fail((await supabase.rpc('sa_mark_packet_sent', { p_packet: id, p_note: note || null })).error);
export async function confirmRecovery(findingId: string, source: 'bank_deposit' | 'warranty_credit' | 'credit_applied', evidenceId: string) {
  const { data, error } = await supabase.rpc('sa_confirm_recovery', { p_finding: findingId, p_source: source, p_evidence_id: evidenceId }); fail(error);
  return data as { amount_cents: number; capped: boolean; recovered_cents: number; status: string };
}

/** Candidate deposits for the confirmation loop (money in only, last 18 months). Columns are normalised across bank schema variants. */
export async function loadBankDeposits(): Promise<BankTxnLite[]> {
  const since = new Date(Date.now() - 548 * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await supabase.from('bank_transactions').select('*').gt('amount_cents', 0).gte('posted_date', since).order('posted_date', { ascending: false }).limit(1500);
  if (error) return [];
  return ((data as Row[]) ?? []).map((t) => ({ id: t.id, postedDate: t.posted_date, amountCents: Number(t.amount_cents), description: String(t.description ?? t.name ?? ''), merchantName: t.merchant_name ?? null }));
}

/** Thin interface to the money-recovered ledger: measured supplier recoveries only (value_events does not exist in this schema). */
export interface MeasuredRecovery { id: string; findingId: string; vendorId: string; amountCents: number; currency: string; source: string; receivedOn: string; confirmedAt: string }
export async function listMeasuredRecoveries(from?: string, to?: string): Promise<MeasuredRecovery[]> {
  let q = supabase.from('supplier_recovery_ledger_v').select('id, finding_id, vendor_id, amount_cents, currency, source, received_on, confirmed_at').order('received_on', { ascending: false }).limit(1000);
  if (from) q = q.gte('received_on', from); if (to) q = q.lte('received_on', to);
  const { data, error } = await q; fail(error);
  return ((data as Row[]) ?? []).map((r) => ({ id: r.id, findingId: r.finding_id, vendorId: r.vendor_id, amountCents: Number(r.amount_cents), currency: r.currency, source: r.source, receivedOn: r.received_on, confirmedAt: r.confirmed_at }));
}
