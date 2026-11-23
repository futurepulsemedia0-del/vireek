/**
 * Partner revenue-share statement on the Vireek document design system (DocumentWriter). Pure: it draws onto a
 * jsPDF-like document and does no I/O, so it can be tested with a recording fake.
 *
 * Statements are English/USD only: the shared PDF fonts are Latin-1 and the programme pays in USD. Text that
 * the font cannot draw (e.g. a partner company name in another script) is replaced with "?" instead of being
 * silently garbled, and the CSV export carries the exact original text.
 */
import { DocumentWriter, type DocBrandLike, type PdfDocLike } from '@/lib/documents/pdfKit';
import { DANGER, MUTED, SUCCESS, readableOn } from '@/lib/documents/tokens';
import { formatUsdCents } from '@/lib/partnerCommissionStaff';
import {
  CARRY_REASON_LABEL,
  LINE_TYPE_LABEL,
  PAYOUT_STATUS_LABEL,
  periodLabel,
  type PartnerStatement,
  type StatementAudience,
} from '@/lib/partnerStatement';

/** [COUNSEL] wording is a factual description of how the numbers are built, not a legal statement; counsel to review. */
export const STATEMENT_FOOTNOTE =
  'Amounts are in US dollars. Commissions are calculated on collected revenue excluding tax; refunds and disputes on referred customers\u2019 invoices are deducted as clawbacks and netted against later payouts. This statement is not a tax document.';

/** Replaces anything outside Latin-1 (what the built-in PDF font can draw) with "?". */
export function latin1Safe(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 63;
    out += code <= 0xff && (code >= 0x20 || code === 0x09) ? ch : code === 0x2014 || code === 0x2013 ? '-' : code === 0x2019 ? "'" : '?';
  }
  return out;
}

const day = (iso: string): string => (iso.length >= 10 ? iso.slice(0, 10) : iso);

export function statementNumber(s: Pick<PartnerStatement, 'period_start' | 'partner' | 'id'>): string {
  const ym = s.period_start ? s.period_start.slice(0, 7) : 'ADHOC';
  return `PS-${ym}-${s.partner.referral_code || s.id.slice(0, 8).toUpperCase()}`;
}

export function renderPartnerStatement(
  doc: PdfDocLike,
  s: PartnerStatement,
  brand: DocBrandLike,
  opts: { audience?: StatementAudience } = {},
): PdfDocLike {
  const audience = opts.audience ?? 'partner';
  const accentText = readableOn(brand.primary);
  const number = statementNumber(s);
  const title = `Partner statement ${number}`;

  const w = new DocumentWriter(doc, {
    brand,
    lang: 'en',
    rtl: false,
    title,
    subject: `Revenue share for ${periodLabel(s.period_start)}`,
    docNumber: number,
    pageLabel: { page: 'Page', of: 'of' },
    legalLine: STATEMENT_FOOTNOTE,
  }).begin();

  const stamp =
    s.status === 'paid' ? { text: 'Paid', color: SUCCESS }
    : s.status === 'void' ? { text: 'Void', color: DANGER }
    : s.carry_reason === 'negative_balance' ? { text: 'Negative balance', color: DANGER }
    : s.status === 'carried_forward' ? { text: 'Carried forward', color: MUTED }
    : null;

  w.titleBlock({ business: latin1Safe(brand.wordmark), kind: 'Partner statement', number, stamp });

  const partnerLines = [latin1Safe(s.partner.company_name)];
  if (s.partner.tier) partnerLines.push(`${s.partner.tier.charAt(0).toUpperCase()}${s.partner.tier.slice(1)} partner`);
  if (s.partner.channel) partnerLines.push(`Channel: ${latin1Safe(s.partner.channel)}`);
  if (s.partner.referral_code) partnerLines.push(`Code: ${latin1Safe(s.partner.referral_code)}`);

  const periodLines = [periodLabel(s.period_start)];
  if (s.period_start && s.period_end) periodLines.push(`${day(s.period_start)} to ${day(s.period_end)}`);
  periodLines.push(`Calculated ${day(s.calculated_at)}`);

  const agreementLines = s.agreement
    ? [
        `Agreement v${s.agreement.version}`,
        `${s.agreement.revenue_share_pct}% for ${s.agreement.term_months} months`,
        `Minimum payout ${formatUsdCents(s.agreement.min_payout_cents)}`,
      ]
    : ['No agreement on file', `Minimum payout ${formatUsdCents(s.min_payout_cents)}`];
  if (audience === 'finance' && s.agreement?.document_ref) agreementLines.push(`Doc: ${latin1Safe(s.agreement.document_ref)}`);

  w.metaRow([
    { at: 0, label: 'Partner', lines: partnerLines },
    { at: 0.38, label: 'Period', lines: periodLines },
    { at: 0.68, label: 'Terms', lines: agreementLines },
  ]);

  w.section('Summary');
  const net = formatUsdCents(s.net_cents);
  w.summary([
    { label: 'Gross commissions', value: formatUsdCents(s.gross_cents) },
    { label: 'Clawbacks netted', value: formatUsdCents(s.clawback_cents), color: s.clawback_cents < 0 ? DANGER : undefined },
    { label: 'Net balance', value: net, bold: true, color: s.net_cents < 0 ? DANGER : accentText },
    ...(s.held_cents !== 0 ? [{ label: 'Held back (30-day hold)', value: formatUsdCents(s.held_cents) }] : []),
  ]);
  w.y += 4;
  const statusText = `Status: ${PAYOUT_STATUS_LABEL[s.status]}${s.carry_reason ? ` - ${CARRY_REASON_LABEL[s.carry_reason]}` : ''}.`;
  w.paragraph(statusText, { size: 9, color: MUTED });
  if (s.status === 'paid' && s.paid_at) {
    w.paragraph(`Paid on ${day(s.paid_at)}${audience === 'finance' && s.payment_reference ? ` (ref ${latin1Safe(s.payment_reference)})` : ''}.`, { size: 9, color: MUTED });
  }
  if (s.status === 'carried_forward' && s.carry_reason !== 'nothing_due') {
    w.paragraph('Nothing is paid for this period. The balance above stays open and is included in the next statement.', { size: 9, color: MUTED });
  }
  w.y += 12;

  w.section('Statement lines');
  if (s.lines.length === 0) {
    w.paragraph('No payable entries in this period.', { size: 9, color: MUTED });
  } else {
    w.table(
      [
        { header: 'Date', weight: 1.1 },
        { header: 'Type', weight: 1.6 },
        { header: 'Ref', weight: 1.1 },
        { header: 'Month', weight: 0.6, align: 'right' },
        { header: 'Base', weight: 1.1, align: 'right' },
        { header: 'Rate', weight: 0.8, align: 'right' },
        { header: 'Amount', weight: 1.2, align: 'right' },
      ],
      s.lines.map((l) => [
        day(l.earned_at),
        LINE_TYPE_LABEL[l.entry_type],
        l.ref,
        l.period_index === null ? '' : String(l.period_index),
        l.base_cents === null ? '' : formatUsdCents(l.base_cents),
        l.rate_pct === null ? '' : `${l.rate_pct}%`,
        formatUsdCents(l.amount_cents),
      ]),
      { zebra: true },
    );
  }
  if (s.lines_truncated) {
    w.y += 6;
    w.paragraph('The line list is truncated at 5,000 entries; the totals above are complete.', { size: 9, color: MUTED });
  }

  return w.finish();
}
