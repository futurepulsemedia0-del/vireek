// supabase/functions/_shared/fraud/report.ts
// Pure weekly-report builder (rows in, text out) so it is unit-tested and reused by fraud-admin + fraud-sweep.

export interface ReportInput {
  from: string;
  to: string;
  denied: Array<{ code: string; country: string | null }>;
  anomalies: Array<{ code: string }>;
  otpBlocked: number;
  signupBlocked: number;
  statusChanges: Array<{ code: string }>;
  openCases: number;
  suspendedOrgs: number;
  reservedCents: number;
}

function top(rows: Array<string | null>, n = 5): string {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r ?? "n/a", (m.get(r ?? "n/a") ?? 0) + 1);
  const out = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}: ${v}`);
  return out.length ? out.join(", ") : "none";
}

export function buildWeeklyReport(i: ReportInput): string {
  return [
    `Fraud & abuse report ${i.from.slice(0, 10)} to ${i.to.slice(0, 10)}`,
    `Blocked outbound attempts: ${i.denied.length} (top reasons: ${top(i.denied.map((d) => d.code))})`,
    `Top blocked destinations: ${top(i.denied.map((d) => d.country))}`,
    `Anomaly signals: ${i.anomalies.length} (${top(i.anomalies.map((a) => a.code))})`,
    `SMS codes dropped: ${i.otpBlocked}; signups blocked: ${i.signupBlocked}`,
    `Account actions: ${i.statusChanges.length} (${top(i.statusChanges.map((s) => s.code))})`,
    `Open cases: ${i.openCases}; suspended accounts now: ${i.suspendedOrgs}`,
    `Worst-case spend reserved this period: $${(i.reservedCents / 100).toFixed(2)}`,
  ].join("\n");
}
