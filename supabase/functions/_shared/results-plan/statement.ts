// Results Plan — itemized statement + pay-vs-value summary (pure).

export interface StatementLine {
  chargeId: string;
  jobId: string;
  verifiedAt: string; // ISO
  customerLabel: string;
  jobType: string | null;
  ruleVersion: string;
  amountCents: number;
  listPriceCents: number;
  status: 'pending' | 'posted' | 'voided' | 'credited' | 'failed';
  estimatedRevenueCents: number | null;
}

export interface Summary {
  verifiedJobs: number;
  billedCents: number;
  creditedCents: number;
  waivedByCapsCents: number;
  netCents: number;
  effectiveCostPerJobCents: number | null;
  estimatedRevenueCents: number;
  revenueFormula: string;
  valueMultiple: number | null;
}

export function summarize(lines: readonly StatementLine[], baseFeeCents: number, avgTicketCents: number | null, closeRateBp: number | null): Summary {
  const counted = lines.filter((l) => l.status === 'posted' || l.status === 'pending' || l.status === 'credited');
  const billed = counted.filter((l) => l.status !== 'credited').reduce((s, l) => s + l.amountCents, 0);
  const credited = lines.filter((l) => l.status === 'credited').reduce((s, l) => s + l.amountCents, 0);
  const waived = lines.reduce((s, l) => s + Math.max(0, l.listPriceCents - l.amountCents), 0);
  const jobs = counted.filter((l) => l.status !== 'credited').length;
  let rev = 0;
  let formula = 'Estimated revenue = sum of invoice amounts on verified jobs where known';
  const known = counted.filter((l) => l.status !== 'credited' && l.estimatedRevenueCents !== null);
  rev = known.reduce((s, l) => s + (l.estimatedRevenueCents ?? 0), 0);
  const unknown = counted.filter((l) => l.status !== 'credited' && l.estimatedRevenueCents === null).length;
  if (unknown > 0 && avgTicketCents !== null && avgTicketCents > 0) {
    rev += unknown * avgTicketCents;
    formula += `; plus ${unknown} job(s) without an invoice × your average ticket`;
  }
  const net = billed + baseFeeCents;
  return {
    verifiedJobs: jobs,
    billedCents: billed,
    creditedCents: credited,
    waivedByCapsCents: waived,
    netCents: net,
    effectiveCostPerJobCents: jobs > 0 ? Math.round(net / jobs) : null,
    estimatedRevenueCents: rev,
    revenueFormula: formula,
    valueMultiple: net > 0 && rev > 0 ? Math.round((rev / net) * 10) / 10 : null,
  };
}

/** CSV-injection safe cell: neutralizes =,+,-,@, tab, CR prefixes and escapes quotes. */
export function csvCell(v: string | number | null): string {
  if (v === null) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const money = (c: number) => (c / 100).toFixed(2);

export function statementCsv(lines: readonly StatementLine[], currency: string): string {
  const head = ['charge_id', 'job_id', 'verified_at', 'customer', 'job_type', 'rule_version', 'status', `list_price_${currency}`, `charged_${currency}`];
  const rows = lines.map((l) => [l.chargeId, l.jobId, l.verifiedAt, l.customerLabel, l.jobType, l.ruleVersion, l.status, money(l.listPriceCents), money(l.amountCents)].map(csvCell).join(','));
  return [head.join(','), ...rows].join('\r\n') + '\r\n';
}
