import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  FlaskConical,
  Loader2,
  Minus,
  RefreshCw,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
  Waves,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import {
  addLogEntry,
  fetchLogEntries,
  fetchProducts,
  fetchTeam,
  friendlyTradePackError,
  type RegulatedProduct,
  type TeamOption,
  type TradeLogEntry,
} from '@/lib/tradePacksApi';
import {
  CHEMICALS,
  L_PER_GAL,
  READING_KEYS,
  SANITIZER_OPTIONS,
  SAFETY_NOTES,
  WATER_BODY_LABELS,
  cleanLogData,
  defaultsFromHistory,
  describeDose,
  dosingEntryData,
  doseForProduct,
  evaluateWater,
  getLogType,
  productsForRole,
  readingEntryData,
  readingHistory,
  recommendDosing,
  rangesFor,
  sanitizerFamily,
  seriesFor,
  sparkline,
  statusFor,
  trendDirection,
  validateLogData,
  waterBodyFromLabel,
  type ChemChoices,
  type ChemKeyX,
  type ChemReadingsX,
  type DoseRole,
  type DoseStep,
  type TradePack,
  type WaterBody,
} from '@/lib/tradePacks';
import type { LogJobContext } from './ComplianceLogPanel';
import { Pill, SelectField, fmtDateTime, localInputToISO, nowLocalInput } from './shared';

interface Props {
  pack: TradePack;
  ownerId: string;
  job: LogJobContext;
  onChanged?: () => void;
}

type ReadingKey = ChemKeyX | 'temp_f' | 'filter_psi';
type VolumeUnit = 'gal' | 'L';
const ROLES: DoseRole[] = ['chlorine', 'ph_down', 'ph_up', 'ta_up', 'cya_up', 'ch_up', 'salt'];
const TREND_KEYS: Array<{ key: ChemKeyX; decimals: number }> = [
  { key: 'ph', decimals: 1 },
  { key: 'fc', decimals: 1 },
  { key: 'ta', decimals: 0 },
  { key: 'cya', decimals: 0 },
  { key: 'ch', decimals: 0 },
];

const toNum = (s: string): number | undefined => {
  const t = s.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};

const statusTone = (s: string | undefined) =>
  s === 'ok' ? 'success' : s?.startsWith('critical') ? 'danger' : 'warning';
const statusText = (s: string) => (s === 'ok' ? 'in range' : s.replace('critical_', 'critically '));
const severityTone = { info: 'neutral', attention: 'warning', critical: 'danger' } as const;

function Trend({
  label,
  unit,
  values,
  band,
  decimals,
}: {
  label: string;
  unit: string;
  values: number[];
  band: { min: number; max: number };
  decimals: number;
}) {
  const spark = sparkline(values, 160, 44, band);
  const dir = trendDirection(values, 0);
  const last = values[values.length - 1];
  const Icon = dir === 'up' ? TrendingUp : dir === 'down' ? TrendingDown : Minus;
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-text-secondary">{label}</span>
        <span className="flex items-center gap-1 text-sm font-semibold text-text-primary">
          {last.toFixed(decimals)}
          {unit && <span className="text-xs font-normal text-text-secondary">{unit}</span>}
          {dir && (
            <Icon
              size={14}
              className="text-text-secondary"
              aria-label={dir === 'up' ? 'rising' : dir === 'down' ? 'falling' : 'steady'}
            />
          )}
        </span>
      </div>
      {values.length < 2 ? (
        <p className="mt-2 text-xs text-text-secondary">Trend appears after two readings.</p>
      ) : (
        <svg
          viewBox="0 0 160 44"
          className="mt-1 h-11 w-full"
          role="img"
          aria-label={`${label} over the last ${values.length} readings, now ${last.toFixed(decimals)}`}
        >
          {spark.band && (
            <rect
              x="0"
              y={spark.band.y1}
              width="160"
              height={Math.max(1, spark.band.y2 - spark.band.y1)}
              className="fill-success/10"
            />
          )}
          <path
            d={spark.path}
            className="stroke-accent"
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {spark.last && (
            <circle cx={spark.last.x} cy={spark.last.y} r="3" className="fill-accent" />
          )}
        </svg>
      )}
    </div>
  );
}

export function PoolChemistryPanel({ pack, ownerId, job, onChanged }: Props) {
  const { toast } = useToast();
  const logType = getLogType(pack, 'chemistry_reading');

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [history, setHistory] = useState<TradeLogEntry[]>([]);
  const [doses, setDoses] = useState<TradeLogEntry[]>([]);
  const [products, setProducts] = useState<RegulatedProduct[]>([]);
  const [team, setTeam] = useState<TeamOption[]>([]);

  const [body, setBody] = useState<WaterBody>('pool');
  const [sanitizer, setSanitizer] = useState<string>('Liquid chlorine');
  const [volume, setVolume] = useState('');
  const [volumeUnit, setVolumeUnit] = useState<VolumeUnit>('gal');
  const [fields, setFields] = useState<Partial<Record<ReadingKey, string>>>({});
  const [clarity, setClarity] = useState('');
  const [technicianId, setTechnicianId] = useState(job.assigned_technician_id ?? '');
  const [performedAt, setPerformedAt] = useState(nowLocalInput());
  const [notes, setNotes] = useState('');
  const [prodSel, setProdSel] = useState<Partial<Record<DoseRole, string>>>({});

  const [saving, setSaving] = useState<string | null>(null);
  const [savedSig, setSavedSig] = useState<string | null>(null);
  const [logged, setLogged] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<string[]>([]);
  const [trendKey, setTrendKey] = useState<ChemKeyX>('ph');
  const defaultsApplied = useRef(false);

  const load = useCallback(async () => {
    try {
      const [hist, dos, prods, tm] = await Promise.all([
        fetchLogEntries(ownerId, {
          packKey: pack.key,
          entryType: 'chemistry_reading',
          ...(job.customer_id ? { customerId: job.customer_id } : { jobId: job.id }),
          limit: 40,
        }),
        fetchLogEntries(ownerId, {
          packKey: pack.key,
          entryType: 'dosing',
          jobId: job.id,
          limit: 100,
        }),
        fetchProducts(ownerId, pack.key),
        fetchTeam(ownerId),
      ]);
      setHistory(hist);
      setDoses(dos);
      setProducts(prods);
      setTeam(tm);
      setLoadError(null);
      if (!defaultsApplied.current) {
        defaultsApplied.current = true;
        const d = defaultsFromHistory(hist);
        if (d.body) setBody(d.body);
        if (d.volumeGal) setVolume(String(d.volumeGal));
        if (d.sanitizer && (SANITIZER_OPTIONS as readonly string[]).includes(d.sanitizer))
          setSanitizer(d.sanitizer);
      }
    } catch (err) {
      setLoadError(friendlyTradePackError(err, 'Could not load water chemistry records.'));
    } finally {
      setLoading(false);
    }
  }, [ownerId, pack.key, job.id, job.customer_id]);

  useEffect(() => {
    void load();
  }, [load]);

  const family = sanitizerFamily(sanitizer);
  const ranges = rangesFor(body);

  const readings = useMemo(() => {
    const out: Partial<Record<ReadingKey, number>> = {};
    (Object.keys(fields) as ReadingKey[]).forEach((k) => {
      const n = toNum(fields[k] ?? '');
      if (n !== undefined) out[k] = n;
    });
    return out;
  }, [fields]);

  const volumeNum = toNum(volume);
  const volumeGal =
    volumeNum === undefined ? null : volumeUnit === 'L' ? volumeNum / L_PER_GAL : volumeNum;
  const hasReadings = READING_KEYS.some((k) => readings[k] !== undefined) || !!clarity;
  const evaluation = useMemo(
    () => evaluateWater(readings as ChemReadingsX, body, family),
    [readings, body, family],
  );

  const choices = useMemo(() => {
    const c: ChemChoices = {};
    for (const role of ROLES) {
      const opts = productsForRole(role, products);
      const sel = opts.find((o) => o.product.id === prodSel[role]) ?? opts[0];
      if (sel) c[role] = sel.choice;
    }
    return c;
  }, [products, prodSel]);

  const steps = useMemo(
    () =>
      hasReadings
        ? recommendDosing(
            {
              readings: readings as ChemReadingsX,
              body,
              sanitizer: family,
              volumeGal,
              clarity: clarity || null,
            },
            choices,
          )
        : [],
    [hasReadings, readings, body, family, volumeGal, clarity, choices],
  );

  const signature = JSON.stringify([
    body,
    sanitizer,
    volume,
    volumeUnit,
    fields,
    clarity,
    performedAt,
  ]);
  const alreadySaved = savedSig === signature;

  const setField = (k: ReadingKey, v: string) => setFields((s) => ({ ...s, [k]: v }));

  const saveReading = async () => {
    if (!logType) return;
    const data = readingEntryData({
      body,
      sanitizer,
      volumeGal: volumeGal === null ? null : volumeGal,
      readings,
      clarity: clarity || null,
    });
    const problems = validateLogData(logType, cleanLogData(data));
    if (!technicianId) problems.push('Choose the technician');
    setErrors(problems);
    if (problems.length) return;
    setSaving('reading');
    try {
      await addLogEntry(ownerId, {
        packKey: pack.key,
        entryType: 'chemistry_reading',
        jobId: job.id,
        technicianId,
        performedAt: localInputToISO(performedAt),
        data,
        notes,
      });
      toast('Water chemistry recorded.', 'success');
      setSavedSig(signature);
      await load();
      onChanged?.();
    } catch (err) {
      setErrors([friendlyTradePackError(err, 'Could not save the reading.')]);
    } finally {
      setSaving(null);
    }
  };

  const logDose = async (step: DoseStep, product: RegulatedProduct) => {
    if (!technicianId) {
      setErrors(['Choose the technician before logging a dose.']);
      return;
    }
    const data = dosingEntryData(step, product);
    if (!data) {
      setErrors([
        `${product.name} is logged in a unit that cannot hold this dose. Change its unit in Products.`,
      ]);
      return;
    }
    setSaving(step.id);
    setErrors([]);
    try {
      await addLogEntry(ownerId, {
        packKey: pack.key,
        entryType: 'dosing',
        jobId: job.id,
        technicianId,
        productId: product.id,
        performedAt: new Date().toISOString(),
        data,
        notes: `Recommended: ${step.title}`,
      });
      setLogged((s) => new Set(s).add(step.id));
      toast('Dose recorded.', 'success');
      await load();
      onChanged?.();
    } catch (err) {
      setErrors([friendlyTradePackError(err, 'Could not record the dose.')]);
    } finally {
      setSaving(null);
    }
  };

  const reset = () => {
    setFields({});
    setClarity('');
    setNotes('');
    setErrors([]);
    setSavedSig(null);
    setLogged(new Set());
    setPerformedAt(nowLocalInput());
  };

  if (loading) return <Skeleton className="h-48 w-full rounded-2xl" />;

  if (loadError) {
    return (
      <Card className="space-y-3 p-5" role="alert">
        <p className="flex items-center gap-2 text-sm font-medium text-danger">
          <AlertTriangle size={16} /> {loadError}
        </p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setLoading(true);
            void load();
          }}
        >
          <RefreshCw size={14} /> Try again
        </Button>
      </Card>
    );
  }

  const past = readingHistory(history);
  const recent = [...past].reverse().slice(0, 6);
  const trend = TREND_KEYS.map((t) => ({
    ...t,
    values: seriesFor(history, t.key)
      .slice(-12)
      .map((p) => p.value),
  })).filter((t) => t.values.length > 0);
  const activeTrend = trend.find((t) => t.key === trendKey) ?? trend[0];
  const technicianOptions = team.length > 0;
  const heat = evaluation.heatAlert;

  return (
    <section className="space-y-4" aria-label="Water chemistry">
      <Card className="space-y-5 p-4 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <Waves size={18} />
          </span>
          <div>
            <h3 className="text-base font-semibold text-text-primary">
              Water chemistry &amp; dosing
            </h3>
            <p className="text-sm text-text-secondary">
              Enter this visit’s test results. Ranges and doses update as you type; nothing is saved
              until you tap Save.
            </p>
          </div>
        </div>

        {/* Water body + profile */}
        <div className="grid gap-3 sm:grid-cols-3">
          <fieldset>
            <legend className="mb-1.5 block text-sm font-medium text-text-primary">
              Water body
            </legend>
            <div className="grid grid-cols-2 gap-2">
              {(['pool', 'spa'] as WaterBody[]).map((b) => (
                <button
                  key={b}
                  type="button"
                  aria-pressed={body === b}
                  onClick={() => setBody(b)}
                  className={`focus-ring min-h-[48px] rounded-xl border px-3 text-sm font-medium transition-colors ${body === b ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:border-accent/40'}`}
                >
                  {WATER_BODY_LABELS[b]}
                </button>
              ))}
            </div>
          </fieldset>
          <SelectField label="Sanitizer system" value={sanitizer} onChange={setSanitizer}>
            {SANITIZER_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </SelectField>
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Input
                label="Water volume"
                type="number"
                inputMode="decimal"
                step="any"
                min="0"
                placeholder={body === 'spa' ? '400' : '15000'}
                value={volume}
                onChange={(e) => setVolume(e.target.value)}
              />
            </div>
            <div className="w-24 shrink-0">
              <SelectField
                label="Unit"
                value={volumeUnit}
                onChange={(v) => setVolumeUnit(v as VolumeUnit)}
              >
                <option value="gal">US gal</option>
                <option value="L">litres</option>
              </SelectField>
            </div>
          </div>
        </div>

        {/* Readings */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(
            [
              ['fc', 'Free chlorine (ppm)', family !== 'bromine'],
              ['tc', 'Total chlorine (ppm)', family !== 'bromine'],
              ['br', 'Bromine (ppm)', family === 'bromine' || body === 'spa'],
              ['ph', 'pH', true],
              ['ta', 'Alkalinity (ppm)', true],
              ['cya', 'Stabilizer / CYA (ppm)', true],
              ['ch', 'Calcium hardness (ppm)', true],
              ['salt', 'Salt (ppm)', family === 'salt'],
              ['temp_f', 'Water temp (°F)', true],
              ['filter_psi', 'Filter pressure (psi)', body === 'pool'],
            ] as Array<[ReadingKey, string, boolean]>
          )
            .filter(([, , show]) => show)
            .map(([k, label]) => {
              const range = k in ranges ? ranges[k as ChemKeyX] : null;
              const num = readings[k];
              const status =
                range && num !== undefined ? statusFor(k as ChemKeyX, num, body) : undefined;
              return (
                <div key={k}>
                  <Input
                    label={label}
                    type="number"
                    inputMode="decimal"
                    step="any"
                    value={fields[k] ?? ''}
                    onChange={(e) => setField(k, e.target.value)}
                    helperText={
                      range
                        ? `Target ${range.min}–${range.max}`
                        : k === 'temp_f' && body === 'spa'
                          ? 'Max 104 °F'
                          : undefined
                    }
                    error={
                      status && status !== 'ok'
                        ? statusText(status).replace(/^./, (c) => c.toUpperCase())
                        : undefined
                    }
                  />
                </div>
              );
            })}
          <SelectField label="Water clarity" value={clarity} onChange={setClarity}>
            <option value="">—</option>
            {(logType?.fields.find((f) => f.key === 'clarity')?.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </SelectField>
        </div>

        {/* Live evaluation */}
        {hasReadings && (
          <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-2">
            {(Object.keys(evaluation.statuses) as ChemKeyX[]).map((k) => (
              <Pill key={k} tone={statusTone(evaluation.statuses[k])}>
                {ranges[k].label}: {statusText(evaluation.statuses[k] as string)}
              </Pill>
            ))}
            {evaluation.combinedChlorine !== null && evaluation.combinedChlorine > 0.4 && (
              <Pill tone="warning">Combined chlorine {evaluation.combinedChlorine} ppm</Pill>
            )}
            {evaluation.lsi !== null && (
              <Pill tone={evaluation.saturation === 'balanced' ? 'success' : 'warning'}>
                LSI {evaluation.lsi} · {evaluation.saturation}
              </Pill>
            )}
            {heat && <Pill tone="danger">Above 104 °F</Pill>}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          {technicianOptions ? (
            <SelectField
              label="Technician"
              required
              value={technicianId}
              onChange={setTechnicianId}
            >
              <option value="">Select…</option>
              {team.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.member_name ?? 'Unnamed'}
                </option>
              ))}
            </SelectField>
          ) : (
            <p className="text-sm text-text-secondary sm:col-span-1">
              No active team members found — add a technician first.
            </p>
          )}
          <Input
            label="When"
            type="datetime-local"
            value={performedAt}
            max={nowLocalInput()}
            onChange={(e) => setPerformedAt(e.target.value)}
          />
          <div className="sm:col-span-3">
            <Textarea
              label="Notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        {errors.length > 0 && (
          <ul className="space-y-1 text-sm text-danger" role="alert">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="ghost"
            onClick={reset}
            disabled={saving !== null || (!hasReadings && !notes)}
            className="w-full sm:w-auto"
          >
            New test
          </Button>
          <Button
            onClick={saveReading}
            disabled={saving !== null || !hasReadings || alreadySaved}
            className="w-full sm:w-auto"
          >
            {saving === 'reading' && <Loader2 size={16} className="animate-spin" />}
            {alreadySaved ? 'Saved' : 'Save reading'}
          </Button>
        </div>
      </Card>

      {/* Recommendations */}
      <Card className="space-y-4 p-4 sm:p-6">
        <div className="flex items-center gap-2">
          <FlaskConical size={18} className="text-accent" />
          <h3 className="text-base font-semibold text-text-primary">Dosing recommendations</h3>
        </div>

        {!hasReadings ? (
          <p className="text-sm text-text-secondary">
            Enter at least one reading to see what to add, in what order and how much.
          </p>
        ) : steps.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-success">
            <CheckCircle2 size={16} /> Everything you entered is in range — no chemicals needed.
          </p>
        ) : (
          <ol className="space-y-3">
            {steps.map((s) => {
              const opts = s.role ? productsForRole(s.role, products) : [];
              const chosen =
                opts.find((o) => o.product.id === prodSel[s.role as DoseRole]) ?? opts[0];
              const product = chosen?.product;
              const logUnitAmount = product ? doseForProduct(s, product) : null;
              const done = logged.has(s.id);
              const chem = s.choice ? CHEMICALS[s.choice.chem] : null;
              return (
                <li
                  key={s.id}
                  className="rounded-xl border border-border bg-bg-primary p-4 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {s.order > 0 && (
                      <span
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-bold text-white"
                        aria-label={`Step ${s.order}`}
                      >
                        {s.order}
                      </span>
                    )}
                    <span className="font-semibold text-text-primary">{s.title}</span>
                    <Pill tone={severityTone[s.severity]}>
                      {s.severity === 'info'
                        ? 'Note'
                        : s.severity === 'critical'
                          ? 'Urgent'
                          : 'Action'}
                    </Pill>
                    {s.partial && <Pill tone="warning">Split dose</Pill>}
                  </div>

                  {s.amount !== null && s.baseUnit && s.choice && chem && (
                    <p className="mt-2 text-text-primary">
                      Add{' '}
                      <span className="font-semibold">{describeDose(s.amount, s.baseUnit)}</span> of{' '}
                      {chem.label.toLowerCase()} ({s.choice.strengthPct}%)
                      {s.assumed && (
                        <span className="block text-xs text-text-secondary">
                          Assumes standard strength. Register your product with its strength (Trade
                          Packs → Products) for exact amounts.
                        </span>
                      )}
                    </p>
                  )}
                  {s.drainPercent !== null && s.kind === 'dilute' && (
                    <p className="mt-2 font-semibold text-text-primary">
                      Drain and refill about {s.drainPercent}% of the volume.
                    </p>
                  )}

                  <p className="mt-1 text-text-secondary">{s.detail}</p>
                  {s.notes.length > 0 && (
                    <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-text-secondary">
                      {s.notes.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  )}
                  {s.expectedPh !== null && (
                    <p className="mt-1 text-xs text-text-secondary">
                      Expected pH right after: about {s.expectedPh}.
                    </p>
                  )}
                  {s.retestHours !== null && (
                    <p className="mt-1 text-xs text-text-secondary">
                      Re-test after about {s.retestHours} h of circulation.
                    </p>
                  )}

                  {s.amount !== null && s.role && (
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
                      {opts.length > 1 && (
                        <div className="sm:w-64">
                          <SelectField
                            label="Product"
                            value={product?.id ?? ''}
                            onChange={(v) => setProdSel((p) => ({ ...p, [s.role as DoseRole]: v }))}
                          >
                            {opts.map((o) => (
                              <option key={o.product.id} value={o.product.id}>
                                {o.product.name}
                              </option>
                            ))}
                          </SelectField>
                        </div>
                      )}
                      {product ? (
                        done ? (
                          <Pill tone="success">
                            <CheckCircle2 size={12} /> Logged
                          </Pill>
                        ) : logUnitAmount === null ? (
                          <p className="text-xs text-warning">
                            {product.name} is logged in a unit that cannot hold this dose — change
                            its unit in Products.
                          </p>
                        ) : (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={saving !== null}
                            onClick={() => logDose(s, product)}
                            className="w-full sm:w-auto"
                          >
                            {saving === s.id && <Loader2 size={14} className="animate-spin" />}
                            Log {logUnitAmount} {product.unit.replace('_', ' ')} of {product.name}
                          </Button>
                        )
                      ) : (
                        <p className="text-xs text-text-secondary">
                          To log this dose, add a matching product under{' '}
                          <Link to="/dashboard/trade-packs" className="text-accent hover:underline">
                            Trade Packs → Products
                          </Link>{' '}
                          and pick its chemical.
                        </p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        <details className="rounded-xl border border-border/70 p-3 text-sm">
          <summary className="focus-ring flex cursor-pointer items-center gap-2 rounded font-medium text-text-primary">
            <ShieldAlert size={16} /> Safety reminders
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-text-secondary">
            {SAFETY_NOTES.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      </Card>

      {/* Doses logged on this job */}
      {doses.length > 0 && (
        <Card className="space-y-2 p-4 sm:p-6">
          <h3 className="text-base font-semibold text-text-primary">Doses logged on this job</h3>
          <ul className="divide-y divide-border text-sm">
            {doses.map((d) => (
              <li
                key={d.id}
                className={`flex flex-wrap items-center justify-between gap-2 py-2 ${d.voided_at ? 'opacity-60 line-through' : ''}`}
              >
                <span className="text-text-primary">
                  {d.product_name ?? 'Product'} — {String(d.data.amount)}{' '}
                  {String(d.data.amount_unit).replace('_', ' ')} · {String(d.data.target)}
                </span>
                <span className="text-xs text-text-secondary">
                  {fmtDateTime(d.performed_at)}
                  {d.data.from_recommendation === true ? ' · from recommendation' : ''}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* History + trends */}
      <Card className="space-y-4 p-4 sm:p-6">
        <h3 className="text-base font-semibold text-text-primary">
          Reading history{job.customer_id ? ' for this customer' : ''}
        </h3>
        {recent.length === 0 ? (
          <p className="text-sm text-text-secondary">
            No readings yet. Once you save one, trends for pH, chlorine, alkalinity, stabilizer and
            hardness appear here.
          </p>
        ) : (
          <>
            {activeTrend && (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2" role="group" aria-label="Trend parameter">
                  {trend.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      aria-pressed={activeTrend.key === t.key}
                      onClick={() => setTrendKey(t.key)}
                      className={`focus-ring rounded-full border px-3 py-1 text-xs font-medium transition-colors ${activeTrend.key === t.key ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:border-accent/40'}`}
                    >
                      {ranges[t.key].label}
                    </button>
                  ))}
                </div>
                <Trend
                  label={ranges[activeTrend.key].label}
                  unit={ranges[activeTrend.key].unit}
                  values={activeTrend.values}
                  band={ranges[activeTrend.key]}
                  decimals={activeTrend.decimals}
                />
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[30rem] text-left text-sm">
                <thead className="text-xs text-text-secondary">
                  <tr>
                    <th className="py-1 pr-3 font-medium">When</th>
                    <th className="px-2 py-1 font-medium">FC</th>
                    <th className="px-2 py-1 font-medium">pH</th>
                    <th className="px-2 py-1 font-medium">TA</th>
                    <th className="px-2 py-1 font-medium">CYA</th>
                    <th className="px-2 py-1 font-medium">CH</th>
                    <th className="px-2 py-1 font-medium">Clarity</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {recent.map((e) => {
                    const b = waterBodyFromLabel(e.data.water_body) ?? 'pool';
                    const cell = (k: ChemKeyX) => {
                      const v = e.data[k];
                      if (typeof v !== 'number')
                        return <span className="text-text-secondary">—</span>;
                      const s = statusFor(k, v, b);
                      return (
                        <span
                          className={
                            s === 'ok'
                              ? 'text-text-primary'
                              : s.startsWith('critical')
                                ? 'font-semibold text-danger'
                                : 'text-warning'
                          }
                        >
                          {v}
                        </span>
                      );
                    };
                    return (
                      <tr key={e.id}>
                        <td className="py-1.5 pr-3 text-text-secondary">
                          {fmtDateTime(e.performed_at)}
                        </td>
                        <td className="px-2 py-1.5">{cell('fc')}</td>
                        <td className="px-2 py-1.5">{cell('ph')}</td>
                        <td className="px-2 py-1.5">{cell('ta')}</td>
                        <td className="px-2 py-1.5">{cell('cya')}</td>
                        <td className="px-2 py-1.5">{cell('ch')}</td>
                        <td className="px-2 py-1.5 text-text-secondary">
                          {typeof e.data.clarity === 'string' ? e.data.clarity : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </section>
  );
}
