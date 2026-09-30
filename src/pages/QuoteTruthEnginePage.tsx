import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { FileText, Scale, Trash2 } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCard } from '@/components/Skeleton';
import { QuoteTruthPanel } from '@/components/quotes/QuoteTruthReport';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import { calculateQuoteTotals } from '@/lib/quotes';
import type { QuoteLineItem } from '@/lib/quotes';
import {
  DEFAULT_TRUTH_SETTINGS,
  EMPTY_BENCHMARK_FORM,
  RISK_LEVEL_META,
  VERDICT_META,
  addCompetitorBenchmark,
  deleteCompetitorBenchmark,
  fetchCompetitorBenchmarks,
  fetchRecentTruthAnalyses,
  fetchTruthSettings,
  formatPct,
  formatUsd,
  saveTruthSettings,
} from '@/lib/quoteTruth';
import type {
  CompetitorBenchmarkForm,
  CompetitorBenchmarkRow,
  RiskLevel,
  TruthAnalysisRow,
  TruthSettings,
  TruthVerdict,
} from '@/lib/quoteTruth';

interface PickerQuote {
  id: string;
  customer_name: string;
  status: string;
  line_items: QuoteLineItem[];
  tax_percent: number;
  created_at: string;
  truth_verdict: TruthVerdict | null;
  truth_rejection_probability: number | null;
  truth_overcharge_level: RiskLevel | null;
}

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent';

const sectionClass = 'mb-8 rounded-2xl border border-border bg-bg-secondary p-5';

export function QuoteTruthEnginePage() {
  const { user, isOwner } = useAuth();
  const { toast } = useToast();
  const pickerId = useId();

  const [quotes, setQuotes] = useState<PickerQuote[]>([]);
  const [quotesLoading, setQuotesLoading] = useState(true);
  const [selectedId, setSelectedId] = useState('');

  const [analyses, setAnalyses] = useState<TruthAnalysisRow[]>([]);
  const [analysesLoading, setAnalysesLoading] = useState(true);

  const [settings, setSettings] = useState<TruthSettings>(DEFAULT_TRUTH_SETTINGS);
  const [regionIndex, setRegionIndex] = useState('1');
  const [maxPremium, setMaxPremium] = useState('12');
  const [regionLabel, setRegionLabel] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);

  const [benchmarks, setBenchmarks] = useState<CompetitorBenchmarkRow[]>([]);
  const [benchForm, setBenchForm] = useState<CompetitorBenchmarkForm>(EMPTY_BENCHMARK_FORM);
  const [savingBench, setSavingBench] = useState(false);

  const loadQuotes = useCallback(async () => {
    setQuotesLoading(true);
    const { data, error } = await supabase
      .from('quotes')
      .select('id, customer_name, status, line_items, tax_percent, created_at, truth_verdict, truth_rejection_probability, truth_overcharge_level')
      .in('status', ['draft', 'sent'])
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) toast('Could not load your quotes.', 'error');
    setQuotes((data as unknown as PickerQuote[]) ?? []);
    setQuotesLoading(false);
  }, [toast]);

  const loadAnalyses = useCallback(async () => {
    setAnalysesLoading(true);
    try {
      setAnalyses(await fetchRecentTruthAnalyses(50));
    } catch {
      // Team members without billing access get an empty list from RLS; a hard error is rare and non-fatal here.
      setAnalyses([]);
    }
    setAnalysesLoading(false);
  }, []);

  const loadTuning = useCallback(async () => {
    try {
      const [s, b] = await Promise.all([fetchTruthSettings(), fetchCompetitorBenchmarks()]);
      setSettings(s);
      setRegionIndex(String(s.regional_price_index));
      setMaxPremium(String(s.max_premium_pct));
      setRegionLabel(s.region_label ?? '');
      setBenchmarks(b);
    } catch {
      toast('Could not load Truth Engine settings.', 'error');
    }
  }, [toast]);

  useEffect(() => {
    loadQuotes();
    loadAnalyses();
    loadTuning();
  }, [loadQuotes, loadAnalyses, loadTuning]);

  const selected = useMemo(() => quotes.find((q) => q.id === selectedId) ?? null, [quotes, selectedId]);

  const handleSaveSettings = async () => {
    if (!user) return;
    setSavingSettings(true);
    try {
      const next: TruthSettings = {
        region_label: regionLabel,
        regional_price_index: Number(regionIndex),
        max_premium_pct: Number(maxPremium),
      };
      await saveTruthSettings(user.id, next);
      setSettings({ ...next, region_label: regionLabel.trim() || null });
      toast('Truth Engine settings saved.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save settings.', 'error');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleAddBenchmark = async () => {
    if (!user) return;
    setSavingBench(true);
    try {
      await addCompetitorBenchmark(user.id, benchForm);
      setBenchForm(EMPTY_BENCHMARK_FORM);
      setBenchmarks(await fetchCompetitorBenchmarks());
      toast('Benchmark added.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not add the benchmark.', 'error');
    } finally {
      setSavingBench(false);
    }
  };

  const handleDeleteBenchmark = async (id: string) => {
    try {
      await deleteCompetitorBenchmark(id);
      setBenchmarks((prev) => prev.filter((b) => b.id !== id));
    } catch {
      toast('Could not delete the benchmark.', 'error');
    }
  };

  const settingsDirty =
    Number(regionIndex) !== settings.regional_price_index ||
    Number(maxPremium) !== settings.max_premium_pct ||
    (regionLabel.trim() || null) !== settings.region_label;

  return (
    <DashboardLayout activeLabel="Quote Truth Engine">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <Scale size={24} aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-xl font-bold text-text-primary">Quote Truth Engine</h1>
            <p className="text-sm text-text-secondary">
              Is this quote actually reasonable? See the expected price range, the chance the customer says no, and the risk they later feel overcharged — before you send it.
            </p>
          </div>
        </div>

        {/* ---------------- Analyze ---------------- */}
        <section className={sectionClass} aria-labelledby={`${pickerId}-h`}>
          <h2 id={`${pickerId}-h`} className="mb-3 text-sm font-semibold text-text-primary">Analyze a quote</h2>
          {quotesLoading ? (
            <SkeletonCard rows={2} withIcon={false} />
          ) : quotes.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No draft or sent quotes to analyze"
              description="Build a quote on the Quotes page, then come back to run a Truth Check on it."
            />
          ) : (
            <>
              <label htmlFor={pickerId} className="mb-1.5 block text-sm font-medium text-text-primary">Quote</label>
              <select id={pickerId} value={selectedId} onChange={(e) => setSelectedId(e.target.value)} className={`${selectClass} mb-4`}>
                <option value="">Select a quote…</option>
                {quotes.map((q) => {
                  const total = calculateQuoteTotals(q.line_items ?? [], Number(q.tax_percent) || 0).subtotalCents;
                  return (
                    <option key={q.id} value={q.id}>
                      {q.customer_name} · {formatUsd(total)} · {q.status}
                      {q.truth_verdict ? ` · ${VERDICT_META[q.truth_verdict].label}` : ''}
                    </option>
                  );
                })}
              </select>
              {selected ? (
                <QuoteTruthPanel key={selected.id} quoteId={selected.id} onAnalyzed={() => { loadAnalyses(); loadQuotes(); }} />
              ) : (
                <p className="text-xs text-text-secondary">Pick a quote to run the check. Analysis is advisory and never blocks sending.</p>
              )}
            </>
          )}
        </section>

        {/* ---------------- History ---------------- */}
        <section className={sectionClass} aria-labelledby={`${pickerId}-hist`}>
          <h2 id={`${pickerId}-hist`} className="mb-3 text-sm font-semibold text-text-primary">Recent analyses</h2>
          {analysesLoading ? (
            <SkeletonCard rows={3} withIcon={false} />
          ) : analyses.length === 0 ? (
            <EmptyState
              icon={Scale}
              title="No analyses yet"
              description="Every Truth Check you run is saved here so you can see how your pricing judgment is trending."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border text-xs text-text-secondary">
                  <tr>
                    <th className="px-3 py-2 font-medium">Quote</th>
                    <th className="px-3 py-2 font-medium">Price</th>
                    <th className="px-3 py-2 font-medium">Expected</th>
                    <th className="px-3 py-2 font-medium">Verdict</th>
                    <th className="px-3 py-2 font-medium">Reject risk</th>
                    <th className="px-3 py-2 font-medium">Overcharge</th>
                    <th className="px-3 py-2 font-medium">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {analyses.map((a) => (
                    <tr key={a.id} className="border-b border-border last:border-0">
                      <td className="px-3 py-2 text-text-primary">{a.quotes?.customer_name ?? 'Quote'}</td>
                      <td className="px-3 py-2 text-text-secondary">{formatUsd(a.subtotal_cents)}</td>
                      <td className="px-3 py-2 text-text-secondary">{formatUsd(a.expected_low_cents)}–{formatUsd(a.expected_high_cents)}</td>
                      <td className="px-3 py-2">
                        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${VERDICT_META[a.verdict].tone}`}>{VERDICT_META[a.verdict].label}</span>
                      </td>
                      <td className="px-3 py-2 text-text-secondary">{formatPct(Number(a.rejection_probability))}</td>
                      <td className="px-3 py-2">
                        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${RISK_LEVEL_META[a.overcharge_level].tone}`}>{RISK_LEVEL_META[a.overcharge_level].label}</span>
                      </td>
                      <td className="px-3 py-2 text-text-secondary">{new Date(a.created_at).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ---------------- Tuning ---------------- */}
        <section className={sectionClass} aria-labelledby={`${pickerId}-set`}>
          <h2 id={`${pickerId}-set`} className="mb-1 text-sm font-semibold text-text-primary">Engine settings</h2>
          <p className="mb-4 text-xs text-text-secondary">
            Your margin floor and default cost ratio come from Margin Guardrails; real per-service costs come from the Price Book. These two settings tune the Truth Engine itself.
            {!isOwner && ' Only the account owner can change them.'}
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Input
              label="Region label"
              value={regionLabel}
              onChange={(e) => setRegionLabel(e.target.value)}
              placeholder="e.g. Austin, TX"
              helperText="Matches competitor benchmarks tagged with the same region."
              disabled={!isOwner}
            />
            <Input
              label="Regional price index"
              type="number"
              inputMode="decimal"
              step="0.01"
              min={0.5}
              max={2}
              value={regionIndex}
              onChange={(e) => setRegionIndex(e.target.value)}
              helperText="1.00 = national average. Only scales network cohort data."
              disabled={!isOwner}
            />
            <Input
              label="Fair-price tolerance (%)"
              type="number"
              inputMode="decimal"
              step="0.5"
              min={0}
              max={100}
              value={maxPremium}
              onChange={(e) => setMaxPremium(e.target.value)}
              helperText="How far above the expected range before a quote is “overpriced”."
              disabled={!isOwner}
            />
          </div>
          {isOwner && (
            <div className="mt-4">
              <Button type="button" variant="primary" size="sm" onClick={handleSaveSettings} disabled={savingSettings || !settingsDirty}>
                {savingSettings ? 'Saving…' : 'Save settings'}
              </Button>
            </div>
          )}
        </section>

        <section className={sectionClass} aria-labelledby={`${pickerId}-bench`}>
          <h2 id={`${pickerId}-bench`} className="mb-1 text-sm font-semibold text-text-primary">Competitor benchmarks</h2>
          <p className="mb-4 text-xs text-text-secondary">
            Enter what competitors or the market actually charge for a whole job. The engine only uses benchmarks you enter here — it never invents market data. All words in the job description must appear in a quote for the benchmark to apply; entries lose weight as they age.
          </p>

          {isOwner && (
            <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Input label="Job" value={benchForm.service_keyword} onChange={(e) => setBenchForm({ ...benchForm, service_keyword: e.target.value })} placeholder="AC compressor replacement" />
              <Input label="Low price ($)" type="number" inputMode="decimal" min={0} value={benchForm.low} onChange={(e) => setBenchForm({ ...benchForm, low: e.target.value })} />
              <Input label="High price ($)" type="number" inputMode="decimal" min={0} value={benchForm.high} onChange={(e) => setBenchForm({ ...benchForm, high: e.target.value })} />
              <Input label="Region (optional)" value={benchForm.region_label} onChange={(e) => setBenchForm({ ...benchForm, region_label: e.target.value })} />
              <Input label="Source (optional)" value={benchForm.source_label} onChange={(e) => setBenchForm({ ...benchForm, source_label: e.target.value })} placeholder="Competitor quote, Angi, etc." />
              <div className="flex items-end">
                <Button type="button" variant="primary" size="sm" className="w-full" onClick={handleAddBenchmark} disabled={savingBench}>
                  {savingBench ? 'Adding…' : 'Add benchmark'}
                </Button>
              </div>
            </div>
          )}

          {benchmarks.length === 0 ? (
            <EmptyState icon={Scale} title="No benchmarks yet" description="Add a few competitor or market prices to sharpen the expected range for your most common jobs." />
          ) : (
            <ul className="space-y-2">
              {benchmarks.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text-primary">{b.service_keyword}</p>
                    <p className="text-xs text-text-secondary">
                      {formatUsd(b.low_cents)}–{formatUsd(b.high_cents)}
                      {b.region_label ? ` · ${b.region_label}` : ''}
                      {b.source_label ? ` · ${b.source_label}` : ''} · {new Date(b.observed_at).toLocaleDateString()}
                    </p>
                  </div>
                  {isOwner && (
                    <button
                      type="button"
                      onClick={() => handleDeleteBenchmark(b.id)}
                      aria-label={`Delete benchmark ${b.service_keyword}`}
                      className="focus-ring rounded-lg p-2 text-text-secondary hover:text-danger"
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </DashboardLayout>
  );
}
