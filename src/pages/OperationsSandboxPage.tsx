/**
 * Operations Sandbox — /dashboard/operations-sandbox
 *
 * "Run the business before changing the business." A digital twin of the
 * operation, calibrated from real jobs, calls, team, invoices and memberships,
 * lets an owner test a decision (hire, reprice, open a region, put AI on more
 * calls, change the SLA) and see the likely effect on revenue, margin,
 * utilization, SLA, churn, technician workload, truck rolls and cash flow,
 * with ranges, risks and a verdict, before anything real changes.
 * See src/lib/operationsSandbox.ts (engine) and operationsSandboxApi.ts (data).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, FlaskConical, Info, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import {
  ASSUMPTION_FIELDS,
  DEFAULT_ASSUMPTIONS,
  LEVER_DEFS,
  METRIC_DEFS,
  PRESETS,
  SIM,
  defaultLever,
  deltaTone,
  formatDelta,
  formatMetric,
  leverDef,
  runScenario,
  sanitizeAssumptions,
  type Assumptions,
  type Baseline,
  type BaselineKey,
  type DeltaTone,
  type LeverInstance,
  type LeverType,
  type Risk,
  type SimulationResult,
  type VerdictKey,
} from '@/lib/operationsSandbox';
import { deleteRun, fetchSavedRuns, gatherBaseline, saveRun, type SavedRun } from '@/lib/operationsSandboxApi';

const CARD = 'rounded-2xl border border-border bg-bg-secondary p-4';
const STORAGE_KEY = 'vireek.operations-sandbox.assumptions.v1';

const TONE_TEXT: Record<DeltaTone, string> = { good: 'text-success-500', bad: 'text-danger', neutral: 'text-text-secondary' };

const VERDICT_STYLE: Record<VerdictKey, { box: string; text: string }> = {
  recommended: { box: 'border-success-500/30 bg-success-500/10', text: 'text-success-500' },
  proceed_with_guardrails: { box: 'border-warning-500/30 bg-warning-500/10', text: 'text-warning-500' },
  not_recommended: { box: 'border-danger/30 bg-danger/10', text: 'text-danger' },
  inconclusive: { box: 'border-border bg-bg-secondary', text: 'text-text-secondary' },
};

const VERDICT_LABEL: Record<VerdictKey, string> = {
  recommended: 'Recommended',
  proceed_with_guardrails: 'With guardrails',
  not_recommended: 'Not recommended',
  inconclusive: 'No change',
};

const SEVERITY_STYLE: Record<Risk['severity'], string> = {
  high: 'bg-danger/10 text-danger',
  medium: 'bg-warning-500/10 text-warning-500',
  low: 'bg-bg-tertiary text-text-secondary',
};

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) return String((e as { message: unknown }).message);
  return 'Something went wrong';
}

function loadAssumptions(): Assumptions {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? sanitizeAssumptions(JSON.parse(raw)) : { ...DEFAULT_ASSUMPTIONS };
  } catch {
    return { ...DEFAULT_ASSUMPTIONS };
  }
}

function persistAssumptions(a: Assumptions): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(a));
  } catch {
    /* storage unavailable (private mode): calibration simply is not remembered */
  }
}

/** Saved levers come from the database: keep only well-formed, known ones. */
function sanitizeLevers(raw: unknown): LeverInstance[] {
  if (!Array.isArray(raw)) return [];
  const out: LeverInstance[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { type, params } = item as { type?: unknown; params?: unknown };
    const def = LEVER_DEFS.find((d) => d.type === type);
    if (!def || !params || typeof params !== 'object') continue;
    const p = params as Record<string, unknown>;
    out.push({
      type: def.type,
      params: Object.fromEntries(def.fields.map((f) => [f.key, typeof p[f.key] === 'number' && Number.isFinite(p[f.key] as number) ? (p[f.key] as number) : f.default])),
    });
  }
  return out;
}

const cloneLevers = (l: LeverInstance[]): LeverInstance[] => l.map((x) => ({ type: x.type, params: { ...x.params } }));
const autoName = (levers: LeverInstance[]) => levers.map((l) => leverDef(l.type).label).join(' + ') || 'Scenario';
const pct0 = (x: number) => `${Math.round(x * 100)}%`;
const usd0 = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const shortDate = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });

// ============================================================
// DIGITAL TWIN PANEL
// ============================================================

function Dot({ measured }: { measured: boolean }) {
  return (
    <span
      className={`inline-block h-1.5 w-1.5 rounded-full ${measured ? 'bg-success-500' : 'bg-warning-500'}`}
      title={measured ? 'Measured from your data' : 'Assumed: calibrate below or connect more data'}
      aria-label={measured ? 'measured' : 'assumed'}
    />
  );
}

function TwinPanel({ b, assumptions }: { b: Baseline; assumptions: Assumptions }) {
  const util = (b.jobsPerMonth / (b.technicians * b.jobsPerTechMonth)) * 100;
  const churn = b.provenance.churn === 'assumed' ? assumptions.churnMonthlyPct : b.churnMonthlyPct;
  const items: Array<{ label: string; value: string; hint?: string; key: BaselineKey }> = [
    { label: 'Jobs / month', value: Math.round(b.jobsPerMonth).toLocaleString('en-US'), hint: `${b.sample.jobs} completed in window`, key: 'jobsPerMonth' },
    { label: 'Avg job value', value: usd0(b.avgTicket), key: 'avgTicket' },
    { label: 'Technicians', value: String(b.technicians), hint: `${util.toFixed(0)}% utilized`, key: 'technicians' },
    { label: 'SLA on time', value: `${b.slaOnTimePct.toFixed(0)}%`, key: 'sla' },
    { label: 'Calls / month', value: Math.round(b.callsPerMonth).toLocaleString('en-US'), hint: `${pct0(b.missedCallRate)} missed`, key: 'calls' },
    { label: 'Rework rate', value: pct0(b.reworkRate), key: 'rework' },
    { label: 'Churn / month', value: `${churn.toFixed(1)}%`, key: 'churn' },
    { label: 'Days to get paid', value: `${Math.round(b.daysToPay)}`, key: 'daysToPay' },
  ];
  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-text-primary">Your business twin</p>
        <p className="flex items-center gap-3 text-[11px] text-text-secondary">
          <span className="flex items-center gap-1"><Dot measured /> measured</span>
          <span className="flex items-center gap-1"><Dot measured={false} /> assumed</span>
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {items.map((i) => (
          <div key={i.key} className="rounded-2xl border border-border bg-bg-secondary p-3">
            <p className="flex items-center gap-1.5 text-[11px] text-text-secondary">
              {i.label} <Dot measured={b.provenance[i.key] === 'measured'} />
            </p>
            <p className="text-lg font-semibold text-text-primary">{i.value}</p>
            {i.hint && <p className="mt-0.5 text-[11px] text-text-secondary">{i.hint}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

function CalibratePanel({ value, onChange }: { value: Assumptions; onChange: (a: Assumptions) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-5 rounded-2xl border border-border bg-bg-secondary">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="focus-ring flex w-full items-center justify-between gap-2 rounded-2xl p-4 text-left"
      >
        <span>
          <span className="block text-sm font-medium text-text-primary">Calibrate the twin</span>
          <span className="block text-xs text-text-secondary">Costs and market response that cannot be read from your records. Saved on this device.</span>
        </span>
        <ChevronDown size={16} className={`shrink-0 text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div className="border-t border-border p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {ASSUMPTION_FIELDS.map((f) => {
              const shown = f.asPercent ? Math.round(value[f.key] * 1000) / 10 : value[f.key];
              const id = `assumption-${f.key}`;
              return (
                <div key={f.key}>
                  <label htmlFor={id} className="block text-xs font-medium text-text-primary">{f.label}</label>
                  <div className="mt-1 flex items-center gap-1.5 rounded-xl border border-border bg-bg-primary px-2.5 py-1.5">
                    {f.prefix && <span className="text-xs text-text-secondary">{f.prefix}</span>}
                    <input
                      id={id}
                      type="number"
                      inputMode="decimal"
                      min={f.asPercent ? f.min * 100 : f.min}
                      max={f.asPercent ? f.max * 100 : f.max}
                      step={f.asPercent ? f.step * 100 : f.step}
                      value={shown}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (!Number.isFinite(n) || e.target.value === '') return;
                        onChange(sanitizeAssumptions({ ...value, [f.key]: f.asPercent ? n / 100 : n }));
                      }}
                      className="w-full bg-transparent text-sm text-text-primary outline-none"
                    />
                    {f.suffix && <span className="text-xs text-text-secondary">{f.suffix}</span>}
                  </div>
                  <p className="mt-1 text-[11px] text-text-secondary">{f.help}</p>
                </div>
              );
            })}
          </div>
          <div className="mt-3">
            <Button size="sm" variant="ghost" onClick={() => onChange({ ...DEFAULT_ASSUMPTIONS })}>Reset to defaults</Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// SCENARIO BUILDER
// ============================================================

function LeverCard({ lever, onChange, onRemove }: { lever: LeverInstance; onChange: (key: string, v: number) => void; onRemove: () => void }) {
  const def = leverDef(lever.type);
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-text-primary">{def.label}</p>
          <p className="text-[11px] text-text-secondary">{def.description}</p>
        </div>
        <button type="button" onClick={onRemove} aria-label={`Remove ${def.label}`} className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary">
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="space-y-3">
        {def.fields.map((f) => {
          const id = `lever-${lever.type}-${f.key}`;
          const v = lever.params[f.key] ?? f.default;
          return (
            <div key={f.key}>
              <div className="flex items-center justify-between gap-2">
                <label htmlFor={id} className="text-xs text-text-secondary">{f.label}</label>
                <span className="text-xs font-semibold text-text-primary">{`${v}${f.suffix}`}</span>
              </div>
              <input
                id={id}
                type="range"
                min={f.min}
                max={f.max}
                step={f.step}
                value={v}
                onChange={(e) => onChange(f.key, Number(e.target.value))}
                className="mt-1 w-full accent-accent"
              />
              {f.help && <p className="text-[11px] text-text-secondary">{f.help}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Builder({
  levers,
  activePreset,
  onPreset,
  onChange,
  onAdd,
  onRemove,
}: {
  levers: LeverInstance[];
  activePreset: string | null;
  onPreset: (id: string) => void;
  onChange: (type: LeverType, key: string, v: number) => void;
  onAdd: (type: LeverType) => void;
  onRemove: (type: LeverType) => void;
}) {
  const unused = LEVER_DEFS.filter((d) => !levers.some((l) => l.type === d.type));
  return (
    <div className={`${CARD} mb-5`}>
      <p className="mb-1 text-sm font-medium text-text-primary">What if…</p>
      <p className="mb-3 text-xs text-text-secondary">Start from a question or build your own. Nothing changes in your real business.</p>
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Scenario presets">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onPreset(p.id)}
            aria-pressed={activePreset === p.id}
            title={p.description}
            className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${activePreset === p.id ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {levers.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {levers.map((l) => (
            <LeverCard key={l.type} lever={l} onChange={(k, v) => onChange(l.type, k, v)} onRemove={() => onRemove(l.type)} />
          ))}
        </div>
      )}

      {unused.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-text-secondary">Add a change:</span>
          {unused.map((d) => (
            <button
              key={d.type}
              type="button"
              onClick={() => onAdd(d.type)}
              className="focus-ring inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs text-text-secondary hover:border-accent/40 hover:text-text-primary"
            >
              <Plus size={12} aria-hidden="true" /> {d.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// RESULTS
// ============================================================

function VerdictBanner({ r }: { r: SimulationResult }) {
  const s = VERDICT_STYLE[r.verdict.key];
  const Icon = r.verdict.key === 'recommended' ? CheckCircle2 : r.verdict.key === 'inconclusive' ? Info : AlertTriangle;
  return (
    <div className={`mb-5 rounded-2xl border p-4 ${s.box}`} role="status">
      <div className="flex items-start gap-3">
        <Icon size={20} className={`mt-0.5 shrink-0 ${s.text}`} aria-hidden="true" />
        <div className="min-w-0">
          <p className={`text-base font-semibold ${s.text}`}>{r.verdict.headline}</p>
          <p className="mt-0.5 text-sm text-text-secondary">{r.verdict.summary}</p>
          {r.verdict.key !== 'inconclusive' && (
            <p className="mt-2 text-[11px] text-text-secondary">
              Confidence {r.confidence.label} ({r.confidence.score}/100) · {SIM.runs} simulated futures · 6-month horizon
            </p>
          )}
        </div>
      </div>
      {r.verdict.key !== 'inconclusive' && r.confidence.reasons.length > 0 && (
        <ul className="mt-3 list-disc space-y-0.5 pl-9 text-[11px] text-text-secondary">
          {r.confidence.reasons.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MetricsTable({ r }: { r: SimulationResult }) {
  const changed = r.verdict.key !== 'inconclusive';
  return (
    <div className={`${CARD} mb-5 overflow-x-auto`}>
      <p className="mb-1 text-sm font-medium text-text-primary">Before vs after</p>
      <p className="mb-3 text-xs text-text-secondary">Month 6 run-rate. The range covers 80% of simulated futures.</p>
      <table className="w-full min-w-[520px] text-left text-sm">
        <thead>
          <tr className="text-[11px] text-text-secondary">
            <th scope="col" className="pb-2 font-medium">Metric</th>
            <th scope="col" className="pb-2 text-right font-medium">Today</th>
            <th scope="col" className="pb-2 text-right font-medium">Projected</th>
            <th scope="col" className="pb-2 text-right font-medium">Change</th>
            <th scope="col" className="pb-2 text-right font-medium">Likely range</th>
          </tr>
        </thead>
        <tbody>
          {METRIC_DEFS.map((m) => {
            const delta = r.deltas[m.key];
            const tone = changed ? deltaTone(m.key, delta) : 'neutral';
            const range = r.ranges[m.key];
            return (
              <tr key={m.key} className="border-t border-border">
                <th scope="row" className="py-2 pr-2 font-normal">
                  <span className="block text-text-primary">{m.label}</span>
                  <span className="block text-[11px] text-text-secondary">{m.hint}</span>
                </th>
                <td className="py-2 text-right text-text-secondary">{formatMetric(m.key, r.baseline[m.key])}</td>
                <td className="py-2 text-right font-semibold text-text-primary">{formatMetric(m.key, r.projected[m.key])}</td>
                <td className={`py-2 text-right font-medium ${TONE_TEXT[tone]}`}>{changed ? formatDelta(m.key, delta) : '—'}</td>
                <td className="py-2 text-right text-[11px] text-text-secondary">
                  {changed ? `${formatMetric(m.key, range.p10)} – ${formatMetric(m.key, range.p90)}` : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CashChart({ r }: { r: SimulationResult }) {
  const values = r.cash.cumulativeDelta;
  const maxAbs = Math.max(1, ...values.map((v) => Math.abs(v)));
  const W = 300;
  const H = 120;
  const mid = H / 2;
  const barW = 28;
  const gap = (W - barW * values.length) / (values.length + 1);
  const summary =
    r.cash.paybackMonth === 0
      ? 'Cash stays ahead of doing nothing from the first month.'
      : r.cash.paybackMonth === null
        ? `Cash dips to ${usd0(r.cash.trough)} and does not recover within ${SIM.horizonMonths} months.`
        : `Cash dips to ${usd0(r.cash.trough)} in month ${r.cash.troughMonth} and is back to even in month ${r.cash.paybackMonth}.`;
  return (
    <div className={CARD}>
      <p className="mb-1 text-sm font-medium text-text-primary">Cash vs doing nothing</p>
      <p className="mb-3 text-xs text-text-secondary">Cumulative cash difference by month, including one-off costs and payment delay.</p>
      <svg viewBox={`0 0 ${W} ${H + 16}`} className="w-full" role="img" aria-label={`Cumulative cash difference over ${SIM.horizonMonths} months. ${summary}`}>
        <line x1="0" x2={W} y1={mid} y2={mid} stroke="currentColor" className="text-border" strokeWidth="1" />
        {values.map((v, i) => {
          const h = (Math.abs(v) / maxAbs) * (mid - 6);
          const x = gap + i * (barW + gap);
          return (
            <g key={i}>
              <rect x={x} y={v >= 0 ? mid - h : mid} width={barW} height={Math.max(h, 1)} rx="3" className={v >= 0 ? 'fill-success-500' : 'fill-danger'} />
              <text x={x + barW / 2} y={H + 10} textAnchor="middle" className="fill-text-secondary" fontSize="9">{`M${i + 1}`}</text>
            </g>
          );
        })}
      </svg>
      <p className="mt-2 text-xs text-text-secondary">{summary}</p>
    </div>
  );
}

function DriversAndRisks({ r }: { r: SimulationResult }) {
  if (r.verdict.key === 'inconclusive') return null;
  const dotColor = { positive: 'bg-success-500', negative: 'bg-danger', neutral: 'bg-text-secondary' } as const;
  return (
    <div className="mb-5 grid gap-4 md:grid-cols-2">
      <div className={CARD}>
        <p className="mb-3 text-sm font-medium text-text-primary">Why the numbers move</p>
        <ul className="space-y-3">
          {r.drivers.map((d) => (
            <li key={d.title} className="flex gap-2.5">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dotColor[d.tone]}`} aria-hidden="true" />
              <div>
                <p className="text-sm text-text-primary">{d.title}</p>
                <p className="text-xs text-text-secondary">{d.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <div className={CARD}>
        <p className="mb-3 text-sm font-medium text-text-primary">Guardrails</p>
        {r.risks.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-text-secondary">
            <CheckCircle2 size={16} className="text-success-500" aria-hidden="true" /> No service, margin, churn or cash risks detected.
          </p>
        ) : (
          <ul className="space-y-3">
            {r.risks.map((k) => (
              <li key={k.key}>
                <p className="flex items-center gap-2 text-sm text-text-primary">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${SEVERITY_STYLE[k.severity]}`}>{k.severity}</span>
                  {k.title}
                </p>
                <p className="mt-0.5 text-xs text-text-secondary">{k.detail}</p>
                <p className="text-xs text-text-secondary"><span className="font-medium text-text-primary">Safeguard:</span> {k.mitigation}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SavedList({ runs, onLoad, onDelete, busyId }: { runs: SavedRun[]; onLoad: (r: SavedRun) => void; onDelete: (id: string) => void; busyId: string | null }) {
  if (runs.length === 0) return null;
  return (
    <div className="mt-5">
      <p className="mb-2 text-sm font-medium text-text-primary">Saved scenarios</p>
      <ul className="space-y-2">
        {runs.map((s) => {
          const v = VERDICT_STYLE[s.verdict] ?? VERDICT_STYLE.inconclusive;
          const gp = s.summary?.deltas?.grossProfit;
          return (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border bg-bg-secondary p-3">
              <div className="min-w-0">
                <p className="truncate text-sm text-text-primary">{s.name}</p>
                <p className="text-[11px] text-text-secondary">
                  {shortDate(s.created_at)}
                  {typeof gp === 'number' ? ` · ${formatDelta('grossProfit', gp)} gross profit / mo` : ''}
                  {typeof s.summary?.confidence === 'number' ? ` · confidence ${s.summary.confidence}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${v.text}`}>{VERDICT_LABEL[s.verdict] ?? s.verdict}</span>
                <Button size="sm" variant="secondary" onClick={() => onLoad(s)}>Load</Button>
                <Button size="sm" variant="ghost" onClick={() => onDelete(s.id)} disabled={busyId === s.id} aria-label={`Delete ${s.name}`}>
                  <Trash2 size={14} aria-hidden="true" />
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function OperationsSandboxPage() {
  const { toast } = useToast();
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [saved, setSaved] = useState<SavedRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [assumptions, setAssumptions] = useState<Assumptions>(loadAssumptions);
  const [levers, setLevers] = useState<LeverInstance[]>(() => cloneLevers(PRESETS[0].levers));
  const [activePreset, setActivePreset] = useState<string | null>(PRESETS[0].id);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const [b, runs] = await Promise.all([gatherBaseline(), fetchSavedRuns()]);
      if (!mounted.current) return;
      setBaseline(b);
      setSaved(runs);
      setFailed(false);
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = () => {
    setRefreshing(true);
    void load();
  };

  const updateAssumptions = (a: Assumptions) => {
    setAssumptions(a);
    persistAssumptions(a);
  };

  const result = useMemo(() => (baseline ? runScenario(baseline, assumptions, levers) : null), [baseline, assumptions, levers]);

  const applyPreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    setLevers(cloneLevers(p.levers));
    setActivePreset(id);
    setName('');
  };
  const changeLever = (type: LeverType, key: string, v: number) => {
    setLevers((cur) => cur.map((l) => (l.type === type ? { ...l, params: { ...l.params, [key]: v } } : l)));
    setActivePreset(null);
  };
  const addLever = (type: LeverType) => {
    setLevers((cur) => (cur.some((l) => l.type === type) ? cur : [...cur, defaultLever(type)]));
    setActivePreset(null);
  };
  const removeLever = (type: LeverType) => {
    setLevers((cur) => cur.filter((l) => l.type !== type));
    setActivePreset(null);
  };

  const onSave = async () => {
    if (!result || levers.length === 0 || saving) return;
    setSaving(true);
    try {
      await saveRun(name.trim() || autoName(levers), levers, assumptions, result);
      toast('Scenario saved.', 'success');
      setName('');
      const runs = await fetchSavedRuns();
      if (mounted.current) setSaved(runs);
    } catch (e) {
      toast(errMessage(e), 'error');
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const onLoadSaved = (s: SavedRun) => {
    const l = sanitizeLevers(s.levers);
    if (l.length === 0) {
      toast('This saved scenario has no usable changes.', 'error');
      return;
    }
    setLevers(l);
    setActivePreset(null);
    setName(s.name);
    updateAssumptions(sanitizeAssumptions(s.assumptions));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const onDeleteSaved = async (id: string) => {
    setBusyId(id);
    try {
      await deleteRun(id);
      if (mounted.current) setSaved((cur) => cur.filter((x) => x.id !== id));
    } catch (e) {
      toast(errMessage(e), 'error');
    } finally {
      if (mounted.current) setBusyId(null);
    }
  };

  return (
    <DashboardLayout activeLabel="Operations Sandbox">
      <div className="mx-auto max-w-5xl px-4 py-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <FlaskConical size={18} /> Operations Sandbox
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">
              A virtual copy of your business. Run the business before changing the business: test a decision against your real jobs, calls, team and cash, and see the likely effect before you commit.
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={refresh} disabled={refreshing || loading}>
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh twin
          </Button>
        </div>

        {loading ? (
          <div className="space-y-4">
            <SkeletonStatGrid count={4} />
            <SkeletonCardList count={3} />
          </div>
        ) : failed || !baseline || !result ? (
          <EmptyState
            icon={FlaskConical}
            title="Operations Sandbox unavailable"
            description="The business twin could not be built. Check your connection and try again."
            action={{ label: 'Reload', onClick: () => { setLoading(true); void load(); } }}
          />
        ) : (
          <>
            <TwinPanel b={baseline} assumptions={assumptions} />
            <CalibratePanel value={assumptions} onChange={updateAssumptions} />
            <Builder levers={levers} activePreset={activePreset} onPreset={applyPreset} onChange={changeLever} onAdd={addLever} onRemove={removeLever} />

            <VerdictBanner r={result} />
            {result.verdict.key !== 'inconclusive' && (
              <>
                <MetricsTable r={result} />
                <div className="mb-5 grid gap-4 md:grid-cols-2">
                  <CashChart r={result} />
                  <div className={CARD}>
                    <p className="mb-1 text-sm font-medium text-text-primary">Keep this scenario</p>
                    <p className="mb-3 text-xs text-text-secondary">Saved scenarios keep the changes, calibration and result so you can revisit or compare later.</p>
                    <label htmlFor="scenario-name" className="sr-only">Scenario name</label>
                    <input
                      id="scenario-name"
                      type="text"
                      maxLength={120}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={autoName(levers)}
                      className="mb-3 w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/60"
                    />
                    <Button size="sm" onClick={() => void onSave()} disabled={saving || levers.length === 0}>
                      <Save size={14} aria-hidden="true" /> {saving ? 'Saving…' : 'Save scenario'}
                    </Button>
                  </div>
                </div>
                <DriversAndRisks r={result} />
              </>
            )}
            <SavedList runs={saved} onLoad={onLoadSaved} onDelete={(id) => void onDeleteSaved(id)} busyId={busyId} />
            <p className="mt-6 text-[11px] text-text-secondary">
              Simulations are estimates from your recent history and the calibration above, not guarantees. Pilot large changes before rolling them out.
            </p>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
