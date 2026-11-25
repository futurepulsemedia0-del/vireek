/**
 * Verified Resolution Network - public page (/network, no auth).
 * Live, aggregated, k-anonymous outcome data. Missing data is shown as "insufficient data";
 * no figure on this page is hard-coded.
 */

import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useSEO } from '@/lib/seo';
import {
  METRIC_LABELS, VRN_METRICS, fetchNetworkSummary, formatValue, industries, industryRows, platformCell, titleCase,
  type VrnSummary, type VrnWindow,
} from '@/lib/verifiedResolutionNetwork';

export function NetworkPage() {
  useSEO({
    title: 'Verified Resolution Network | Vireek',
    description: 'Aggregated, privacy-protected outcome benchmarks from real completed jobs. Only cohorts with enough businesses are shown.',
    canonical: '/network',
  });
  const [windowDays, setWindowDays] = useState<VrnWindow>(90);
  const [summary, setSummary] = useState<VrnSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setFailed(false);
    try { setSummary(await fetchNetworkSummary()); } catch { setFailed(true); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const inds = summary ? industries(summary, windowDays) : [];

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main id="main-content" className="mx-auto max-w-5xl space-y-10 px-4 py-12">
        <section className="space-y-3">
          <h1 className="text-3xl font-semibold text-text-primary">Verified Resolution Network</h1>
          <p className="max-w-3xl text-text-secondary">
            Outcomes measured from completed job records, combined across businesses. A number appears only when enough
            businesses contribute to it. Otherwise you will see &ldquo;insufficient data&rdquo; &mdash; never an estimate.
          </p>
          <div role="group" aria-label="Time window" className="flex gap-2">
            {([30, 90] as const).map((w) => (
              <Button key={w} size="sm" variant={windowDays === w ? 'primary' : 'secondary'} aria-pressed={windowDays === w} onClick={() => setWindowDays(w)}>
                {w} days
              </Button>
            ))}
          </div>
        </section>

        {loading && (
          <div className="grid gap-4 md:grid-cols-3" aria-busy="true" aria-label="Loading network data">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-40 w-full" />)}
          </div>
        )}

        {!loading && failed && (
          <EmptyState variant="load-failed" title="Network data is unavailable" description="Please try again in a moment." action={{ label: 'Retry', onClick: () => void load() }} />
        )}

        {!loading && !failed && summary && (
          <>
            <section className="space-y-4" aria-labelledby="platform-h">
              <h2 id="platform-h" className="text-xl font-semibold text-text-primary">Across the network</h2>
              <div className="grid gap-4 md:grid-cols-3">
                {VRN_METRICS.map((m) => {
                  const cell = platformCell(summary, m, windowDays);
                  return (
                    <Card key={m} padding="md" interactive={false} data-testid={`platform-${m}`}>
                      <h3 className="text-sm font-medium text-text-secondary">{METRIC_LABELS[m].title}</h3>
                      {cell.state === 'ok' ? (
                        <>
                          <p className="mt-2 text-3xl font-semibold text-text-primary">{formatValue(cell.row.p50, cell.row.unit)}</p>
                          <p className="text-sm text-text-secondary">
                            Typical range {formatValue(cell.row.p25, cell.row.unit)} to {formatValue(cell.row.p75, cell.row.unit)}
                          </p>
                          <p className="mt-2 text-xs text-text-muted">
                            Median across {cell.row.contributors} businesses{cell.stale ? ' · data may be out of date' : ''}
                          </p>
                        </>
                      ) : (
                        <p className="mt-3 text-sm text-text-secondary">Insufficient data: fewer than {summary.kThreshold} businesses contribute to this metric in this window.</p>
                      )}
                      <p className="mt-3 text-xs text-text-muted">{METRIC_LABELS[m].hint}</p>
                    </Card>
                  );
                })}
              </div>
            </section>

            <section className="space-y-4" aria-labelledby="industry-h">
              <h2 id="industry-h" className="text-xl font-semibold text-text-primary">By trade</h2>
              {inds.length === 0 ? (
                <EmptyState compact title="No trade has enough contributing businesses yet" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <caption className="sr-only">Median outcomes by trade, {windowDays}-day window</caption>
                    <thead>
                      <tr className="text-text-secondary">
                        <th scope="col" className="py-2 pr-4 font-medium">Trade</th>
                        {VRN_METRICS.map((m) => <th key={m} scope="col" className="py-2 pr-4 font-medium">{METRIC_LABELS[m].title}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {inds.map((ind) => {
                        const rows = industryRows(summary, ind, windowDays);
                        return (
                          <tr key={ind} className="border-t border-border">
                            <th scope="row" className="py-2 pr-4 font-medium text-text-primary">{titleCase(ind)}</th>
                            {VRN_METRICS.map((m) => {
                              const r = rows.find((x) => x.metric === m);
                              return <td key={m} className="py-2 pr-4 text-text-primary">{r ? `${formatValue(r.p50, r.unit)} (${r.contributors})` : <span className="text-text-secondary">Insufficient data</span>}</td>;
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-xs text-text-muted">Number in brackets = contributing businesses.</p>
            </section>
          </>
        )}

        <section className="space-y-3" aria-labelledby="method-h">
          <h2 id="method-h" className="flex items-center gap-2 text-xl font-semibold text-text-primary"><ShieldCheck className="h-5 w-5" aria-hidden="true" /> How this is measured</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm text-text-secondary">
            <li>A resolution counts as verified only when the job is completed, is not rework, is at least 14 days old and had no rework job within 14 days.</li>
            <li>Each business contributes one number per metric, and only with at least 5 samples.</li>
            <li>Groups are shown only when at least {summary?.kThreshold ?? 10} businesses contribute. No business, region or individual value is ever shown.</li>
            <li>Values are lightly adjusted with small random noise. This is a practical privacy measure, not a formal guarantee.</li>
          </ul>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </div>
  );
}
