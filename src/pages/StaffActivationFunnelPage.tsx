/**
 * Staff view — /staff/activation (wrapped in <StaffRoute>). Time-to-first-value funnel: how many new owners reach each
 * milestone and the median minutes from signup. Aggregates only (no account ids, no PII). Source: activation_events.
 */
import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { FUNNEL_LABELS, fetchActivationFunnel, formatMinutes, type FunnelRow } from '@/lib/activation';

const RANGES = [7, 30, 90] as const;

export function StaffActivationFunnelPage() {
  const [days, setDays] = useState<number>(30);
  const [rows, setRows] = useState<FunnelRow[] | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setState('loading');
    try { setRows(await fetchActivationFunnel(days)); setState('ready'); }
    catch (e) { setMsg(e instanceof Error ? e.message : 'Could not load.'); setState('error'); }
  }, [days]);
  useEffect(() => { void load(); }, [load]);

  const signups = rows?.[0]?.accounts ?? 0;

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6" aria-busy={state === 'loading'}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Activation funnel</h1>
          <p className="text-sm text-text-secondary">Platform staff only. New owners who signed up in the selected window, and how far they got.</p>
        </div>
        <div role="group" aria-label="Time window" className="flex gap-2">
          {RANGES.map((d) => (
            <Button key={d} variant={d === days ? 'primary' : 'secondary'} size="sm" aria-pressed={d === days} onClick={() => setDays(d)}>{d} days</Button>
          ))}
        </div>
      </header>

      {state === 'error' && (
        <Card><div role="alert" className="space-y-3 p-4"><p className="text-sm">{msg}</p><Button onClick={() => void load()}>Try again</Button></div></Card>
      )}
      {state === 'loading' && <Card><p className="p-4 text-sm text-text-secondary" role="status">Loading…</p></Card>}
      {state === 'ready' && rows && signups === 0 && (
        <Card><div className="space-y-2 p-4"><p className="font-medium">No signups in the last {days} days.</p><p className="text-sm text-text-secondary">Try a longer window.</p><Button variant="secondary" onClick={() => setDays(90)}>Show 90 days</Button></div></Card>
      )}
      {state === 'ready' && rows && signups > 0 && (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Activation funnel for the last {days} days</caption>
              <thead><tr className="text-left text-text-secondary"><th scope="col" className="p-3">Milestone</th><th scope="col" className="p-3 text-right">Accounts</th><th scope="col" className="p-3 text-right">% of signups</th><th scope="col" className="p-3 text-right">Median time from signup</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.event} className="border-t">
                    <th scope="row" className="p-3 font-medium">{FUNNEL_LABELS[r.event]}</th>
                    <td className="p-3 text-right tabular-nums">{r.accounts}</td>
                    <td className="p-3 text-right tabular-nums">{r.pctOfSignups}%</td>
                    <td className="p-3 text-right tabular-nums">{r.event === 'signup' ? '—' : formatMinutes(r.medianMinutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="border-t p-3 text-xs text-text-secondary">“First call logged” counts the first row in the calls table and may include test calls (unverified). Medians are computed only over accounts that reached the milestone.</p>
        </Card>
      )}
    </main>
  );
}
