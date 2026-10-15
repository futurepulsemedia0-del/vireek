import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Download, Lock } from 'lucide-react';
import { buildSnapshotPdf } from '@/lib/dashboardSnapshotPdf';
import { fetchPublicSnapshot, recordSnapshotView, type PublicSnapshot } from '@/lib/dashboardSnapshotData';
import { isValidShareToken, snapshotFilename, widgetTitle, type WidgetData } from '@/lib/dashboardSnapshot';

const fmt = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
};

/** Public, read-only, no login. Shows only the frozen aggregates the owner chose to share. */
export function SharedDashboardPage() {
  const { token } = useParams<{ token: string }>();
  const [snapshot, setSnapshot] = useState<PublicSnapshot | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow, noarchive';
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, []);

  useEffect(() => {
    if (!isValidShareToken(token)) {
      setState('unavailable');
      return;
    }
    let cancelled = false;
    fetchPublicSnapshot(token).then((s) => {
      if (cancelled) return;
      if (!s) {
        setState('unavailable');
        return;
      }
      setSnapshot(s);
      setState('ready');
      // One tracked view per browser session, so refreshing doesn't inflate the count.
      const k = `snapshot-viewed:${token.slice(0, 12)}`;
      try {
        if (!sessionStorage.getItem(k)) {
          sessionStorage.setItem(k, '1');
          void recordSnapshotView(token);
        }
      } catch {
        void recordSnapshotView(token);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state === 'loading') {
    return <main className="flex min-h-screen items-center justify-center bg-bg-primary text-sm text-text-secondary">Loading…</main>;
  }

  if (state === 'unavailable' || !snapshot) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-bg-primary p-6">
        <div className="max-w-sm text-center">
          <Lock className="mx-auto mb-3 text-text-secondary" size={28} />
          <h1 className="text-lg font-bold text-text-primary">This link is no longer available</h1>
          <p className="mt-1 text-sm text-text-secondary">It may have expired or been revoked. Ask the sender for a new link.</p>
        </div>
      </main>
    );
  }

  const { payload } = snapshot;
  const kpis = payload.widgets.filter((w): w is Extract<WidgetData, { kind: 'kpi' }> => w.kind === 'kpi');
  const others = payload.widgets.filter((w) => w.kind !== 'kpi');

  const download = () => {
    buildSnapshotPdf(snapshot, payload).save(snapshotFilename(snapshot.title));
  };

  return (
    <main className="min-h-screen bg-bg-primary px-4 py-8">
      <div className="mx-auto max-w-4xl">
        <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            {snapshot.businessName && <p className="text-sm font-semibold text-accent">{snapshot.businessName}</p>}
            <h1 className="text-2xl font-bold text-text-primary">{snapshot.title}</h1>
            <p className="mt-1 text-sm text-text-secondary">
              {snapshot.audience ? `Prepared for ${snapshot.audience} · ` : ''}
              {fmt(payload.period.start)} – {fmt(payload.period.end)} · Generated {fmt(payload.generatedAt)}
            </p>
          </div>
          <button
            type="button"
            onClick={download}
            className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-text-primary hover:border-accent hover:text-accent"
          >
            <Download size={14} /> Download PDF
          </button>
        </header>

        {kpis.length > 0 && (
          <section aria-label="Key figures" className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {kpis.map((k) => (
              <div key={k.key} className="rounded-xl border border-border bg-bg-secondary p-4">
                <p className="text-xs text-text-secondary">{widgetTitle(k.key)}</p>
                <p className="mt-1 text-2xl font-bold text-text-primary">{k.value}</p>
                {k.hint && <p className="mt-0.5 text-xs text-text-secondary">{k.hint}</p>}
              </div>
            ))}
          </section>
        )}

        <div className="space-y-4">
          {others.map((w) => (
            <section key={w.key} className="rounded-2xl border border-border bg-bg-secondary p-5">
              <h2 className="mb-3 text-sm font-semibold text-text-primary">{widgetTitle(w.key)}</h2>
              {w.kind === 'series' && <Bars points={w.points} />}
              {w.kind === 'table' && <DataTable columns={w.columns} rows={w.rows} />}
            </section>
          ))}
        </div>

        <p className="mt-8 text-center text-xs text-text-secondary">
          Read-only snapshot. Figures are frozen at the time of generation and may differ from live data.
          {snapshot.expiresAt ? ` This link expires ${fmt(snapshot.expiresAt)}.` : ''}
        </p>
      </div>
    </main>
  );
}

function Bars({ points }: { points: { label: string; value: number }[] }) {
  const max = Math.max(1, ...points.map((p) => p.value));
  return (
    <div>
      <div className="flex h-32 items-end gap-0.5" role="img" aria-label={`Bar chart, peak ${max}`}>
        {points.map((p, i) => (
          <div key={`${p.label}-${i}`} title={`${p.label}: ${p.value}`} className="flex-1 rounded-t bg-accent/80" style={{ height: `${Math.max(2, (p.value / max) * 100)}%` }} />
        ))}
      </div>
      {points.length > 0 && (
        <div className="mt-1 flex justify-between text-xs text-text-secondary">
          <span>{points[0].label}</span>
          <span>Peak {max}</span>
          <span>{points[points.length - 1].label}</span>
        </div>
      )}
    </div>
  );
}

function DataTable({ columns, rows }: { columns: string[]; rows: string[][] }) {
  if (rows.length === 0) return <p className="text-sm text-text-secondary">No data in this period.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs uppercase text-text-secondary">
            {columns.map((c) => (
              <th key={c} className="py-2 pr-4 font-medium">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border/50 text-text-primary">
              {r.map((cell, j) => (
                <td key={j} className="py-2 pr-4">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
