import { useId, useState } from 'react';
import { AlertOctagon, AlertTriangle, Gauge, Info, ShieldCheck, TrendingDown, TrendingUp } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SkeletonCard } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import {
  ANCHOR_GROUP,
  COMPLEXITY_OPTIONS,
  DEFAULT_TRUTH_CONTEXT,
  RISK_LEVEL_META,
  SEVERITY_META,
  TECHNICIAN_LEVEL_OPTIONS,
  VERDICT_META,
  analyzeQuoteTruth,
  formatPct,
  formatUsd,
} from '@/lib/quoteTruth';
import type { Complexity, TechnicianLevel, TruthContext, TruthReport } from '@/lib/quoteTruth';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent';

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// ---------------------------------------------------------------------------
// Expected-range bar
// ---------------------------------------------------------------------------

function RangeBar({ report }: { report: TruthReport }) {
  const { low_cents: low, high_cents: high } = report.expected;
  const quote = report.quote.subtotal_cents;
  const rec = report.optimization.recommended.price_cents;
  const min = Math.min(low, quote, rec) * 0.9;
  const max = Math.max(high, quote, rec) * 1.08;
  const span = Math.max(1, max - min);
  const pos = (v: number) => clamp(((v - min) / span) * 100, 0, 100);

  return (
    <div
      role="img"
      aria-label={`Quoted ${formatUsd(quote)}. Expected range ${formatUsd(low)} to ${formatUsd(high)}. Recommended ${formatUsd(rec)}.`}
      className="pt-7 pb-8"
    >
      <div className="relative h-3 rounded-full bg-bg-tertiary">
        <div
          className="absolute top-0 h-3 rounded-full bg-success-500/30"
          style={{ left: `${pos(low)}%`, width: `${Math.max(1, pos(high) - pos(low))}%` }}
        />
        {rec !== quote && (
          <div
            className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-bg-secondary"
            style={{ left: `${pos(rec)}%` }}
          >
            <span className="absolute left-1/2 top-5 -translate-x-1/2 whitespace-nowrap text-[11px] font-medium text-text-secondary">
              Suggested {formatUsd(rec)}
            </span>
          </div>
        )}
        <div
          className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent"
          style={{ left: `${pos(quote)}%` }}
        >
          <span className="absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap text-[11px] font-semibold text-text-primary">
            Quote {formatUsd(quote)}
          </span>
        </div>
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-text-secondary">
        <span>Expected low {formatUsd(low)}</span>
        <span>Expected high {formatUsd(high)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Curve chart (acceptance vs. price, expected profit when visible)
// ---------------------------------------------------------------------------

function CurveChart({ report }: { report: TruthReport }) {
  const curve = report.optimization.curve;
  if (curve.length < 2) return null;
  const W = 320;
  const H = 120;
  const pad = 8;
  const minP = curve[0].price_cents;
  const maxP = curve[curve.length - 1].price_cents;
  const x = (p: number) => pad + ((p - minP) / Math.max(1, maxP - minP)) * (W - pad * 2);
  const yAcc = (a: number) => H - pad - (a / 100) * (H - pad * 2);

  const profits = curve.map((c) => c.expected_profit_cents);
  const hasProfit = profits.every((p) => p !== null);
  const maxProfit = hasProfit ? Math.max(1, ...(profits as number[])) : 1;
  const yProfit = (v: number) => H - pad - (Math.max(0, v) / maxProfit) * (H - pad * 2);

  const accPath = curve.map((c, i) => `${i === 0 ? 'M' : 'L'}${x(c.price_cents).toFixed(1)},${yAcc(c.acceptance_pct).toFixed(1)}`).join(' ');
  const profitPath = hasProfit
    ? curve.map((c, i) => `${i === 0 ? 'M' : 'L'}${x(c.price_cents).toFixed(1)},${yProfit(c.expected_profit_cents as number).toFixed(1)}`).join(' ')
    : null;

  const cur = report.optimization.current.price_cents;
  const rec = report.optimization.recommended.price_cents;

  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-32 w-full" role="img" aria-label="Estimated acceptance probability and expected profit at different prices">
        <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} className="stroke-border" strokeWidth="1" />
        <path d={accPath} fill="none" className="stroke-accent" strokeWidth="2" />
        {profitPath && <path d={profitPath} fill="none" className="stroke-success-500" strokeWidth="2" strokeDasharray="4 3" />}
        <line x1={x(clamp(cur, minP, maxP))} y1={pad} x2={x(clamp(cur, minP, maxP))} y2={H - pad} className="stroke-text-secondary" strokeWidth="1" strokeDasharray="2 3" />
        {rec !== cur && (
          <line x1={x(clamp(rec, minP, maxP))} y1={pad} x2={x(clamp(rec, minP, maxP))} y2={H - pad} className="stroke-accent" strokeWidth="1.5" />
        )}
      </svg>
      <figcaption className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-text-secondary">
        <span className="inline-flex items-center gap-1"><span className="h-0.5 w-4 bg-accent" /> Acceptance %</span>
        {hasProfit && <span className="inline-flex items-center gap-1"><span className="h-0.5 w-4 border-t-2 border-dashed border-success-500" /> Expected profit</span>}
        <span>Dotted line = your price · Solid line = suggested</span>
      </figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function Stat({ label, value, sub, icon: Icon }: { label: string; value: string; sub?: string; icon: typeof Gauge }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-text-secondary">
        <Icon size={13} aria-hidden="true" /> {label}
      </div>
      <p className="text-2xl font-bold text-text-primary">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-text-secondary">{sub}</p>}
    </div>
  );
}

export function QuoteTruthReportView({ report }: { report: TruthReport }) {
  const verdict = VERDICT_META[report.verdict];
  const over = RISK_LEVEL_META[report.risk.overcharge_level];
  const opt = report.optimization;
  const groups = report.expected.anchors.reduce<Record<string, typeof report.expected.anchors>>((acc, a) => {
    const g = ANCHOR_GROUP[a.key] ?? 'Model';
    (acc[g] ??= []).push(a);
    return acc;
  }, {});
  const appliedFactors = report.expected.factors.filter((f) => f.applied);
  const [rLow, rHigh] = report.risk.rejection_band;

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${verdict.tone}`}>{verdict.label}</span>
          <span className="text-xs text-text-secondary">{verdict.summary}</span>
        </div>
        <p className="text-sm text-text-primary">{report.headline}</p>
      </div>

      <RangeBar report={report} />

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          icon={Gauge}
          label="Chance customer rejects"
          value={formatPct(report.risk.rejection_probability)}
          sub={`Likely ${formatPct(rLow)}–${formatPct(rHigh)}`}
        />
        <div className="rounded-2xl border border-border bg-bg-secondary p-4">
          <div className="mb-1 flex items-center gap-1.5 text-xs text-text-secondary">
            <AlertTriangle size={13} aria-hidden="true" /> Chance customer later feels overcharged
          </div>
          <span className={`inline-block rounded-full px-3 py-1 text-sm font-bold ${over.tone}`}>{over.label}</span>
          <div
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-tertiary"
            role="meter"
            aria-label="Overcharge-perception risk index"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={report.risk.overcharge_score}
          >
            <div className={`h-full ${over.bar}`} style={{ width: `${report.risk.overcharge_score}%` }} />
          </div>
          <p className="mt-1 text-xs text-text-secondary">Risk index {report.risk.overcharge_score}/100</p>
        </div>
        {report.margin ? (
          <Stat
            icon={ShieldCheck}
            label="Estimated margin"
            value={report.margin.margin_pct === null ? '—' : `${report.margin.margin_pct.toFixed(1)}%`}
            sub={`Floor ${report.margin.floor_pct}% · ${report.margin.cost_coverage_pct}% costed from Price Book`}
          />
        ) : (
          <Stat icon={ShieldCheck} label="Trust score" value={`${report.risk.trust_score}`} sub="Cost and margin details are hidden for your role." />
        )}
      </div>

      {report.findings.length > 0 && (
        <section aria-label="Findings">
          <h3 className="mb-2 text-sm font-semibold text-text-primary">What the engine found</h3>
          <ul className="space-y-2">
            {report.findings.map((f) => {
              const sev = SEVERITY_META[f.severity];
              const Icon = f.severity === 'critical' ? AlertOctagon : f.severity === 'warning' ? AlertTriangle : Info;
              return (
                <li key={f.code} className="flex gap-3 rounded-xl border border-border bg-bg-secondary p-3">
                  <Icon size={16} className="mt-0.5 shrink-0 text-text-secondary" aria-hidden="true" />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${sev.tone}`}>{sev.label}</span>
                      <p className="text-sm font-medium text-text-primary">{f.title}</p>
                    </div>
                    <p className="mt-0.5 text-xs text-text-secondary">{f.detail}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section aria-label="Price optimization" className="rounded-2xl border border-border bg-bg-secondary p-4">
        <div className="mb-2 flex items-center gap-2">
          {opt.action === 'lower' ? <TrendingDown size={16} aria-hidden="true" /> : opt.action === 'raise' ? <TrendingUp size={16} aria-hidden="true" /> : <ShieldCheck size={16} aria-hidden="true" />}
          <h3 className="text-sm font-semibold text-text-primary">
            {opt.action === 'hold' ? 'Price is well placed' : `Suggested price: ${formatUsd(opt.recommended.price_cents)}`}
          </h3>
        </div>
        <p className="mb-3 text-xs text-text-secondary">{opt.note}</p>
        <div className="mb-3 grid gap-3 text-xs sm:grid-cols-3">
          <div>
            <p className="text-text-secondary">Safe price band</p>
            <p className="text-sm font-semibold text-text-primary">{formatUsd(opt.safe_min_cents)}–{formatUsd(opt.safe_max_cents)}</p>
          </div>
          <div>
            <p className="text-text-secondary">Acceptance at your price → suggested</p>
            <p className="text-sm font-semibold text-text-primary">
              {formatPct(opt.current.acceptance_probability)} → {formatPct(opt.recommended.acceptance_probability)}
            </p>
          </div>
          {opt.expected_profit_delta_cents !== null && (
            <div>
              <p className="text-text-secondary">Expected profit change</p>
              <p className="text-sm font-semibold text-text-primary">
                {opt.expected_profit_delta_cents >= 0 ? '+' : ''}{formatUsd(opt.expected_profit_delta_cents)}
              </p>
            </div>
          )}
        </div>
        <CurveChart report={report} />
        <p className="mt-2 text-[11px] text-text-secondary">
          Expected profit = acceptance × margin, reduced by up to {formatPct(opt.trust_drag)} for overcharge risk. The suggestion never goes above the fair-price ceiling or below your margin floor.
        </p>
      </section>

      <section aria-label="How the expected range was built">
        <h3 className="mb-2 text-sm font-semibold text-text-primary">How the expected range was built</h3>
        <div className="space-y-2">
          {Object.entries(groups).map(([group, anchors]) => (
            <div key={group} className="rounded-xl border border-border bg-bg-secondary p-3">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{group}</p>
              {anchors.map((a) => (
                <div key={a.key} className="mb-1 last:mb-0">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="font-medium text-text-primary">{a.label}</span>
                    <span className="shrink-0 text-text-primary">{formatUsd(a.low_cents)}–{formatUsd(a.high_cents)}</span>
                  </div>
                  <p className="text-xs text-text-secondary">{a.detail} · weight {formatPct(a.weight)}</p>
                </div>
              ))}
            </div>
          ))}
          <div className="rounded-xl border border-border bg-bg-secondary p-3">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">Property-adjusted (final)</p>
            <p className="text-sm font-medium text-text-primary">
              {formatUsd(report.expected.low_cents)}–{formatUsd(report.expected.high_cents)}
            </p>
            {appliedFactors.length === 0 ? (
              <p className="text-xs text-text-secondary">No technician, complexity, travel or urgency adjustments applied.</p>
            ) : (
              <ul className="mt-1 space-y-0.5">
                {appliedFactors.map((f) => (
                  <li key={f.key} className="text-xs text-text-secondary">
                    <span className="font-medium text-text-primary">{f.label}:</span> {f.detail}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {report.risk.overcharge_drivers.length > 0 && (
        <section aria-label="Overcharge risk drivers">
          <h3 className="mb-2 text-sm font-semibold text-text-primary">What drives the overcharge risk</h3>
          <ul className="space-y-1">
            {report.risk.overcharge_drivers.map((d) => (
              <li key={d.label} className="flex justify-between gap-3 text-xs text-text-secondary">
                <span>{d.label}</span>
                <span className="shrink-0 font-medium text-text-primary">+{d.points}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Evidence quality" className="rounded-xl border border-dashed border-border p-3">
        <p className="text-xs font-semibold text-text-primary">
          Evidence confidence: {report.expected.confidence_label} ({Math.round(report.expected.confidence_score * 100)}%)
        </p>
        <p className="mt-1 text-xs text-text-secondary">
          {report.data_quality.similar_quotes_used} similar accepted quotes · {report.data_quality.competitor_benchmarks_used} competitor benchmark
          {report.data_quality.competitor_benchmarks_used === 1 ? '' : 's'} · {report.data_quality.price_book_coverage_pct}% Price Book coverage ·
          acceptance model {report.risk.sensitivity_source}
        </p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-text-secondary">
          {report.data_quality.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-text-secondary">
          Advisory only — deterministic estimate from your own data, not a guarantee. Engine v{report.engine_version}.
        </p>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel: context inputs + run button + result
// ---------------------------------------------------------------------------

interface QuoteTruthPanelProps {
  quoteId: string;
  onAnalyzed?: (report: TruthReport) => void;
}

export function QuoteTruthPanel({ quoteId, onAnalyzed }: QuoteTruthPanelProps) {
  const { toast } = useToast();
  const uid = useId();
  const [tech, setTech] = useState<TechnicianLevel>(DEFAULT_TRUTH_CONTEXT.technician_level);
  const [complexity, setComplexity] = useState<Complexity>(DEFAULT_TRUTH_CONTEXT.complexity);
  const [afterHours, setAfterHours] = useState(false);
  const [miles, setMiles] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<TruthReport | null>(null);
  const [persisted, setPersisted] = useState(true);

  const run = async () => {
    const parsedMiles = miles.trim() === '' ? null : Number(miles);
    if (parsedMiles !== null && (!Number.isFinite(parsedMiles) || parsedMiles < 0 || parsedMiles > 500)) {
      setError('Travel distance must be a number between 0 and 500 miles.');
      return;
    }
    const context: TruthContext = { technician_level: tech, complexity, after_hours: afterHours, travel_miles: parsedMiles };
    setRunning(true);
    setError(null);
    try {
      const result = await analyzeQuoteTruth(quoteId, context);
      setReport(result.report);
      setPersisted(result.persisted);
      onAnalyzed?.(result.report);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not analyze this quote.';
      setError(message);
      toast(message, 'error');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label htmlFor={`${uid}-tech`} className="mb-1.5 block text-sm font-medium text-text-primary">Technician</label>
          <select id={`${uid}-tech`} value={tech} onChange={(e) => setTech(e.target.value as TechnicianLevel)} className={selectClass}>
            {TECHNICIAN_LEVEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${uid}-cx`} className="mb-1.5 block text-sm font-medium text-text-primary">Complexity</label>
          <select id={`${uid}-cx`} value={complexity} onChange={(e) => setComplexity(e.target.value as Complexity)} className={selectClass}>
            {COMPLEXITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <Input
          label="Travel (miles)"
          type="number"
          inputMode="decimal"
          min={0}
          max={500}
          placeholder="Optional"
          value={miles}
          onChange={(e) => setMiles(e.target.value)}
        />
        <label className="flex items-end gap-2 pb-3 text-sm text-text-primary">
          <input type="checkbox" checked={afterHours} onChange={(e) => setAfterHours(e.target.checked)} className="focus-ring h-4 w-4 rounded border-border" />
          After-hours / urgent
        </label>
      </div>

      <Button type="button" variant="primary" size="sm" onClick={run} disabled={running}>
        {running ? 'Analyzing…' : report ? 'Re-run analysis' : 'Run Truth Check'}
      </Button>

      {error && (
        <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</p>
      )}

      {running && !report && <SkeletonCard rows={4} />}

      {report && (
        <div aria-live="polite">
          {!persisted && (
            <p className="mb-3 text-xs text-warning-500">This result could not be saved to history, but the analysis above is current.</p>
          )}
          <QuoteTruthReportView report={report} />
        </div>
      )}
    </div>
  );
}
