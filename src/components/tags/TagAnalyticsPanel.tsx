import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { getTagAnalytics, tagErrorMessage, formatTagToken, type TagAnalytics } from '@/lib/vireekTag';

const RANGES = [7, 30, 90] as const;
const card = 'rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark';

function Stat({ label, value, hint, tone = 'neutral' }: { label: string; value: string | number; hint?: string; tone?: 'neutral' | 'warn' }) {
  return (
    <div className={card}>
      <p className="text-xs text-text-secondary">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${tone === 'warn' && Number(value) > 0 ? 'text-warning-500' : 'text-text-primary'}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-text-secondary">{hint}</p>}
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: { key: string; count: number }[] }) {
  const total = rows.reduce((s, r) => s + r.count, 0) || 1;
  return (
    <div className={card}>
      <h3 className="mb-2 text-sm font-semibold text-text-primary">{title}</h3>
      {rows.length === 0 ? <p className="text-xs text-text-secondary">No data yet.</p> : (
        <ul className="space-y-1.5">
          {rows.map((r) => (
            <li key={r.key} className="text-xs text-text-secondary">
              <div className="flex justify-between"><span className="capitalize">{r.key}</span><span>{r.count} · {Math.round((r.count / total) * 100)}%</span></div>
              <div className="mt-0.5 h-1.5 rounded bg-bg-tertiary"><div className="h-1.5 rounded bg-accent" style={{ width: `${(r.count / total) * 100}%` }} /></div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TagAnalyticsPanel() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [data, setData] = useState<TagAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    getTagAnalytics(days)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(tagErrorMessage(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [days]);

  if (error) return <p role="alert" className="rounded-xl border border-border bg-bg-secondary p-4 text-sm text-danger-500">{error}</p>;
  if (loading || !data) return <div className="h-64 animate-pulse rounded-2xl bg-bg-secondary" aria-busy="true" />;

  const t = data.totals;
  const max = Math.max(1, ...data.by_day.map((d) => d.scans));
  const conversion = t.scans > 0 ? Math.round((t.requests / t.scans) * 1000) / 10 : 0;

  return (
    <div className="space-y-4">
      <div className="flex gap-2" role="group" aria-label="Date range">
        {RANGES.map((r) => (
          <button key={r} type="button" onClick={() => setDays(r)} aria-pressed={days === r}
            className={`focus-ring rounded-lg border px-3 py-1.5 text-xs font-medium ${days === r ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary'}`}>
            Last {r} days
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Scans" value={t.scans} hint={`${t.unique_visitors} unique visitors`} />
        <Stat label="Service requests" value={t.requests} hint={`${conversion}% of scans`} />
        <Stat label="Warranty clicks" value={t.register_clicks} />
        <Stat label="Manual clicks" value={t.manual_clicks} />
        <Stat label="Team scans" value={t.team_scans} />
        <Stat label="Retired-tag scans" value={t.stale_scans} tone="warn" hint="Old stickers still in use" />
        <Stat label="Tamper reports" value={t.tamper_reports} tone="warn" />
        <Stat label="Active, never scanned" value={data.inventory.active_never_scanned} hint={`${data.inventory.active} active tags`} />
      </div>

      <div className={card}>
        <h3 className="mb-3 text-sm font-semibold text-text-primary">Scans per day</h3>
        <div className="flex h-28 items-end gap-0.5" role="img" aria-label={`Scans per day over the last ${data.range_days} days`}>
          {data.by_day.map((d) => (
            <div key={d.day} title={`${d.day}: ${d.scans}`} className="flex-1 rounded-t bg-accent/70" style={{ height: `${Math.max(d.scans > 0 ? 4 : 1, (d.scans / max) * 100)}%` }} />
          ))}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Breakdown title="Source" rows={data.by_source} />
        <Breakdown title="Device" rows={data.by_device} />
        <div className={card}>
          <h3 className="mb-2 text-sm font-semibold text-text-primary">Most scanned machines</h3>
          {data.top_tags.length === 0 ? <p className="text-xs text-text-secondary">No scans yet.</p> : (
            <ol className="space-y-1 text-xs text-text-secondary">
              {data.top_tags.map((x) => (
                <li key={x.tag_id} className="flex justify-between gap-2"><span className="truncate" title={formatTagToken(x.token)}>{x.label ?? formatTagToken(x.token)}</span><span className="font-semibold text-text-primary">{x.scans}</span></li>
              ))}
            </ol>
          )}
        </div>
      </div>

      {(t.stale_scans > 0 || t.tamper_reports > 0) && (
        <p className="flex items-start gap-2 rounded-xl bg-warning-500/10 p-3 text-xs text-text-primary">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" />
          Retired stickers are still being scanned or customers reported a problem. Check the Inventory tab for tags with reports and replace those stickers.
        </p>
      )}
    </div>
  );
}
