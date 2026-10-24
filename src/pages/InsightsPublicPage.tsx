/**
 * Vireek Insights - /insights (public).
 * National, k-anonymous quarterly indexes by trade. State-level data is for
 * contributing businesses and API subscribers only. All privacy rules live in
 * the database; this page only renders what insights_public_indexes() returns.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, BarChart3, Code2, Download, FileText, Lock, ShieldCheck, Users } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useSEO } from '@/lib/seo';
import { EASE } from '@/lib/motion';
import {
  METRIC_META,
  METRIC_ORDER,
  changeTone,
  contributorBandLabel,
  formatChange,
  formatInsightValue,
  groupByTrade,
  periodLabelHuman,
  rangePosition,
  tradeLabel,
  type InsightCell,
  type InsightPeriod,
} from '@/lib/insights';
import { fetchInsightPeriods, fetchPublicIndexes } from '@/lib/insightsApi';
import { downloadInsightsCsv, downloadInsightsReportPdf } from '@/lib/insightsReport';

const TONE_CLASS = { good: 'text-success-500', bad: 'text-danger', neutral: 'text-text-secondary' } as const;

function RangeBar({ cell }: { cell: InsightCell }) {
  return (
    <div
      className="relative mt-2 h-1.5 rounded-full bg-bg-tertiary"
      role="img"
      aria-label={`Middle half of businesses: ${formatInsightValue(cell.unit, cell.p25)} to ${formatInsightValue(cell.unit, cell.p75)}`}
    >
      <div className="absolute top-0 h-1.5 rounded-full bg-accent/25" style={{ left: '0%', width: '100%' }} />
      <div
        className="absolute top-1/2 h-3 w-1 -translate-y-1/2 rounded bg-accent"
        style={{ left: `${rangePosition(cell.p50, cell.p25, cell.p75)}%` }}
      />
    </div>
  );
}

function MetricCard({ cell }: { cell: InsightCell }) {
  const tone = changeTone(cell.direction, cell.qoq_change_pct);
  return (
    <Card className="!p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{METRIC_META[cell.metric].label}</p>
      <p className="mt-2 text-3xl font-extrabold text-text-primary">{formatInsightValue(cell.unit, cell.p50)}</p>
      <p className="mt-1 text-xs text-text-secondary">
        Middle half: {formatInsightValue(cell.unit, cell.p25)} - {formatInsightValue(cell.unit, cell.p75)}
      </p>
      <RangeBar cell={cell} />
      <div className="mt-3 flex items-center justify-between text-xs">
        <span className={`font-semibold ${TONE_CLASS[tone]}`}>
          {cell.metric === 'demand_index' ? 'vs prior quarter' : `${formatChange(cell.qoq_change_pct)} vs last quarter`}
        </span>
        <span className="text-text-secondary">{contributorBandLabel(cell.contributor_band)}</span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-text-secondary">{METRIC_META[cell.metric].description}</p>
    </Card>
  );
}

export function InsightsPublicPage() {
  useSEO({
    title: 'Vireek Insights | Home-service industry indexes',
    description:
      'Quarterly, privacy-safe industry indexes for home-service businesses: average ticket, close rate, lead response time and demand by trade. Built only from businesses that opted in.',
    canonical: 'https://vireek.com/insights',
  });

  const [periods, setPeriods] = useState<InsightPeriod[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [cells, setCells] = useState<InsightCell[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (period?: string) => {
    setLoading(true);
    setError(false);
    try {
      const list = period ? null : await fetchInsightPeriods();
      if (list) {
        setPeriods(list);
        period = list[0]?.period_label;
      }
      if (!period) {
        setCells([]);
        setSelected(null);
        return;
      }
      const data = await fetchPublicIndexes(period);
      setCells(data);
      setSelected(period);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => groupByTrade(cells), [cells]);
  const headline = groups.find((g) => g.trade === 'all');
  const trades = groups.filter((g) => g.trade !== 'all');
  const period = periods.find((p) => p.period_label === selected) ?? null;

  const onPdf = async () => {
    if (!period) return;
    setBusy(true);
    try {
      await downloadInsightsReportPdf(period, cells);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-20 sm:pt-24">
        <section className="relative bg-gradient-mesh bg-noise px-5 py-16 sm:px-6 sm:py-20">
          <div className="mx-auto max-w-3xl text-center">
            <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }}>
              <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-1.5 text-sm font-semibold text-text-secondary">
                <BarChart3 className="h-4 w-4 text-accent" />
                Vireek Insights
              </div>
              <h1 className="text-balance text-3xl font-extrabold tracking-tight text-text-primary sm:text-5xl">
                The home-service industry, measured
              </h1>
              <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-text-secondary sm:text-lg">
                Quarterly indexes for average ticket, close rate, lead response time and demand by trade. Built only from businesses that
                chose to share, and only published when no business can be picked out.
              </p>
            </motion.div>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-5 py-12 sm:px-6">
          {loading ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-44 animate-pulse rounded-2xl bg-bg-tertiary" />
              ))}
            </div>
          ) : error ? (
            <div className="rounded-2xl border border-dashed border-border py-12 text-center">
              <p className="text-sm text-text-secondary">We could not load the indexes right now.</p>
              <Button variant="secondary" size="sm" className="mt-4" onClick={() => void load(selected ?? undefined)}>
                Try again
              </Button>
            </div>
          ) : !period ? (
            <div className="rounded-2xl border border-dashed border-border py-14 text-center">
              <Lock className="mx-auto mb-3 h-6 w-6 text-text-secondary/60" />
              <p className="mx-auto max-w-md text-sm leading-relaxed text-text-secondary">
                The first report is published after a quarter closes and passes our privacy review. Nothing is released until enough
                businesses contribute.
              </p>
            </div>
          ) : (
            <>
              <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-2xl font-bold text-text-primary">{periodLabelHuman(period.period_label)}</h2>
                  <p className="mt-1 flex items-center gap-1.5 text-sm text-text-secondary">
                    <Users className="h-4 w-4" />
                    {period.contributors_rounded}+ contributing businesses, United States
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {periods.length > 1 && (
                    <select
                      value={selected ?? ''}
                      onChange={(e) => void load(e.target.value)}
                      aria-label="Quarter"
                      className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-secondary"
                    >
                      {periods.map((p) => (
                        <option key={p.period_label} value={p.period_label}>
                          {periodLabelHuman(p.period_label)}
                        </option>
                      ))}
                    </select>
                  )}
                  <Button size="sm" onClick={() => void onPdf()} disabled={busy}>
                    <FileText className="h-4 w-4" /> Quarterly report (PDF)
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => downloadInsightsCsv(cells, period.period_label)}>
                    <Download className="h-4 w-4" /> CSV
                  </Button>
                </div>
              </div>

              {headline && (
                <div className="mb-10">
                  <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-text-secondary">All trades</h3>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {METRIC_ORDER.map((m) => headline.metrics[m] && <MetricCard key={m} cell={headline.metrics[m] as InsightCell} />)}
                  </div>
                </div>
              )}

              {trades.length > 0 && (
                <div>
                  <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-text-secondary">By trade (median)</h3>
                  <div className="overflow-x-auto rounded-2xl border border-border">
                    <table className="w-full min-w-[640px] text-left text-sm">
                      <thead className="bg-bg-tertiary text-xs uppercase tracking-wide text-text-secondary">
                        <tr>
                          <th className="px-4 py-3 font-semibold">Trade</th>
                          {METRIC_ORDER.map((m) => (
                            <th key={m} className="px-4 py-3 font-semibold">
                              {METRIC_META[m].label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {trades.map((g) => (
                          <tr key={g.trade} className="border-t border-border">
                            <td className="px-4 py-3 font-semibold text-text-primary">{tradeLabel(g.trade)}</td>
                            {METRIC_ORDER.map((m) => {
                              const c = g.metrics[m];
                              return (
                                <td key={m} className="px-4 py-3 text-text-primary">
                                  {c ? (
                                    <>
                                      {formatInsightValue(c.unit, c.p50)}
                                      {m !== 'demand_index' && c.qoq_change_pct !== null && (
                                        <span className={`ml-1.5 text-xs ${TONE_CLASS[changeTone(c.direction, c.qoq_change_pct)]}`}>
                                          {formatChange(c.qoq_change_pct)}
                                        </span>
                                      )}
                                    </>
                                  ) : (
                                    <span className="text-text-secondary">-</span>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-2 text-xs text-text-secondary">A dash means too few businesses to publish safely.</p>
                </div>
              )}
            </>
          )}
        </section>

        <section className="border-t border-border bg-bg-secondary/40 px-5 py-14 sm:px-6">
          <div className="mx-auto grid max-w-5xl gap-6 md:grid-cols-3">
            <Card className="!p-6">
              <ShieldCheck className="h-6 w-6 text-accent" />
              <h3 className="mt-3 text-lg font-bold text-text-primary">Privacy by construction</h3>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                Opt-in only. Every figure needs at least 10 businesses with varied results. We publish percentiles, never raw rows, add
                small stable noise, and show only banded counts. Published quarters can never be edited.
              </p>
            </Card>
            <Card className="!p-6">
              <Users className="h-6 w-6 text-accent" />
              <h3 className="mt-3 text-lg font-bold text-text-primary">Share data, see more</h3>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                Vireek customers who opt in get state-level indexes inside their dashboard.
              </p>
              <Link to="/dashboard/insights" className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-accent">
                Open Insights settings <ArrowRight className="h-4 w-4" />
              </Link>
            </Card>
            <Card className="!p-6">
              <Code2 className="h-6 w-6 text-accent" />
              <h3 className="mt-3 text-lg font-bold text-text-primary">API for subscribers</h3>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                State-level history, CSV and JSON endpoints with per-key rate limits for analysts, lenders and manufacturers.
              </p>
              <Link to="/contact" className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-accent">
                Request API access <ArrowRight className="h-4 w-4" />
              </Link>
            </Card>
          </div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
