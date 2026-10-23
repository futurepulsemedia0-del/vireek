import { ADVISOR_HORIZON_YEARS, usd, type AdvisorResult, type FinancingOption, type ReasonTone } from '@/lib/repairReplaceAdvisor';

/**
 * Customer-facing proposal built from an AdvisorResult. Pure: same result + same meta = same proposal.
 * Everything printed comes from the advisor result. Engine jargon (hazard, multiplier, Weibull, scenarios)
 * stays on the contractor's screen; the customer gets plain numbers, plain reasons and honest disclosures.
 */

export interface ProposalMeta {
  now: number;
  businessName: string | null;
  customerName: string;
  customerAddress?: string | null;
  /** Public Equipment Passport link for the machine, if it has one. */
  passportUrl?: string | null;
  validDays?: number;
}

export interface ProposalOption {
  key: 'repair' | 'replace';
  title: string;
  recommended: boolean;
  upfrontCents: number;
  fiveYearCostCents: number;
  remainingValueCents: number;
  netCostCents: number;
  highlights: string[];
  considerations: string[];
}

export interface ProposalRebate {
  name: string;
  amountCents: number;
  when: string;
  status: string;
  note: string | null;
}

export interface ProposalFinancing {
  label: string;
  monthlyCents: number | null;
  termMonths: number | null;
  aprText: string | null;
  totalPaidCents: number;
  note: string | null;
  recommended: boolean;
}

export interface Proposal {
  title: string;
  preparedBy: string | null;
  preparedFor: string;
  address: string | null;
  issuedOn: string;
  validUntil: string;
  equipment: { name: string; ageText: string; passportUrl: string | null };
  verdict: AdvisorResult['verdict'];
  headline: string;
  summary: string;
  options: ProposalOption[];
  comparison: { label: string; repair: string; replace: string }[];
  reasons: { tone: ReasonTone; text: string }[];
  rebates: ProposalRebate[];
  rebateTotalCents: number;
  financing: ProposalFinancing[];
  nextSteps: string[];
  assumptions: string[];
  disclosures: string[];
}

const DAY_MS = 86_400_000;

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const TIMING_TEXT: Record<'point_of_sale' | 'post_install' | 'tax_filing', string> = {
  point_of_sale: 'Taken off the price at install',
  post_install: 'Paid after installation',
  tax_filing: 'Claimed when you file taxes',
};

const STATUS_TEXT = { eligible: 'Qualifies', likely: 'Likely to qualify', needs_info: 'Needs more information' } as const;

function aprText(o: FinancingOption): string | null {
  if (o.aprBps === null) return null;
  const apr = `${(o.aprBps / 100).toFixed(2)}% APR`;
  return o.aprSource === 'lender_quote' ? apr : `about ${apr} (estimate)`;
}

export function proposalFileName(customerName: string, equipmentName: string, now: number): string {
  const slug = (s: string) =>
    s
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .toLowerCase()
      .slice(0, 40);
  const parts = [slug(customerName), slug(equipmentName)].filter(Boolean);
  return `repair-or-replace-${parts.join('-') || 'proposal'}-${isoDay(now)}.pdf`;
}

export function buildProposal(result: AdvisorResult, meta: ProposalMeta): Proposal {
  const { verdict } = result;
  const replacing = verdict === 'replace';
  const years = ADVISOR_HORIZON_YEARS;
  const rebates = result.rebates;

  const headline = replacing ? 'We recommend replacing this unit' : 'We recommend repairing this unit';
  const closeCall = result.strength === 'toss_up';
  const summary = replacing
    ? `Over the next ${years} years, replacing is expected to cost about ${usd(Math.abs(result.netAdvantageOfReplacingCents))} ${result.netAdvantageOfReplacingCents >= 0 ? 'less' : 'more'} than repairing, once rebates, energy savings and the value of the equipment you still own at the end are counted.${closeCall ? ' It is a close call, so either choice is reasonable.' : ''}`
    : `Over the next ${years} years, repairing is expected to cost about ${usd(Math.abs(result.netAdvantageOfReplacingCents))} ${result.netAdvantageOfReplacingCents <= 0 ? 'less' : 'more'} than replacing, so the repair is the smarter use of your money right now.${closeCall ? ' It is a close call, so either choice is reasonable.' : ''}`;

  const repairHighlights = [
    `${usd(result.repair.upfrontCents)} today`,
    result.unit.warrantyActive ? 'Warranty still covers part of future repairs' : 'Keeps your current equipment running',
  ];
  const repairConsiderations = [
    `Chance of another breakdown: about ${Math.round(result.risk.risk12m * 100)}% within a year`,
    result.repair.lines.some((l) => l.key === 'forced_replacement' && l.nominalCents > 0)
      ? `You may still need to replace it within ${years} years (expected cost included above)`
      : 'Replacement is unlikely to be needed within the period',
  ];
  const replaceHighlights = [
    `${usd(result.replace.upfrontCents)} today after instant discounts`,
    ...(rebates && rebates.expectedCents > 0 ? [`About ${usd(rebates.expectedCents)} in rebates and tax credits expected`] : []),
    ...(result.annualEnergySavingsCents > 0 ? [`About ${usd(result.annualEnergySavingsCents)} a year lower energy bills`] : []),
    'New-equipment warranty',
  ];
  const replaceConsiderations = [
    'Higher cost today than a repair',
    ...(rebates && rebates.expectedCents > 0 ? ['Rebates are not guaranteed until approved'] : []),
  ];

  const make = (key: 'repair' | 'replace'): ProposalOption => {
    const p = key === 'repair' ? result.repair : result.replace;
    return {
      key,
      title: key === 'repair' ? 'Repair' : 'Replace',
      recommended: verdict === key,
      upfrontCents: p.upfrontCents,
      fiveYearCostCents: p.outOfPocketCents,
      remainingValueCents: p.residualCreditCents,
      netCostCents: p.netCostCents,
      highlights: key === 'repair' ? repairHighlights : replaceHighlights,
      considerations: key === 'repair' ? repairConsiderations : replaceConsiderations,
    };
  };
  const options = [make('repair'), make('replace')].sort((a, b) => Number(b.recommended) - Number(a.recommended));

  const comparison = [
    { label: 'Pay today', repair: usd(result.repair.upfrontCents), replace: usd(result.replace.upfrontCents) },
    { label: `Expected spending over ${years} years`, repair: usd(result.repair.outOfPocketCents), replace: usd(result.replace.outOfPocketCents) },
    { label: `Equipment value left after ${years} years`, repair: `-${usd(result.repair.residualCreditCents)}`, replace: `-${usd(result.replace.residualCreditCents)}` },
    { label: `Net ${years}-year cost`, repair: usd(result.repair.netCostCents), replace: usd(result.replace.netCostCents) },
  ];

  const proposalRebates: ProposalRebate[] = (rebates?.programs ?? []).map((p) => ({
    name: p.name,
    amountCents: p.amountCents,
    when: TIMING_TEXT[p.timing],
    status: STATUS_TEXT[p.status],
    note: p.endDate ? `Ends ${p.endDate}${p.requiresPreApproval ? '; approval needed before installation' : ''}` : p.requiresPreApproval ? 'Approval needed before installation' : null,
  }));

  const financing: ProposalFinancing[] = result.financing
    .filter((o) => o.feasible)
    .map((o) => ({
      label: o.label,
      monthlyCents: o.monthlyCents,
      termMonths: o.termMonths,
      aprText: aprText(o),
      totalPaidCents: o.totalPaidCents,
      note:
        o.kind === 'cash'
          ? 'No interest. Rebates arrive after install.'
          : o.monthlyAfterRebatePaydownCents !== null && o.monthlyAfterRebatePaydownCents < (o.monthlyCents ?? 0)
            ? `Drops to about ${usd(o.monthlyAfterRebatePaydownCents)} a month if post-install rebates are applied to the loan.`
            : null,
      recommended: o.recommended,
    }));

  const issued = meta.now;
  const validDays = meta.validDays ?? 30;

  return {
    title: 'Repair or replace: your options',
    preparedBy: meta.businessName,
    preparedFor: meta.customerName,
    address: meta.customerAddress ?? null,
    issuedOn: isoDay(issued),
    validUntil: isoDay(issued + validDays * DAY_MS),
    equipment: {
      name: result.unit.label,
      ageText: result.unit.ageKnown ? `About ${Math.round(result.unit.ageYears)} years old` : 'Age not on file',
      passportUrl: meta.passportUrl ?? null,
    },
    verdict,
    headline,
    summary,
    options,
    comparison,
    reasons: result.reasons.map((r) => ({ tone: r.tone, text: r.text })),
    rebates: proposalRebates,
    rebateTotalCents: rebates?.expectedCents ?? 0,
    financing,
    nextSteps: result.nextSteps,
    assumptions: result.assumptions.filter((a) => !/Weibull|hazard/i.test(a)),
    disclosures: [
      'These are estimates to help you decide, not a guarantee of future costs or savings.',
      'Rebates and tax credits depend on program rules, available funding and approval; amounts can change. Confirm eligibility with each program or a tax professional.',
      'Financing is subject to credit approval. Rates shown as estimates are not an offer; the lender sets the final rate and terms.',
      `This proposal is valid until ${isoDay(issued + validDays * DAY_MS)}. Final pricing is confirmed in a signed quote.`,
    ],
  };
}

/** Plain-text version for an email or text message. */
export function proposalToText(p: Proposal): string {
  const lines: string[] = [];
  lines.push(`${p.preparedBy ? `${p.preparedBy}: ` : ''}${p.title}`);
  lines.push(`Prepared for ${p.preparedFor} on ${p.issuedOn}. Valid until ${p.validUntil}.`);
  lines.push('');
  lines.push(`${p.equipment.name} (${p.equipment.ageText})`);
  lines.push(`${p.headline}.`);
  lines.push(p.summary);
  lines.push('');
  for (const c of p.comparison) lines.push(`${c.label}: Repair ${c.repair} | Replace ${c.replace}`);
  if (p.reasons.length > 0) {
    lines.push('', 'Why:');
    for (const r of p.reasons) lines.push(`- ${r.text}`);
  }
  if (p.rebateTotalCents > 0) lines.push('', `Expected rebates and tax credits: about ${usd(p.rebateTotalCents)} (not guaranteed until approved).`);
  if (p.financing.some((f) => f.monthlyCents !== null)) {
    lines.push('', 'Financing options (estimates):');
    for (const f of p.financing) {
      if (f.monthlyCents !== null) lines.push(`- ${f.label}: about ${usd(f.monthlyCents)}/month${f.aprText ? ` at ${f.aprText}` : ''}${f.recommended ? ' (suggested)' : ''}`);
    }
  }
  if (p.nextSteps.length > 0) {
    lines.push('', 'Next steps:');
    p.nextSteps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }
  if (p.equipment.passportUrl) lines.push('', `Equipment history: ${p.equipment.passportUrl}`);
  lines.push('', p.disclosures[0]);
  return lines.join('\n');
}
