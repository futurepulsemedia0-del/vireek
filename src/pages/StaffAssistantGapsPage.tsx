/**
 * Staff view — /staff/assistant-gaps (wrapped in <StaffRoute>)
 * Privacy-safe knowledge gaps for the public "Ask Vireek" assistant: redacted questions that
 * had no grounded answer or got a thumbs-down. Data comes from staff-only RPCs.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { useToast } from '@/contexts/ToastContext';
import { fetchAssistantGaps, fetchAssistantStats, type AssistantGap, type AssistantStats } from '@/lib/siteAssistantAdmin';

export function StaffAssistantGapsPage() {
  const { toast } = useToast();
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [gaps, setGaps] = useState<AssistantGap[]>([]);
  const [stats, setStats] = useState<AssistantStats | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [g, s] = await Promise.all([fetchAssistantGaps(days), fetchAssistantStats(days)]);
      setGaps(g);
      setStats(s);
    } catch {
      toast('Could not load assistant data.', 'error');
    } finally {
      setLoading(false);
    }
  }, [days, toast]);

  useEffect(() => { void load(); }, [load]);

  const stat = (label: string, value: string | number | null | undefined) => (
    <Card className="p-4">
      <p className="text-xs text-text-secondary">{label}</p>
      <p className="mt-1 text-xl font-semibold text-text-primary">{value ?? '—'}</p>
    </Card>
  );

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-8 sm:px-6">
      <header className="space-y-2">
        <Link to="/staff" className="text-sm text-accent hover:underline">← Staff</Link>
        <h1 className="text-2xl font-bold text-text-primary">Ask Vireek — knowledge gaps (staff)</h1>
        <p className="max-w-2xl text-sm text-text-secondary">
          Questions the public assistant could not ground in the knowledge base, or that got a thumbs-down. Text is PII-redacted; no IPs or user ids are stored.
          Fix a gap by adding a verified doc under <code>knowledge/</code> and running <code>npm run knowledge:build</code> then <code>knowledge:embed</code>.
        </p>
        <label className="text-sm text-text-secondary">
          Window{' '}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="focus-ring rounded-lg border border-border bg-bg-primary px-2 py-1">
            {[7, 30, 90, 180].map((d) => <option key={d} value={d}>{d} days</option>)}
          </select>
        </label>
      </header>

      {loading ? (
        <div className="flex items-center gap-2 text-text-secondary"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {stat('Questions', stats?.total)}
            {stat('Grounded %', stats?.grounded_pct)}
            {stat('👍 / 👎', stats ? `${stats.thumbs_up} / ${stats.thumbs_down}` : null)}
            {stat('Human hand-offs', stats?.handoffs)}
            {stat('Cached %', stats?.cached_pct)}
            {stat('First token p50 / p95 (ms)', stats ? `${stats.p50_first_token_ms ?? '—'} / ${stats.p95_first_token_ms ?? '—'}` : null)}
            {stat('Total latency p50 / p95 (ms)', stats ? `${stats.p50_latency_ms ?? '—'} / ${stats.p95_latency_ms ?? '—'}` : null)}
          </section>

          <section className="overflow-x-auto">
            {gaps.length === 0 ? (
              <p className="text-sm text-text-secondary">No gaps in this window.</p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-text-secondary">
                  <tr><th className="py-2 pe-3">Question (redacted)</th><th className="pe-3">Intent</th><th className="pe-3">Asked</th><th className="pe-3">👎</th><th className="pe-3">Ungrounded</th><th>Last seen</th></tr>
                </thead>
                <tbody>
                  {gaps.map((g) => (
                    <tr key={`${g.question}|${g.intent}`} className="border-t border-border/60 align-top">
                      <td className="py-2 pe-3 text-text-primary" dir="auto">{g.question}</td>
                      <td className="pe-3">{g.intent}</td>
                      <td className="pe-3">{g.occurrences}</td>
                      <td className="pe-3">{g.thumbs_down}</td>
                      <td className="pe-3">{g.ungrounded}</td>
                      <td>{new Date(g.last_seen).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
