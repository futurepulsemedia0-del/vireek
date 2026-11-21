/**
 * Case-study document model + Markdown renderer. Pure and deterministic (no Intl, no clock): the same inputs always give the
 * same bytes, so a document can be re-generated and compared. Money is "USD 3,200.00", dates are ISO.
 *
 *  mode "audit"  : for the account itself. Always allowed. Carries the full source appendix and a DRAFT banner until consent exists.
 *  mode "public" : for use outside the account. Throws unless publicationGate() passes. No event-level references.
 */
import {
  METHOD_VERSION, computeOutcome, publicationGate, verificationNotice,
  type OutcomeResult, type ProofCase, type ProofConsent, type ProofSource,
} from './method';

export type RenderMode = 'audit' | 'public';

export interface CaseDocument {
  title: string;
  mode: RenderMode;
  banner: string | null;
  verification: string;
  businessLabel: string;
  personLabel: string | null;
  quote: string | null;
  period: string;
  facts: Array<{ label: string; value: string }>;
  roiLine: string;
  methodLines: string[];
  excludedLines: string[];
  integrity: string;
  consentLine: string;
  sourceRows: Array<{ id: string; type: string; amount: string; confidence: string; evidenceRef: string; date: string; status: string }>;
}

export class PublicationBlockedError extends Error {
  readonly blocks: string[];
  constructor(blocks: string[]) { super(`Publication blocked: ${blocks.join(', ')}`); this.name = 'PublicationBlockedError'; this.blocks = blocks; }
}

export function formatMoney(cents: number, currency: string): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${currency} ${whole}.${String(abs % 100).padStart(2, '0')}`;
}
export const formatMinutes = (m: number): string => `${Math.floor(m / 60)} h ${m % 60} min`;
export const formatRatioPct = (r: number): string => `${r < 0 ? '-' : ''}${Math.abs(Math.round(r * 100))}%`;
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Escape text that came from a person so it cannot add Markdown structure, HTML, links or table cells. */
export function mdEscape(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}[\]<>()#+!|~]/g, (ch) => `\\${ch}`).trim();
}

const REASON_TEXT: Record<string, string> = {
  cost_unknown: 'the subscription cost for the period is not known',
  measured_events_below_5: 'fewer than 5 measured money events',
  period_below_28_days: 'the period is shorter than 28 days',
};
const EXCLUSION_TEXT = {
  owner_review_not_due_to_vireek: 'removed by the account owner as not due to Vireek',
  superseded_by_measured: 'estimates replaced by a measured figure for the same item',
  other_currency: 'recorded in a different currency',
} as const;

export function buildDocument(c: ProofCase, sources: readonly ProofSource[], consents: readonly ProofConsent[], mode: RenderMode, businessName: string | null = null): CaseDocument {
  const outcome: OutcomeResult = computeOutcome(c, sources);
  const gate = publicationGate(c, sources, consents, outcome);
  if (mode === 'public' && !gate.mayPublish) throw new PublicationBlockedError(gate.blocks);
  const consent = gate.consent && gate.consent.decision === 'granted' && gate.consent.caseSha256 === c.snapshotSha256 ? gate.consent : null;
  const t = outcome.totals;

  const facts: CaseDocument['facts'] = [
    { label: 'Measured value', value: formatMoney(t.measuredCents, c.currency) },
    { label: 'Estimated value (reported separately)', value: formatMoney(t.estimatedCents, c.currency) },
    { label: 'Time saved (not converted to money)', value: formatMinutes(t.savedMinutes) },
    { label: 'Ledger events included', value: String(t.count) },
  ];
  let roiLine: string;
  if (outcome.status === 'ok') {
    facts.push({ label: 'Subscription cost for the period', value: `${formatMoney(outcome.costCents, c.currency)} (${c.costBasis.replace('_', ' ')})` });
    roiLine = `Return on subscription cost: between ${formatRatioPct(outcome.roiLow)} (measured value only) and ${formatRatioPct(outcome.roiHigh)} (measured plus estimated).`;
  } else {
    roiLine = `No return figure is shown: ${outcome.reasons.map((r) => REASON_TEXT[r] ?? r).join('; ')}.`;
  }

  const showBiz = !!consent?.allowBusinessName, showPerson = !!consent?.allowPersonName;
  const excludedLines = (Object.keys(EXCLUSION_TEXT) as Array<keyof typeof EXCLUSION_TEXT>)
    .filter((k) => outcome.excluded[k] > 0).map((k) => `${outcome.excluded[k]} event(s) ${EXCLUSION_TEXT[k]}`);

  return {
    title: c.title,
    mode,
    banner: mode === 'audit' && !gate.mayPublish
      ? `DRAFT. Not approved for publication (${gate.blocks.join(', ')}). Internal audit copy.` : null,
    verification: verificationNotice(c),
    businessLabel: showBiz && businessName && businessName.trim() ? mdEscape(businessName) : 'A home-service business',
    personLabel: showPerson && consent ? `${mdEscape(consent.signerName)}${consent.signerRole ? `, ${mdEscape(consent.signerRole)}` : ''}` : null,
    quote: consent?.allowQuote && consent.quoteText ? mdEscape(consent.quoteText) : null,
    period: `${c.periodStart} to ${c.periodEnd} (UTC, ${outcome.periodDays} days)`,
    facts, roiLine,
    methodLines: [
      `Method: ${c.methodVersion}${c.methodVersion === METHOD_VERSION ? '' : ' (not the current method version)'}. Documented in docs/proof/roi-method.md.`,
      'Measured value comes from recorded, paid outcomes. Estimated value is an assumption-based figure and is never added into the measured total.',
      'Nothing is annualised, extrapolated or averaged across customers.',
    ],
    excludedLines,
    integrity: `Snapshot SHA-256: ${c.snapshotSha256}. The listed ledger events hash to this value${mode === 'public' ? '; the full event list is available to the account owner.' : '.'}`,
    consentLine: consent
      ? `Consent: granted by ${mode === 'public' && !consent.allowPersonName ? 'an authorised representative of the business' : mdEscape(consent.signerName)} on ${consent.decidedAt.slice(0, 10)} (consent text ${mdEscape(consent.consentTextVersion)}). Scope: figures${consent.allowBusinessName ? ', business name' : ''}${consent.allowPersonName ? ', person name' : ''}${consent.allowQuote ? ', quote' : ''}.`
      : 'Consent: none recorded for this snapshot.',
    sourceRows: mode === 'audit' ? [...sources].sort((a, b) => a.occurredMs - b.occurredMs).map((s) => ({
      id: s.valueEventId, type: s.type, amount: s.unit === 'cents' ? formatMoney(s.amount, s.currency ?? c.currency) : formatMinutes(s.amount),
      confidence: s.confidence, evidenceRef: mdEscape(s.evidenceRef), date: isoDate(s.occurredMs), status: s.included ? 'included' : `excluded: ${s.exclusion ?? ''}`,
    })) : [],
  };
}

export function renderMarkdown(c: ProofCase, sources: readonly ProofSource[], consents: readonly ProofConsent[], mode: RenderMode, businessName: string | null = null): string {
  const d = buildDocument(c, sources, consents, mode, businessName);
  const out: string[] = [`# ${mdEscape(d.title)}`, ''];
  if (d.banner) out.push(`> **${d.banner}**`, '');
  out.push(`**${d.verification}**`, '', `${d.businessLabel}${d.personLabel ? `, ${d.personLabel}` : ''}. Period: ${d.period}.`, '');
  out.push('| Measure | Value |', '|---|---|', ...d.facts.map((f) => `| ${f.label} | ${f.value} |`), '', d.roiLine, '');
  if (d.quote) out.push(`> ${d.quote}`, '', `Quote approved in writing by the customer.`, '');
  out.push('## How this was calculated', '', ...d.methodLines.map((l) => `- ${l}`));
  if (d.excludedLines.length) out.push('', '## Left out', '', ...d.excludedLines.map((l) => `- ${l}`));
  out.push('', '## Integrity and consent', '', `- ${d.integrity}`, `- ${d.consentLine}`);
  if (d.sourceRows.length) {
    out.push('', '## Source events (audit trail)', '', '| Event | Type | Amount | Confidence | Evidence reference | Date | Status |', '|---|---|---|---|---|---|---|',
      ...d.sourceRows.map((r) => `| ${r.id} | ${r.type} | ${r.amount} | ${r.confidence} | ${r.evidenceRef} | ${r.date} | ${r.status} |`));
  }
  out.push('', `*${d.verification}*`, '');
  return out.join('\n');
}
