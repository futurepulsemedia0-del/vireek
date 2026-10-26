/**
 * Supplier Entitlement Audit — findings engine (PURE: no I/O, no clock, no randomness).
 *
 * Conservative by construction:
 *  - Lines below the confidence threshold (and not human-confirmed) are NEVER used in any number;
 *    they are only counted so the UI can say "N lines awaiting review were not counted".
 *  - Eligibility is never promised. Unknown enrollment or a stale program rule forces low = 0.
 *  - Every finding is labelled "estimate". Only a confirmed receipt (ledger) is ever "recovered".
 */
import {
  type AuditInput, type AuditSettings, type ConfidenceBand, type CreditMemo, type DeadlineRisk, type EvidenceRef,
  type Finding, type FindingType, type Program, type StatementLine, type StatementMeta, type WarrantyClaimLite,
  DEFAULT_SETTINGS,
} from './types';
import {
  addMonths, daysBetween, hashString, isYmd, mulBps, normInvoiceNo, normName, roundCents, todayInZone,
} from './money';

export const LIKELY_OWED_WORDING = 'Likely owed — verify with your distributor';

// ---------------------------------------------------------------- helpers
export function confidenceBand(c: number): ConfidenceBand {
  return c >= 0.75 ? 'high' : c >= 0.5 ? 'medium' : 'low';
}
const clamp01 = (n: number) => Math.min(1, Math.max(0, Math.round(n * 1000) / 1000));

export function deadlineRisk(today: string, deadline: string | null): DeadlineRisk {
  if (!deadline || !isYmd(deadline)) return 'none';
  const d = daysBetween(today, deadline);
  if (d < 0) return 'expired';
  if (d <= 7) return 'critical';
  if (d <= 30) return 'soon';
  return 'ok';
}

/** Program rule freshness: warn when last_verified_at is missing or older than N months. */
export function programFreshness(p: Pick<Program, 'lastVerifiedAt'>, today: string, months = 12): { stale: boolean; message: string | null } {
  if (!p.lastVerifiedAt || !isYmd(p.lastVerifiedAt)) return { stale: true, message: 'Program rules have never been verified against the source.' };
  if (addMonths(p.lastVerifiedAt, months) < today) {
    return { stale: true, message: `Program rules were last verified ${p.lastVerifiedAt} (more than ${months} months ago) — re-check the source before claiming.` };
  }
  return { stale: false, message: null };
}

type LineState = 'accepted' | 'pending' | 'rejected';
export function lineState(l: StatementLine, minConfidence: number): LineState {
  if (l.reviewStatus === 'rejected') return 'rejected';
  if (l.reviewStatus === 'confirmed') return 'accepted';
  return l.confidence >= minConfidence && l.reviewStatus === 'auto_accepted' ? 'accepted' : 'pending';
}

function usable(l: StatementLine): boolean {
  return l.extendedCents !== null && l.extendedCents >= 0;
}

function lineEvidence(l: StatementLine, st: Map<string, StatementMeta>): EvidenceRef {
  const s = st.get(l.statementId);
  return {
    kind: 'statement_line', id: l.id,
    label: `${l.invoiceNo ?? 'no invoice #'} · ${l.sku ?? l.description ?? 'item'}${s ? ` (statement ${s.periodStart}–${s.periodEnd})` : ''}`,
    amountCents: l.extendedCents ?? undefined,
  };
}

function build(
  f: Omit<Finding, 'confidenceBand' | 'fingerprint' | 'label' | 'warrantyClaimId'> & { warrantyClaimId?: string | null },
): Finding {
  // enforce low <= likely <= high and non-negative integers
  const low = Math.max(0, roundCents(f.lowCents));
  const likely = Math.max(low, roundCents(f.likelyCents));
  const high = Math.max(likely, roundCents(f.highCents));
  const confidence = clamp01(f.confidence);
  const base = { ...f, lowCents: low, likelyCents: likely, highCents: high, confidence, warrantyClaimId: f.warrantyClaimId ?? null };
  const fingerprint = hashString(JSON.stringify([
    base.type, base.kind, low, likely, high, confidence, base.deadline, base.isOpportunity,
    base.evidence.map((e) => [e.kind, e.id, e.amountCents ?? null]), base.warnings,
  ]));
  return { ...base, confidenceBand: confidenceBand(confidence), fingerprint, label: 'estimate' };
}

// ---------------------------------------------------------------- program rule resolution
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Merges `rules` with the per-account `rules_override` and validates; invalid parts are dropped with a warning. */
export function resolveProgram(row: {
  id: string; vendor_id: string; name: string; program_type: Program['type']; status: Program['status'];
  period_start: string | null; period_end: string | null; currency: string; rules: unknown; rules_override: unknown;
  enrollment_status: Program['enrollment']; claim_deadline: string | null; required_documents: string[] | null;
  documents_on_file: string[] | null; source_url: string | null; last_verified_at: string | null;
}): Program {
  const warnings: string[] = [];
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const r = { ...obj(row.rules), ...obj(row.rules_override) };

  const tiers = (Array.isArray(r.tiers) ? r.tiers : [])
    .map((t) => ({ thresholdCents: Math.round(num((t as Record<string, unknown>)?.threshold_cents, NaN)), rateBps: Math.round(num((t as Record<string, unknown>)?.rate_bps, NaN)) }))
    .filter((t) => Number.isFinite(t.thresholdCents) && t.thresholdCents >= 0 && Number.isFinite(t.rateBps) && t.rateBps > 0 && t.rateBps <= 10000)
    .sort((a, b) => a.thresholdCents - b.thresholdCents);
  if (Array.isArray(r.tiers) && tiers.length !== r.tiers.length) warnings.push('Some tier rows were ignored because they were invalid.');

  const priceSchedule = (Array.isArray(r.price_schedule) ? r.price_schedule : [])
    .map((p) => ({ sku: String((p as Record<string, unknown>)?.sku ?? '').trim().toUpperCase(), unitPriceCents: Math.round(num((p as Record<string, unknown>)?.unit_price_cents, NaN)) }))
    .filter((p) => p.sku && Number.isFinite(p.unitPriceCents) && p.unitPriceCents >= 0);
  if (Array.isArray(r.price_schedule) && priceSchedule.length !== r.price_schedule.length) warnings.push('Some price-schedule rows were ignored because they were invalid.');

  return {
    id: row.id, vendorId: row.vendor_id, name: row.name, type: row.program_type, status: row.status,
    periodStart: row.period_start, periodEnd: row.period_end, currency: row.currency,
    enrollment: row.enrollment_status, claimDeadline: row.claim_deadline,
    requiredDocuments: row.required_documents ?? [], documentsOnFile: row.documents_on_file ?? [],
    sourceUrl: row.source_url, lastVerifiedAt: row.last_verified_at,
    tiers, tierMode: r.tier_mode === 'marginal' ? 'marginal' : 'retroactive_all',
    priceSchedule,
    toleranceBps: Math.max(0, Math.round(num(r.tolerance_bps, 0))),
    toleranceCents: Math.max(0, Math.round(num(r.tolerance_cents, 0))),
    coopAccrualBps: Math.max(0, Math.round(num(r.coop_accrual_bps, 0))),
    coopCapCents: r.coop_cap_cents === null || r.coop_cap_cents === undefined ? null : Math.max(0, Math.round(num(r.coop_cap_cents, 0))),
    warnings,
  };
}

// ---------------------------------------------------------------- invoices & spend
interface InvoiceGroup { key: string; invoiceNo: string; vendorId: string; date: string | null; statementId: string; lines: StatementLine[] }

/** One invoice appearing on several statements (open-item carry-over) is counted ONCE: newest statement wins. */
export function groupInvoices(lines: StatementLine[], statements: Map<string, StatementMeta>): InvoiceGroup[] {
  const best = new Map<string, InvoiceGroup>();
  const byStatement = new Map<string, Map<string, StatementLine[]>>();
  for (const l of lines) {
    const n = normInvoiceNo(l.invoiceNo);
    if (!n) continue;
    const s = statements.get(l.statementId);
    if (!s) continue;
    const vk = `${s.vendorId}|${n}`;
    const sm = byStatement.get(vk) ?? new Map<string, StatementLine[]>();
    sm.set(l.statementId, [...(sm.get(l.statementId) ?? []), l]);
    byStatement.set(vk, sm);
  }
  for (const [vk, sm] of byStatement) {
    let pick: string | null = null;
    for (const sid of sm.keys()) {
      const a = statements.get(sid)!; const b = pick ? statements.get(pick)! : null;
      if (!b || a.periodEnd > b.periodEnd || (a.periodEnd === b.periodEnd && sid > pick!)) pick = sid;
    }
    const ls = sm.get(pick!)!;
    const s = statements.get(pick!)!;
    best.set(vk, { key: vk, invoiceNo: ls[0].invoiceNo ?? '', vendorId: s.vendorId, date: ls.map((x) => x.invoiceDate).find(Boolean) ?? null, statementId: pick!, lines: ls });
  }
  return [...best.values()].sort((a, b) => a.key.localeCompare(b.key));
}

interface SpendResult {
  acceptedCents: number; pendingCents: number; pendingLines: number; undatedLines: number; foreignCurrencyLines: number;
  source: 'statements' | 'vendor_bills' | 'none'; evidence: EvidenceRef[]; lineCount: number;
}

function spendFor(p: Program, input: AuditInput, st: Map<string, StatementMeta>, s: AuditSettings): SpendResult {
  const inPeriod = (d: string | null) => !!d && (!p.periodStart || d >= p.periodStart) && (!p.periodEnd || d <= p.periodEnd);
  const vendorLines = input.lines.filter((l) => st.get(l.statementId)?.vendorId === p.vendorId);
  let accepted = 0; let pending = 0; let pendingLines = 0; let undated = 0; let foreign = 0; let n = 0;
  const ev: EvidenceRef[] = [];
  for (const g of groupInvoices(vendorLines, st)) {
    for (const l of g.lines) {
      const state = lineState(l, s.minConfidence);
      if (state === 'rejected') continue;
      const date = l.invoiceDate ?? g.date;
      if (!date) { undated++; continue; }
      if (!inPeriod(date)) continue;
      if (l.currency !== p.currency) { foreign++; continue; }
      if (!usable(l)) { pendingLines++; continue; }
      const signed = (l.isCredit ? -1 : 1) * (l.extendedCents as number);
      if (state === 'accepted') { accepted += signed; n++; if (ev.length < 25) ev.push(lineEvidence(l, st)); }
      else { pending += signed; pendingLines++; }
    }
  }
  if (n > 0) return { acceptedCents: Math.max(0, accepted), pendingCents: pending, pendingLines, undatedLines: undated, foreignCurrencyLines: foreign, source: 'statements', evidence: ev, lineCount: n };
  // Fallback: AP bills (totals only). Lower confidence, never mixed with statement lines.
  const bills = input.vendorBills.filter((b) => b.vendorId === p.vendorId && inPeriod(b.billDate));
  if (bills.length) {
    const seen = new Set<string>(); let total = 0; const bev: EvidenceRef[] = [];
    for (const b of bills) {
      const k = `${normInvoiceNo(b.billNumber)}|${b.amountCents}`;
      if (b.billNumber && seen.has(k)) continue; // a duplicate AP entry must not inflate spend
      seen.add(k); total += b.amountCents;
      if (bev.length < 25) bev.push({ kind: 'vendor_bill', id: b.id, label: `Bill ${b.billNumber ?? '(no #)'} · ${b.billDate}`, amountCents: b.amountCents });
    }
    return { acceptedCents: total, pendingCents: pending, pendingLines, undatedLines: undated, foreignCurrencyLines: foreign, source: 'vendor_bills', evidence: bev, lineCount: bills.length };
  }
  return { acceptedCents: 0, pendingCents: pending, pendingLines, undatedLines: undated, foreignCurrencyLines: foreign, source: 'none', evidence: [], lineCount: 0 };
}

// ---------------------------------------------------------------- tiers
export function tierIndexFor(tiers: Program['tiers'], spendCents: number): number {
  let idx = -1;
  tiers.forEach((t, i) => { if (spendCents >= t.thresholdCents) idx = i; });
  return idx;
}

/** Rebate for `spend` under the program's tier mode. retroactive_all: top tier rate on ALL spend. marginal: each band at its own rate. */
export function rebateFor(p: Pick<Program, 'tiers' | 'tierMode'>, spendCents: number): number {
  if (spendCents <= 0 || !p.tiers.length) return 0;
  const idx = tierIndexFor(p.tiers, spendCents);
  if (idx < 0) return 0;
  if (p.tierMode === 'retroactive_all') return mulBps(spendCents, p.tiers[idx].rateBps);
  let total = 0;
  for (let i = 0; i <= idx; i++) {
    const upper = i < idx ? p.tiers[i + 1].thresholdCents : spendCents;
    const band = Math.max(0, upper - p.tiers[i].thresholdCents);
    total += mulBps(band, p.tiers[i].rateBps);
  }
  return total;
}

function receivedFor(p: Program, input: AuditInput, reasons: CreditMemo['reason'][]): { cents: number; evidence: EvidenceRef[] } {
  let cents = 0; const evidence: EvidenceRef[] = [];
  for (const m of input.creditMemos) {
    if (m.vendorId !== p.vendorId || m.appliedStatus === 'void' || m.currency !== p.currency) continue;
    const linked = m.programId === p.id || (m.programId === null && reasons.includes(m.reason));
    if (!linked) continue;
    const got = m.appliedStatus === 'applied' ? m.amountCents : m.appliedCents;
    if (got > 0) { cents += got; evidence.push({ kind: 'credit_memo', id: m.id, label: `Credit memo ${m.memoNo ?? ''} already received`, amountCents: got }); }
  }
  return { cents, evidence };
}

function programGate(p: Program, input: AuditInput, today: string, s: AuditSettings): { confPenalty: number; zeroLow: boolean; warnings: string[] } {
  const warnings = [...p.warnings]; let confPenalty = 0; let zeroLow = false;
  if (p.enrollment === 'unknown') { confPenalty += 0.25; zeroLow = true; warnings.push('Enrollment in this program is unconfirmed — eligibility is not verified.'); }
  const fresh = programFreshness(p, today, s.staleVerificationMonths);
  if (fresh.stale && fresh.message) { confPenalty += 0.2; zeroLow = true; warnings.push(fresh.message); }
  return { confPenalty, zeroLow, warnings };
}

function detectTiers(input: AuditInput, today: string, s: AuditSettings, st: Map<string, StatementMeta>, vendorName: (id: string) => string): Finding[] {
  const out: Finding[] = [];
  for (const p of input.programs) {
    if (p.status !== 'active' || (p.type !== 'volume_rebate' && p.type !== 'patronage') || !p.tiers.length || !p.periodStart || !p.periodEnd) continue;
    if (p.enrollment === 'not_enrolled') continue;
    const sp = spendFor(p, input, st, s);
    if (sp.source === 'none') continue;
    const gate = programGate(p, input, today, s);
    const warnings = [...gate.warnings];
    if (sp.pendingLines) warnings.push(`${sp.pendingLines} statement line(s) awaiting review were NOT counted.`);
    if (sp.undatedLines) warnings.push(`${sp.undatedLines} line(s) without an invoice date were NOT counted.`);
    if (sp.foreignCurrencyLines) warnings.push(`${sp.foreignCurrencyLines} line(s) in another currency were NOT counted.`);
    let confidence = 0.9 - gate.confPenalty;
    if (sp.source === 'vendor_bills') { confidence -= 0.2; warnings.push('Spend comes from AP bill totals (no statement lines) — upload statements for a firmer number.'); }
    if (sp.pendingLines) confidence -= 0.1;

    const S = sp.acceptedCents;
    const idx = tierIndexFor(p.tiers, S);
    const expected = rebateFor(p, S);
    const recv = receivedFor(p, input, ['rebate', 'patronage']);
    const owed = Math.max(0, expected - recv.cents);
    const ended = today > p.periodEnd;
    const deadline = p.claimDeadline;
    const risk = deadlineRisk(today, deadline);
    const how = [
      `Qualifying spend in ${p.periodStart} → ${p.periodEnd}: ${S} cents (${sp.source === 'statements' ? 'accepted statement lines' : 'AP bill totals'}, duplicates counted once, credits netted).`,
      idx >= 0 ? `Highest tier reached: ${p.tiers[idx].rateBps / 100}% at ≥ ${p.tiers[idx].thresholdCents} cents (${p.tierMode === 'retroactive_all' ? 'rate applies to all spend' : 'each band at its own rate'}).` : 'No tier threshold reached yet.',
      `Expected rebate ${expected} cents − already received ${recv.cents} cents = ${owed} cents.`,
    ];
    const evidence = [...sp.evidence.slice(0, 15), ...recv.evidence, { kind: 'program', id: p.id, label: p.name } as EvidenceRef];
    const pendingUpper = Math.max(0, S + Math.max(0, sp.pendingCents));
    const highOwed = Math.max(owed, Math.max(0, rebateFor(p, pendingUpper) - recv.cents));
    const lowOwed = gate.zeroLow || sp.source !== 'statements' ? 0 : owed;

    if (idx >= 0 && owed > 0 && ended && deadlineRisk(today, deadline) !== 'expired') {
      out.push(build({
        dedupeKey: `rebate_owed:${p.id}:${p.periodEnd}`, type: 'rebate_owed',
        kind: recv.cents > 0 ? 'retroactive_tier' : 'likely_qualifies',
        vendorId: p.vendorId, programId: p.id,
        title: `${vendorName(p.vendorId)}: ${p.type === 'patronage' ? 'patronage' : 'volume rebate'} ${recv.cents > 0 ? 'shortfall' : 'likely owed'} (${p.name})`,
        summary: `${LIKELY_OWED_WORDING}. Spend reached the ${p.tiers[idx].rateBps / 100}% tier${recv.cents > 0 ? ', but the rebate received is lower than that tier implies' : ' and no rebate credit was found'}.`,
        lowCents: lowOwed, likelyCents: owed, highCents: highOwed, currency: p.currency, confidence,
        deadline, deadlineRisk: risk, isOpportunity: false, evidence, howCalculated: how, warnings,
      }));
    } else if (idx >= 0 && owed > 0 && !ended) {
      out.push(build({
        dedupeKey: `rebate_accruing:${p.id}:${p.periodEnd}`, type: 'rebate_accruing', kind: 'in_period',
        vendorId: p.vendorId, programId: p.id,
        title: `${vendorName(p.vendorId)}: rebate accruing (${p.name})`,
        summary: `Accrued so far under the current tier — payable only after the period ends (${p.periodEnd}). Not claimable yet.`,
        lowCents: 0, likelyCents: owed, highCents: highOwed, currency: p.currency, confidence,
        deadline, deadlineRisk: risk, isOpportunity: true, evidence, howCalculated: how, warnings,
      }));
    }

    const next = idx + 1 < p.tiers.length ? p.tiers[idx + 1] : null;
    if (next && !ended && today >= p.periodStart) {
      const gap = next.thresholdCents - S;
      const daysLeft = daysBetween(today, p.periodEnd);
      const elapsed = Math.max(1, daysBetween(p.periodStart, today) + 1);
      const totalDays = daysBetween(p.periodStart, p.periodEnd) + 1;
      const projected = roundCents((S / elapsed) * totalDays);
      const atNext = rebateFor(p, next.thresholdCents);
      const gain = Math.max(0, atNext - expected);
      out.push(build({
        dedupeKey: `tier_gap:${p.id}:${next.thresholdCents}`, type: 'tier_gap', kind: 'spend_to_next_tier',
        vendorId: p.vendorId, programId: p.id,
        title: `${vendorName(p.vendorId)}: ${gap} cents of qualifying spend to reach the ${next.rateBps / 100}% tier`,
        summary: `${daysLeft} day(s) left in the period. This is a planning opportunity, not money owed — only counts if you would buy this anyway.`,
        lowCents: 0, likelyCents: gain, highCents: gain, currency: p.currency, confidence: Math.min(confidence, 0.7),
        deadline: p.periodEnd, deadlineRisk: deadlineRisk(today, p.periodEnd), isOpportunity: true,
        evidence: [{ kind: 'program', id: p.id, label: p.name }],
        howCalculated: [...how.slice(0, 2), `Next tier at ${next.thresholdCents} cents; gap ${gap} cents; ${daysLeft} days left.`, `Run-rate projection by period end: ${projected} cents (${projected >= next.thresholdCents ? 'on pace' : 'below pace'}) — a projection, not a promise.`],
        warnings,
      }));
    }
  }
  return out;
}

// ---------------------------------------------------------------- price deviations
function detectPrices(input: AuditInput, today: string, s: AuditSettings, st: Map<string, StatementMeta>, vendorName: (id: string) => string): Finding[] {
  const out: Finding[] = [];
  for (const p of input.programs) {
    if (p.status !== 'active' || p.type !== 'price_agreement' || !p.priceSchedule.length) continue;
    if (p.enrollment === 'not_enrolled') continue;
    const sched = new Map(p.priceSchedule.map((x) => [x.sku, x.unitPriceCents]));
    const gate = programGate(p, input, today, s);
    const vendorLines = input.lines.filter((l) => st.get(l.statementId)?.vendorId === p.vendorId);
    const byInvoice = new Map<string, { inv: string; over: { l: StatementLine; cents: number; state: LineState }[]; credits: Map<string, number> }>();
    for (const g of groupInvoices(vendorLines, st)) {
      for (const l of g.lines) {
        const date = l.invoiceDate ?? g.date;
        if (!date || (p.periodStart && date < p.periodStart) || (p.periodEnd && date > p.periodEnd) || l.currency !== p.currency) continue;
        const sku = (l.sku ?? '').trim().toUpperCase();
        const agreed = sched.get(sku);
        const entry: { inv: string; over: { l: StatementLine; cents: number; state: LineState }[]; credits: Map<string, number> } = byInvoice.get(g.key) ?? { inv: g.invoiceNo, over: [], credits: new Map<string, number>() };
        byInvoice.set(g.key, entry);
        if (l.isCredit) { if (sku && l.extendedCents !== null && lineState(l, s.minConfidence) !== 'rejected') entry.credits.set(sku, (entry.credits.get(sku) ?? 0) + l.extendedCents); continue; }
        if (agreed === undefined || l.unitPriceCents === null || l.qty === null || l.qty <= 0) continue;
        const state = lineState(l, s.minConfidence);
        if (state === 'rejected') continue;
        const tol = Math.max(p.toleranceCents, mulBps(agreed, p.toleranceBps));
        const diff = l.unitPriceCents - agreed;
        if (diff <= tol) continue;
        entry.over.push({ l, cents: roundCents(diff * l.qty), state });
      }
    }
    for (const [, e] of [...byInvoice].sort((a, b) => a[0].localeCompare(b[0]))) {
      let accepted = 0; let pending = 0; let pendingN = 0; const ev: EvidenceRef[] = [];
      for (const o of e.over) {
        const credit = o.l.sku ? e.credits.get(o.l.sku.trim().toUpperCase()) ?? 0 : 0;
        const net = Math.max(0, o.cents - credit);
        if (net === 0) continue;
        if (o.state === 'accepted') { accepted += net; ev.push({ ...lineEvidence(o.l, st), detail: `billed ${o.l.unitPriceCents} vs agreed ${sched.get((o.l.sku ?? '').trim().toUpperCase())} per unit × ${o.l.qty}` }); }
        else { pending += net; pendingN++; }
      }
      if (accepted === 0 && pending === 0) continue;
      const warnings = [...gate.warnings];
      if (pendingN) warnings.push(`${pendingN} overcharged line(s) are awaiting review and were NOT counted in the likely amount.`);
      const sure = e.over.filter((o) => o.state === 'accepted' && o.l.confidence >= 0.95 && o.l.reviewStatus !== 'needs_review').length === ev.length && ev.length > 0;
      out.push(build({
        dedupeKey: `price_deviation:${p.id}:${normInvoiceNo(e.inv)}`, type: 'price_deviation', kind: 'above_agreed_price',
        vendorId: p.vendorId, programId: p.id,
        title: `${vendorName(p.vendorId)}: invoice ${e.inv} billed above the agreed price`,
        summary: `${LIKELY_OWED_WORDING}. Unit prices exceeded the pricing agreement "${p.name}" beyond its tolerance.`,
        lowCents: gate.zeroLow || !sure ? 0 : accepted, likelyCents: accepted, highCents: accepted + pending,
        currency: p.currency, confidence: (accepted > 0 ? 0.88 : 0.5) - gate.confPenalty - (pendingN ? 0.1 : 0),
        deadline: p.claimDeadline, deadlineRisk: deadlineRisk(today, p.claimDeadline), isOpportunity: false,
        evidence: [...ev.slice(0, 20), { kind: 'program', id: p.id, label: p.name }],
        howCalculated: [
          `For each accepted line with an agreed price: (billed unit price − agreed unit price) × quantity, only when the difference exceeds the tolerance (max of ${p.toleranceCents} cents or ${p.toleranceBps / 100}% of the agreed price).`,
          'Credit lines for the same invoice and SKU are subtracted. Lines awaiting review are excluded.',
          `Accepted overcharge ${accepted} cents; awaiting review ${pending} cents (upper bound only).`,
        ],
        warnings,
      }));
    }
  }
  return out;
}

// ---------------------------------------------------------------- unapplied credits
function detectCredits(input: AuditInput, today: string, s: AuditSettings, vendorName: (id: string) => string): Finding[] {
  const out: Finding[] = [];
  for (const m of input.creditMemos) {
    if (m.appliedStatus === 'void' || m.appliedStatus === 'applied') continue;
    const remaining = m.amountCents - m.appliedCents;
    if (remaining <= 0) continue;
    const age = m.memoDate && isYmd(m.memoDate) ? daysBetween(m.memoDate, today) : null;
    const late = age !== null && age >= s.creditGraceDays;
    const warnings: string[] = [];
    if (m.needsReview || m.confidence < s.minConfidence) warnings.push('This credit memo was read with low confidence — confirm the amount before claiming.');
    if (age === null) warnings.push('The memo has no date, so its age is unknown.');
    const sure = !m.needsReview && m.confidence >= s.minConfidence;
    out.push(build({
      dedupeKey: `unapplied_credit:${m.id}`, type: 'unapplied_credit', kind: m.appliedStatus,
      vendorId: m.vendorId, programId: m.programId, warrantyClaimId: m.warrantyClaimId,
      title: `${vendorName(m.vendorId)}: credit memo ${m.memoNo ?? '(no #)'} not fully applied`,
      summary: `A credit was issued but ${m.appliedCents > 0 ? 'only partly ' : 'not '}applied to your account${age !== null ? ` (${age} days ago)` : ''}. ${LIKELY_OWED_WORDING}.`,
      lowCents: late && sure ? remaining : 0, likelyCents: sure ? remaining : 0, highCents: remaining,
      currency: m.currency, confidence: sure ? (late ? 0.9 : 0.75) : 0.45,
      deadline: null, deadlineRisk: 'none', isOpportunity: false,
      evidence: [{ kind: 'credit_memo', id: m.id, label: `Credit memo ${m.memoNo ?? ''} ${m.memoDate ?? ''}`, amountCents: remaining }],
      howCalculated: [`Memo amount ${m.amountCents} − applied ${m.appliedCents} = ${remaining} cents unapplied.`, `Grace period ${s.creditGraceDays} days: ${late ? 'passed' : 'not yet passed (low = 0)'} .`],
      warnings,
    }));
  }
  return out;
}

// ---------------------------------------------------------------- warranty
function detectWarranty(input: AuditInput, today: string, s: AuditSettings, vendorName: (id: string) => string, fallbackVendor: string | null): Finding[] {
  const out: Finding[] = [];
  const memoByClaim = new Map<string, number>();
  for (const m of input.creditMemos) {
    if (m.warrantyClaimId && m.appliedStatus !== 'void') memoByClaim.set(m.warrantyClaimId, (memoByClaim.get(m.warrantyClaimId) ?? 0) + m.amountCents);
  }
  for (const c of input.warrantyClaims) {
    const vendorId = c.vendorId ?? fallbackVendor;
    if (!vendorId) continue;
    const received = (c.creditReceivedCents ?? 0) + (memoByClaim.get(c.id) ?? 0);
    const risk = deadlineRisk(today, c.claimDeadline);
    const ev: EvidenceRef[] = [{ kind: 'warranty_claim', id: c.id, label: c.label }];
    if (c.status === 'approved' || c.status === 'submitted') {
      if (!c.submittedAt || !isYmd(c.submittedAt)) continue;
      const age = daysBetween(c.submittedAt, today);
      if (age < s.warrantyGraceDays || received > 0) continue;
      const approved = c.status === 'approved' && c.approvedCents && c.approvedCents > 0 ? c.approvedCents : 0;
      const claimed = c.claimedCents ?? 0;
      if (approved === 0 && claimed === 0) continue;
      out.push(build({
        dedupeKey: `warranty_credit_missing:${c.id}`, type: 'warranty_credit_missing', kind: c.status,
        vendorId, programId: null, warrantyClaimId: c.id,
        title: `${vendorName(vendorId)}: no warranty credit ${age} days after ${c.status === 'approved' ? 'approval' : 'submission'} (${c.label})`,
        summary: `${c.status === 'approved' ? 'The claim is approved' : 'The claim was submitted'} but no credit has been recorded. ${LIKELY_OWED_WORDING}.`,
        lowCents: approved, likelyCents: approved, highCents: approved || claimed, currency: 'USD',
        confidence: approved ? 0.8 : 0.45, deadline: c.claimDeadline, deadlineRisk: risk, isOpportunity: false, evidence: ev,
        howCalculated: [`Status "${c.status}", submitted ${c.submittedAt} (${age} days ago ≥ ${s.warrantyGraceDays}-day grace).`, approved ? `Approved amount ${approved} cents; no credit received.` : `Only submitted (claimed ${claimed} cents): not yet counted in low/likely — approval is not assured.`],
        warnings: approved ? [] : ['Not approved yet — follow up on the claim status first.'],
      }));
    } else if (c.status === 'credit_received' && c.approvedCents && c.approvedCents > 0) {
      const short = c.approvedCents - received;
      if (short <= 0) continue;
      out.push(build({
        dedupeKey: `warranty_credit_short:${c.id}`, type: 'warranty_credit_short', kind: 'partial_credit',
        vendorId, programId: null, warrantyClaimId: c.id,
        title: `${vendorName(vendorId)}: warranty credit lower than approved (${c.label})`,
        summary: `Approved ${c.approvedCents} cents but only ${received} cents received. ${LIKELY_OWED_WORDING}.`,
        lowCents: short, likelyCents: short, highCents: short, currency: 'USD', confidence: 0.8,
        deadline: c.claimDeadline, deadlineRisk: risk, isOpportunity: false, evidence: ev,
        howCalculated: [`Approved ${c.approvedCents} − credit received ${received} = ${short} cents.`], warnings: [],
      }));
    }
  }
  return out;
}

// ---------------------------------------------------------------- co-op
function detectCoop(input: AuditInput, today: string, s: AuditSettings, st: Map<string, StatementMeta>, vendorName: (id: string) => string): Finding[] {
  const out: Finding[] = [];
  for (const p of input.programs) {
    if (p.status !== 'active' || p.type !== 'co_op' || p.coopAccrualBps <= 0 || !p.periodStart || !p.periodEnd) continue;
    if (p.enrollment === 'not_enrolled') continue;
    const sp = spendFor(p, input, st, s);
    if (sp.source === 'none') continue;
    const gate = programGate(p, input, today, s);
    const warnings = [...gate.warnings];
    if (sp.pendingLines) warnings.push(`${sp.pendingLines} statement line(s) awaiting review were NOT counted.`);
    let accrued = mulBps(sp.acceptedCents, p.coopAccrualBps);
    if (p.coopCapCents !== null) accrued = Math.min(accrued, p.coopCapCents);
    const claimed = receivedFor(p, input, ['co_op']);
    const unclaimed = Math.max(0, accrued - claimed.cents);
    if (unclaimed <= 0) continue;
    const risk = deadlineRisk(today, p.claimDeadline);
    const missingDocs = p.requiredDocuments.filter((d) => !p.documentsOnFile.includes(d));
    if (missingDocs.length) warnings.push(`Missing proof documents: ${missingDocs.join(', ')}.`);
    const expired = risk === 'expired';
    if (expired) warnings.push('The claim deadline has passed — confirm with your distributor whether late claims are accepted.');
    const docsOk = missingDocs.length === 0;
    let confidence = 0.8 - gate.confPenalty - (sp.source === 'vendor_bills' ? 0.2 : 0);
    if (!docsOk) confidence -= 0.1;
    out.push(build({
      dedupeKey: `coop_unclaimed:${p.id}:${p.periodEnd}`, type: 'coop_unclaimed', kind: expired ? 'deadline_passed' : 'accrued_unclaimed',
      vendorId: p.vendorId, programId: p.id,
      title: `${vendorName(p.vendorId)}: co-op funds accrued but not claimed (${p.name})`,
      summary: `${LIKELY_OWED_WORDING}. Accrued ${accrued} cents at ${p.coopAccrualBps / 100}% of qualifying spend; ${claimed.cents} cents already claimed.`,
      lowCents: !expired && docsOk && !gate.zeroLow && sp.source === 'statements' ? unclaimed : 0,
      likelyCents: expired ? 0 : unclaimed, highCents: unclaimed, currency: p.currency, confidence,
      deadline: p.claimDeadline, deadlineRisk: risk, isOpportunity: false,
      evidence: [...sp.evidence.slice(0, 15), ...claimed.evidence, { kind: 'program', id: p.id, label: p.name }],
      howCalculated: [
        `Qualifying spend ${sp.acceptedCents} cents × ${p.coopAccrualBps / 100}% = ${mulBps(sp.acceptedCents, p.coopAccrualBps)} cents${p.coopCapCents !== null ? `, capped at ${p.coopCapCents}` : ''}.`,
        `Accrued ${accrued} − already claimed ${claimed.cents} = ${unclaimed} cents.`,
        'Co-op usually needs proof of marketing spend: low counts only when every required document is on file.',
      ],
      warnings,
    }));
  }
  return out;
}

// ---------------------------------------------------------------- duplicates
function detectDuplicates(input: AuditInput, s: AuditSettings, st: Map<string, StatementMeta>, vendorName: (id: string) => string): Finding[] {
  const out: Finding[] = [];
  // (1) The SAME invoice number listed twice inside ONE statement with identical lines (not open-item carry-over across statements).
  const perStatement = new Map<string, StatementLine[]>();
  for (const l of input.lines) {
    if (lineState(l, s.minConfidence) !== 'accepted' || !normInvoiceNo(l.invoiceNo) || !usable(l)) continue;
    const s0 = st.get(l.statementId); if (!s0) continue;
    const k = `${l.statementId}|${normInvoiceNo(l.invoiceNo)}`;
    perStatement.set(k, [...(perStatement.get(k) ?? []), l]);
  }
  for (const [k, ls] of perStatement) {
    const sig = new Map<string, StatementLine[]>();
    for (const l of ls) { const sg = `${(l.sku ?? '').toUpperCase()}|${l.qty}|${l.extendedCents}|${l.isCredit}`; sig.set(sg, [...(sig.get(sg) ?? []), l]); }
    const dupLines = [...sig.values()].filter((g) => g.length > 1 && !g[0].isCredit);
    if (!dupLines.length) continue;
    const extra = dupLines.reduce((a, g) => a + (g.length - 1) * (g[0].extendedCents as number), 0);
    const st0 = st.get(ls[0].statementId)!;
    out.push(build({
      dedupeKey: `duplicate_invoice:stmt:${k}`, type: 'duplicate_invoice', kind: 'same_statement_repeat',
      vendorId: st0.vendorId, programId: null,
      title: `${vendorName(st0.vendorId)}: invoice ${ls[0].invoiceNo} lists identical lines more than once`,
      summary: 'The same items appear more than once on one statement. This may be double billing — verify before disputing.',
      lowCents: 0, likelyCents: extra, highCents: extra, currency: ls[0].currency, confidence: 0.6,
      deadline: null, deadlineRisk: 'none', isOpportunity: false,
      evidence: dupLines.flat().slice(0, 20).map((l) => lineEvidence(l, st)),
      howCalculated: ['Identical SKU, quantity and amount repeated under the same invoice number on one statement.', `Repeated amount counted once: ${extra} cents. low = 0 until confirmed against your payment history.`],
      warnings: ['Open items repeated across different statements are NOT treated as duplicates.'],
    }));
  }
  // (2) Different invoice numbers, same vendor + date + total (likely re-keyed).
  const totals = new Map<string, { inv: Set<string>; cents: number; vendorId: string; ids: StatementLine[]; cur: string }>();
  const groups = groupInvoices(input.lines.filter((l) => lineState(l, s.minConfidence) === 'accepted' && usable(l) && !l.isCredit), st);
  for (const g of groups) {
    const total = g.lines.reduce((a, l) => a + (l.extendedCents as number), 0);
    if (total <= 0 || !g.date) continue;
    const k = `${g.vendorId}|${g.date}|${total}|${g.lines.length}`;
    const e = totals.get(k) ?? { inv: new Set<string>(), cents: total, vendorId: g.vendorId, ids: [], cur: g.lines[0].currency };
    e.inv.add(normInvoiceNo(g.invoiceNo)); e.ids.push(...g.lines); totals.set(k, e);
  }
  for (const [k, e] of [...totals].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (e.inv.size < 2) continue;
    out.push(build({
      dedupeKey: `duplicate_invoice:amt:${k}`, type: 'duplicate_invoice', kind: 'different_number_same_amount',
      vendorId: e.vendorId, programId: null,
      title: `${vendorName(e.vendorId)}: ${e.inv.size} invoices with identical date and total (${e.cents} cents)`,
      summary: 'Two invoice numbers share the same date, line count and total — possibly the same bill keyed twice. Verify before disputing.',
      lowCents: 0, likelyCents: 0, highCents: e.cents, currency: e.cur, confidence: 0.4,
      deadline: null, deadlineRisk: 'none', isOpportunity: false,
      evidence: e.ids.slice(0, 20).map((l) => lineEvidence(l, st)),
      howCalculated: ['Same vendor, invoice date, number of lines and total under different invoice numbers.', 'Only an upper bound is shown (likely = 0): many vendors legitimately issue identical repeat orders.'],
      warnings: ['Weak signal — treat as a question to ask your rep, not a claim.'],
    }));
  }
  // (3) AP bills: the same bill number + amount recorded twice and both paid (strongest evidence).
  const bills = new Map<string, typeof input.vendorBills>();
  for (const b of input.vendorBills) {
    if (!b.vendorId || !normInvoiceNo(b.billNumber)) continue;
    const k = `${b.vendorId}|${normInvoiceNo(b.billNumber)}|${b.amountCents}`;
    bills.set(k, [...(bills.get(k) ?? []), b]);
  }
  for (const [k, bs] of [...bills].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (bs.length < 2) continue;
    const paid = bs.filter((b) => b.status === 'paid').length;
    const amt = bs[0].amountCents;
    out.push(build({
      dedupeKey: `duplicate_invoice:ap:${k}`, type: 'duplicate_invoice', kind: paid >= 2 ? 'paid_twice' : 'duplicate_entry',
      vendorId: bs[0].vendorId as string, programId: null,
      title: `${vendorName(bs[0].vendorId as string)}: bill ${bs[0].billNumber} recorded ${bs.length}× (${paid >= 2 ? 'paid twice' : 'not both paid'})`,
      summary: paid >= 2 ? `Both entries are marked paid — a refund or credit of ${amt} cents may be due. ${LIKELY_OWED_WORDING}.` : 'A duplicate AP entry exists; make sure it is not paid twice.',
      lowCents: paid >= 2 ? amt * (paid - 1) : 0, likelyCents: paid >= 2 ? amt * (paid - 1) : 0, highCents: amt * (bs.length - 1), currency: 'USD',
      confidence: paid >= 2 ? 0.85 : 0.5, deadline: null, deadlineRisk: 'none', isOpportunity: false,
      evidence: bs.map((b) => ({ kind: 'vendor_bill' as const, id: b.id, label: `Bill ${b.billNumber} · ${b.billDate} · ${b.status}`, amountCents: b.amountCents })),
      howCalculated: [`Same vendor, bill number and amount recorded ${bs.length} times; ${paid} marked paid.`, 'Refund/credit = amount × (paid entries − 1).'],
      warnings: [],
    }));
  }
  return out;
}

/** Spend / tier position for the per-vendor tier tracker (same numbers the findings use). */
export function programSpendSummary(p: Program, input: Pick<AuditInput, 'statements' | 'lines' | 'vendorBills'>, settings: Partial<AuditSettings> = {}) {
  const s: AuditSettings = { ...DEFAULT_SETTINGS, ...settings };
  const st = new Map(input.statements.map((x) => [x.id, x]));
  const sp = spendFor(p, input as AuditInput, st, s);
  return { ...sp, tierIndex: tierIndexFor(p.tiers, sp.acceptedCents), expectedCents: rebateFor(p, sp.acceptedCents) };
}

// ---------------------------------------------------------------- orchestration
export function runAudit(input: AuditInput): Finding[] {
  const s: AuditSettings = { ...DEFAULT_SETTINGS, ...(input.settings ?? {}) };
  const today = todayInZone(input.now, input.timeZone);
  const st = new Map(input.statements.map((x) => [x.id, x]));
  const names = new Map(input.vendors.map((v) => [v.id, v.name]));
  const vendorName = (id: string) => names.get(id) ?? 'Supplier';
  const fallbackVendor = null;
  const all = [
    ...detectPrices(input, today, s, st, vendorName),
    ...detectTiers(input, today, s, st, vendorName),
    ...detectCredits(input, today, s, vendorName),
    ...detectWarranty(input, today, s, vendorName, fallbackVendor),
    ...detectCoop(input, today, s, st, vendorName),
    ...detectDuplicates(input, s, st, vendorName),
  ];
  const seen = new Map<string, Finding>();
  for (const f of all) if (!seen.has(f.dedupeKey)) seen.set(f.dedupeKey, f); // a key can never appear twice
  return [...seen.values()].sort((a, b) => a.dedupeKey.localeCompare(b.dedupeKey));
}

// ---------------------------------------------------------------- summary + merge (mirrors sa_upsert_findings)
export interface Summary {
  estimatedLowCents: number; estimatedLikelyCents: number; estimatedHighCents: number;
  opportunityCents: number; recoveredCents: number; openCount: number; byCurrency: boolean;
}

/** Estimated (open, recoverable) and recovered (measured) are returned separately and never added together. */
export function summarize(rows: { status: string; is_opportunity: boolean; low_cents: number; likely_cents: number; high_cents: number; recovered_cents: number; currency?: string }[]): Summary {
  let lo = 0; let li = 0; let hi = 0; let opp = 0; let rec = 0; let open = 0; const cur = new Set<string>();
  for (const r of rows) {
    if (r.currency) cur.add(r.currency);
    rec += r.recovered_cents;
    if (!['open', 'packet_ready', 'claimed', 'partially_recovered'].includes(r.status)) continue;
    const remainder = (v: number) => Math.max(0, v - r.recovered_cents);
    if (r.is_opportunity) { opp += r.likely_cents; continue; }
    lo += remainder(r.low_cents); li += remainder(r.likely_cents); hi += remainder(r.high_cents); open++;
  }
  return { estimatedLowCents: lo, estimatedLikelyCents: li, estimatedHighCents: hi, opportunityCents: opp, recoveredCents: rec, openCount: open, byCurrency: cur.size > 1 };
}

export function mergeFindings<T extends { dedupeKey: string; status: string; fingerprint: string }>(
  existing: T[], next: Finding[], complete = true,
): { rows: T[]; inserted: number; updated: number; unchanged: number; superseded: number } {
  const map = new Map(existing.map((e) => [e.dedupeKey, e]));
  let ins = 0; let upd = 0; let same = 0; let sup = 0;
  const seen = new Set<string>();
  const out = new Map<string, T>(map);
  for (const f of next) {
    seen.add(f.dedupeKey);
    const ex = map.get(f.dedupeKey);
    if (!ex) { out.set(f.dedupeKey, f as unknown as T); ins++; }
    else if (['open', 'packet_ready', 'superseded'].includes(ex.status)) {
      if (ex.status === 'superseded' || ex.fingerprint !== f.fingerprint) { out.set(f.dedupeKey, { ...ex, ...f, status: ex.status === 'superseded' ? 'open' : ex.status } as T); upd++; } else same++;
    } else same++;
  }
  if (complete) for (const [k, ex] of map) if (!seen.has(k) && ['open', 'packet_ready'].includes(ex.status)) { out.set(k, { ...ex, status: 'superseded' }); sup++; }
  return { rows: [...out.values()], inserted: ins, updated: upd, unchanged: same, superseded: sup };
}

export type { FindingType, WarrantyClaimLite };
