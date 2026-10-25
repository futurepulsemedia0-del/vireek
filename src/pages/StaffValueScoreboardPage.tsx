/**
 * Staff view — /staff/value-scoreboard (wrapped in <StaffRoute>)
 *
 * Anonymized, aggregated value across accounts (groups with fewer than 5 accounts are hidden by the
 * database), plus the short list of accounts whose owner explicitly consented to case-study use.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import {
  TYPE_LABELS, featureLabel, fetchStaffAggregates, fetchStaffCaseStudies, formatHours, formatMoney,
  type StaffAggregateRow, type StaffCaseStudyRow,
} from '@/lib/valueScoreboard';

const thisMonthUtc = () => new Date().toISOString().slice(0, 7);

export function StaffValueScoreboardPage() {
  const { toast } = useToast();
  const [month, setMonth] = useState(thisMonthUtc());
  const [loading, setLoading] = useState(true);
  const [agg, setAgg] = useState<StaffAggregateRow[]>([]);
  const [cases, setCases] = useState<StaffCaseStudyRow[]>([]);

  const load = useCallback(async () => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return;
    setLoading(true);
    try {
      const [a, c] = await Promise.all([fetchStaffAggregates(month), fetchStaffCaseStudies(month)]);
      setAgg(a);
      setCases(c);
    } catch {
      toast('Could not load value data.', 'error');
    } finally {
      setLoading(false);
    }
  }, [month, toast]);

  useEffect(() => { void load(); }, [load]);

  const fmt = (r: StaffAggregateRow) => (r.value_type === 'saved_hours' ? formatHours(r.total) : formatMoney(r.total, r.ccy ?? 'USD'));

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-8 sm:px-6">
      <header className="space-y-2">
        <Link to="/staff" className="text-sm text-accent hover:underline">← Staff</Link>
        <h1 className="text-2xl font-bold text-text-primary">Value Scoreboard (staff)</h1>
        <p className="max-w-2xl text-sm text-text-secondary">
          Aggregates are anonymized and hide any group with fewer than 5 accounts. Months are UTC calendar months. Individual accounts appear below only if the owner consented to case-study use. Public marketing numbers are out of scope.
        </p>
        <div className="flex items-center gap-3 pt-2">
          <label htmlFor="sv-month" className="text-sm font-medium text-text-primary">Month</label>
          <input id="sv-month" type="month" value={month} max={thisMonthUtc()} onChange={(e) => setMonth(e.target.value)} className="rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary" />
          <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>{loading ? <Loader2 size={16} className="animate-spin" /> : null} Refresh</Button>
        </div>
      </header>

      <Card>
        <h2 className="mb-3 text-lg font-semibold text-text-primary">Anonymized aggregates</h2>
        {agg.length === 0 ? (
          <p className="text-sm text-text-secondary">{loading ? 'Loading…' : 'No group has 5 or more accounts for this month.'}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <thead className="text-xs text-text-secondary"><tr><th className="py-2 pr-3 font-medium">Feature</th><th className="py-2 pr-3 font-medium">Type</th><th className="py-2 pr-3 font-medium">Basis</th><th className="py-2 pr-3 text-right font-medium">Accounts</th><th className="py-2 pr-3 text-right font-medium">Items</th><th className="py-2 text-right font-medium">Total</th></tr></thead>
              <tbody>
                {agg.map((r) => (
                  <tr key={`${r.feature}|${r.value_type}|${r.conf}|${r.ccy ?? ''}`} className="border-t border-border/70">
                    <td className="py-2.5 pr-3 text-text-primary">{featureLabel(r.feature)}</td>
                    <td className="py-2.5 pr-3 text-text-secondary">{TYPE_LABELS[r.value_type as keyof typeof TYPE_LABELS] ?? r.value_type}</td>
                    <td className="py-2.5 pr-3 text-text-secondary">{r.conf === 'measured' ? 'Measured' : 'Estimated'}</td>
                    <td className="py-2.5 pr-3 text-right">{r.accounts}</td>
                    <td className="py-2.5 pr-3 text-right">{r.events}</td>
                    <td className="py-2.5 text-right font-semibold text-text-primary">{fmt(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <h2 className="mb-1 text-lg font-semibold text-text-primary">Case-study candidates (owner consented)</h2>
        <p className="mb-3 text-xs text-text-secondary">Use only the measured figures publicly, and only for accounts listed here.</p>
        {cases.length === 0 ? (
          <p className="text-sm text-text-secondary">{loading ? 'Loading…' : 'No consenting account has results this month.'}</p>
        ) : (
          <ul className="divide-y divide-border/70">
            {cases.map((c) => (
              <li key={`${c.account_id}|${c.ccy ?? ''}`} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <div><p className="font-medium text-text-primary">{c.company}</p><p className="text-xs text-text-secondary">Consented {new Date(c.consented_at).toLocaleDateString()}</p></div>
                <p className="text-right text-text-secondary">
                  <span className="font-semibold text-text-primary">{formatMoney(c.measured_cents, c.ccy ?? 'USD')}</span> measured · {formatMoney(c.estimated_cents, c.ccy ?? 'USD')} estimated · {formatHours(c.saved_minutes)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
