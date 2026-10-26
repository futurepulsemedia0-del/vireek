/** Claim packet logic (pure). The system NEVER sends anything: a human approves, then marks it sent themselves. */
import { daysBetween, formatMoney, isYmd } from './money';
import type { EvidenceRef, Program } from './types';

export interface PacketFinding {
  id: string; title: string; summary: string; type: string; currency: string;
  low_cents: number; likely_cents: number; high_cents: number; confidence: number;
  deadline: string | null; evidence: EvidenceRef[]; warnings: string[]; how_calculated: string[];
}
export interface ChecklistItem { label: string; ok: boolean; blocking: boolean; note?: string }
export interface PacketState { status: 'draft' | 'approved' | 'marked_sent' | 'cancelled'; approved_at: string | null; approved_by: string | null }

export const canApprove = (p: PacketState) => p.status === 'draft';
/** No submission without explicit human approval. */
export const canMarkSent = (p: PacketState) => p.status === 'approved' && !!p.approved_at && !!p.approved_by;

/** Items to fix BEFORE the deadline. `blocking` items are flagged red in the packet. */
export function missingItems(f: PacketFinding, program: Program | null, today: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const has = (k: EvidenceRef['kind']) => f.evidence.some((e) => e.kind === k);
  const needsLines = ['price_deviation', 'rebate_owed', 'coop_unclaimed', 'duplicate_invoice'].includes(f.type);
  if (needsLines) items.push({ label: 'Supporting statement lines or invoices attached', ok: has('statement_line') || has('vendor_bill'), blocking: true });
  if (f.type === 'unapplied_credit') items.push({ label: 'Credit memo copy attached', ok: has('credit_memo'), blocking: true });
  if (f.type.startsWith('warranty')) items.push({ label: 'Warranty claim record attached', ok: has('warranty_claim'), blocking: true });
  if (program) {
    items.push({ label: 'Program rule and source link included', ok: !!program.sourceUrl, blocking: false, note: program.sourceUrl ? undefined : 'Add the source URL on the program.' });
    items.push({ label: 'Enrollment confirmed', ok: program.enrollment === 'enrolled' || program.enrollment === 'not_required', blocking: program.enrollment === 'unknown' });
    for (const d of program.requiredDocuments) items.push({ label: `Required document: ${d}`, ok: program.documentsOnFile.includes(d), blocking: true });
  }
  if (f.warnings.some((w) => /awaiting review/i.test(w))) items.push({ label: 'All statement lines reviewed', ok: false, blocking: true, note: 'Review pending lines first.' });
  if (f.deadline && isYmd(f.deadline)) {
    const d = daysBetween(today, f.deadline);
    items.push({ label: d < 0 ? `Deadline passed ${-d} day(s) ago` : `Deadline in ${d} day(s) (${f.deadline})`, ok: d > 7, blocking: d < 0, note: d <= 7 ? 'Submit as soon as the packet is approved.' : undefined });
  }
  return items;
}

/** Draft note to the rep — questions, not demands; eligibility is never asserted. */
export function buildDraftMessage(f: PacketFinding, vendorName: string, businessName: string, program: Program | null): string {
  const range = f.high_cents > f.low_cents
    ? `${formatMoney(f.low_cents, f.currency)} – ${formatMoney(f.high_cents, f.currency)}`
    : formatMoney(f.likely_cents, f.currency);
  const lines = [
    `Hi,`,
    ``,
    `I'm reviewing our ${vendorName} account and want to confirm something before it slips past a deadline.`,
    ``,
    `${f.summary}`,
    ``,
    `Our records suggest this could be worth about ${range}. This is our own estimate — please confirm whether it applies and what you need from us.`,
  ];
  if (program?.sourceUrl) lines.push(``, `Program reference: ${program.name} (${program.sourceUrl}).`);
  if (f.deadline) lines.push(``, `We understand the claim window closes ${f.deadline}.`);
  lines.push(``, `Supporting statement lines and invoices are attached. Could you confirm receipt and let us know the next step?`, ``, `Thank you,`, businessName);
  return lines.join('\n');
}
