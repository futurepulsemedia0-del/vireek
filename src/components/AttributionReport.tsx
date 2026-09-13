export const SOURCE_LABELS: Record<string, string> = {
  google_ads: 'Google Ads',
  facebook_ads: 'Facebook/Instagram Ads',
  referral: 'Referral',
  organic: 'Organic / Website',
  direct: 'Direct Call',
  other: 'Other',
  unknown: 'Unknown',
};

export interface AttributionRow {
  source: string;
  total: number;
  booked: number;
  rate: number;
}

export function AttributionReport({ rows }: { rows: AttributionRow[] }) {
  if (rows.length === 0) return null;
  const maxBooked = Math.max(...rows.map((r) => r.booked), 1);

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      <h3 className="text-sm font-semibold text-text-primary">Lead source attribution</h3>
      <p className="mt-0.5 text-xs text-text-secondary">Which channels bring booked jobs</p>
      <div className="mt-4 space-y-3">
        {rows.map((r) => (
          <div key={r.source}>
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-text-primary">{SOURCE_LABELS[r.source] ?? r.source}</span>
              <span className="text-text-secondary">
                {r.booked} booked · {r.total} calls · {r.rate}%
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary">
              <div
                className="h-full rounded-full bg-accent transition-all"
                style={{ width: `${(r.booked / maxBooked) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
